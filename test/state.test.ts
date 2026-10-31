/**
 * T3-04 持久化与对账测试（bun:test）。
 *
 * 裁定依据（progress.md Task 17 派发记录）：
 * - R-st1 持久化：saveGoal 原子写（atomicWriteFile）；loadGoals 容错——损坏
 *   JSON → 该目标标记 blocked 落盘 + 审计（不崩守护），加载器返回有效目标 +
 *   blocked 诊断列表（任务书简化签名按裁定改为 LoadedGoals）。
 * - R-st2 审计：appendAudit 追加写 audit/<goalId>.jsonl，单文件串行锁防交错；
 *   auditId 形如 <goalId>-<seq>。
 * - R-st3 对账幂等（Review-Focus-4）：连续两次 reconcile 同目标 → 第二次不
 *   注入（injected 指纹去重）；会话死 → 重建+断点契约；重建失败 → blocked+fatal。
 * - R-st4 对账重锚：会话在场但 injected 空 → 重发契约；有指纹 → 不重发。
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { loadConfig, type BridgeConfig } from "../src/core/config";
import { createDaemon } from "../src/daemon";
import { BridgeError } from "../src/core/errors";
import { buildContract, buildResumeContract } from "../src/core/goal/protocol";
import type { GoalState } from "../src/core/goal/runner";
import {
  appendAudit,
  loadGoals,
  reconcile,
  saveGoal,
} from "../src/core/goal/state";
import { FakeTransport } from "../src/core/transport/fake";
import type { CodeartsTransport, SessionRef } from "../src/core/transport/types";

/* ───── 测试台架：插件 .tmp 专属目录 + FakeTransport ───── */

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
const TEST_ROOT = path.join(PLUGIN_ROOT, ".tmp", "state-test");

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

/** 每用例独立状态根（互不串扰）。 */
function freshDir(name: string): string {
  return path.join(TEST_ROOT, name);
}

const EMPTY_CFG = {} as BridgeConfig;

/** 构造一个可落盘的合法 active 目标状态。 */
function makeState(goalId: string, over: Partial<GoalState> = {}): GoalState {
  return {
    goalId,
    objective: `目标 ${goalId}`,
    verify: [],
    phase: "active",
    rounds: 0,
    steps: [],
    strikes: 0,
    injected: [],
    lastProgressAt: 1_000,
    ...over,
  };
}

/** goals/ 目录路径（被测实现的布局契约：<stateDir>/goals/<goalId>.json）。 */
function goalsDir(stateDir: string): string {
  return path.join(stateDir, "goals");
}

/** audit/ 目录路径（<stateDir>/audit/<goalId>.jsonl）。 */
function auditPath(stateDir: string, goalId: string): string {
  return path.join(stateDir, "audit", `${goalId}.jsonl`);
}

/** 读审计文件为逐行 JSON 数组（空/缺失 → []）。 */
async function readAudit(stateDir: string, goalId: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(auditPath(stateDir, goalId), "utf8").catch(() => "");
  if (raw === "") return [];
  return raw
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** start 抛错的传输替身（重建失败路径专用；其余方法显式报错不被测试依赖）。 */
class FailingStartTransport implements CodeartsTransport {
  readonly kind = "pty" as const;
  async start(): Promise<SessionRef> {
    throw new BridgeError("SESSION_START_FAILED", "模拟重建失败");
  }
  async alive(): Promise<boolean> {
    return false;
  }
  async inject(): Promise<void> {
    throw new BridgeError("SESSION_NOT_ALIVE", "未预期调用");
  }
  observe(): AsyncIterable<never> {
    throw new BridgeError("SESSION_UNKNOWN", "未预期调用");
  }
  async stop(): Promise<void> {
    return;
  }
  async snapshot(): Promise<{ raw: string; meta: Record<string, unknown> }> {
    throw new BridgeError("SESSION_UNKNOWN", "未预期调用");
  }
}

/* ───── saveGoal / loadGoals：原子持久化（R-st1） ───── */

describe("saveGoal/loadGoals 原子持久化", () => {
  it("往返一致：多目标含可选字段（session/auditId/injected）逐字段还原", async () => {
    const dir = freshDir("roundtrip");
    const ref: SessionRef = { kind: "pty", id: "fake-1" };
    const a = makeState("g-a", { session: ref, auditId: "g-a-3", injected: ["契约文本"], steps: [1, 2], rounds: 3 });
    const b = makeState("g-b", { phase: "complete", steps: [1] });
    await saveGoal(dir, a);
    await saveGoal(dir, b);
    const loaded = await loadGoals(dir);
    expect(loaded.corrupted).toEqual([]);
    expect(loaded.goals.length).toBe(2);
    const la = loaded.goals.find((g) => g.goalId === "g-a");
    const lb = loaded.goals.find((g) => g.goalId === "g-b");
    expect(la).toEqual(a);
    expect(lb).toEqual(b);
  });

  it("goals 目录缺失（首启）→ 空态 {goals:[],corrupted:[]}，不报错", async () => {
    const dir = freshDir("fresh-install");
    const loaded = await loadGoals(dir);
    expect(loaded.goals).toEqual([]);
    expect(loaded.corrupted).toEqual([]);
  });

  it("损坏 JSON → 该目标标 blocked 落盘 + fatal 审计 + corrupted 诊断；有效目标不受累；复载不再报损坏", async () => {
    const dir = freshDir("corrupt-json");
    await saveGoal(dir, makeState("g-ok"));
    await mkdir(goalsDir(dir), { recursive: true });
    await writeFile(path.join(goalsDir(dir), "g-bad.json"), "{oops 不是 JSON", "utf8");

    const first = await loadGoals(dir);
    // 有效目标完好
    expect(first.goals.map((g) => g.goalId)).toEqual(["g-ok"]);
    // 诊断列表含损坏目标（goalId 从文件名提取）
    expect(first.corrupted.length).toBe(1);
    const diag = first.corrupted[0]!;
    expect(diag.goalId).toBe("g-bad");
    expect(diag.reason.length).toBeGreaterThan(0);
    expect(diag.auditId).toBe("g-bad-1");
    // 该目标已就地标记 blocked 落盘（复载稳定，不重复报损坏）
    const reread = await loadGoals(dir);
    expect(reread.corrupted).toEqual([]);
    const blockedState = reread.goals.find((g) => g.goalId === "g-bad");
    expect(blockedState?.phase).toBe("blocked");
    expect(blockedState?.auditId).toBe("g-bad-1");
    // 审计留痕：fatal 错误事件含原因
    const audit = await readAudit(dir, "g-bad");
    expect(audit.length).toBe(1);
    expect(audit[0]!.type).toBe("goal.error");
    expect(audit[0]!.kind).toBe("state-corrupt");
    expect(audit[0]!.fatal).toBe(true);
    expect(String(audit[0]!.reason)).toContain("g-bad");
  });

  it("JSON 合法但结构非法（字段缺失/错型）→ 同损坏路径处理（blocked+审计+诊断）", async () => {
    const dir = freshDir("corrupt-shape");
    await mkdir(goalsDir(dir), { recursive: true });
    await writeFile(path.join(goalsDir(dir), "g-shape.json"), JSON.stringify({ goalId: "g-shape" }), "utf8");
    const loaded = await loadGoals(dir);
    expect(loaded.goals).toEqual([]);
    expect(loaded.corrupted.map((c) => c.goalId)).toEqual(["g-shape"]);
    const reread = await loadGoals(dir);
    expect(reread.corrupted).toEqual([]);
    expect(reread.goals.find((g) => g.goalId === "g-shape")?.phase).toBe("blocked");
    const audit = await readAudit(dir, "g-shape");
    expect(audit[0]!.kind).toBe("state-corrupt");
  });

  it("文件名派生 goalId 非法（路径不安全字符）→ 仅诊断不落盘不审计，不崩守护", async () => {
    const dir = freshDir("corrupt-name");
    await mkdir(goalsDir(dir), { recursive: true });
    await writeFile(path.join(goalsDir(dir), "bad id.json"), "垃圾内容", "utf8");
    const loaded = await loadGoals(dir);
    expect(loaded.goals).toEqual([]);
    expect(loaded.corrupted.length).toBe(1);
    expect(loaded.corrupted[0]!.goalId).toBe("bad id");
    expect(loaded.corrupted[0]!.auditId).toBeUndefined(); // 非法 id 无法安全审计
    // 未写入任何状态文件（id 非法禁止构造路径）
    await expect(loadGoals(dir)).resolves.toBeTruthy();
  });

  it("saveGoal 拒绝非法 goalId（路径穿越）与非法状态形状（GOAL_STATE_INVALID）", async () => {
    const dir = freshDir("save-invalid");
    const evil = makeState("../evil");
    const err1: unknown = await saveGoal(dir, evil).then(
      () => null,
      (e) => e,
    );
    expect(err1).toBeInstanceOf(BridgeError);
    expect((err1 as BridgeError).code).toBe("GOAL_ID_INVALID");

    const malformed = { goalId: "g-x", objective: 123 } as unknown as GoalState;
    const err2: unknown = await saveGoal(dir, malformed).then(
      () => null,
      (e) => e,
    );
    expect(err2).toBeInstanceOf(BridgeError);
    expect((err2 as BridgeError).code).toBe("GOAL_STATE_INVALID");
  });
});

/* ───── appendAudit：审计留痕（R-st2） ───── */

describe("appendAudit 追加审计", () => {
  it("auditId 顺序分配（<goalId>-1、-2…）；多目标文件相互隔离", async () => {
    const dir = freshDir("audit-basic");
    expect(await appendAudit(dir, "g1", { type: "goal.start" })).toBe("g1-1");
    expect(await appendAudit(dir, "g1", { type: "goal.inject" })).toBe("g1-2");
    expect(await appendAudit(dir, "g2", { type: "goal.start" })).toBe("g2-1");
    const g1 = await readAudit(dir, "g1");
    const g2 = await readAudit(dir, "g2");
    expect(g1.map((e) => e.auditId)).toEqual(["g1-1", "g1-2"]);
    expect(g1.map((e) => e.type)).toEqual(["goal.start", "goal.inject"]);
    expect(g2.map((e) => e.auditId)).toEqual(["g2-1"]);
  });

  it("并发追加不交错（单文件串行锁）：30 并发全成功、逐行合法 JSON、seq 无重复无空洞", async () => {
    const dir = freshDir("audit-concurrent");
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => appendAudit(dir, "g1", { type: "goal.inject", i })),
    );
    expect(results.length).toBe(30);
    expect(new Set(results).size).toBe(30); // auditId 全局唯一
    const sorted = results.map((id) => Number(id.split("-")[1])).sort((a, b) => a - b);
    expect(sorted).toEqual(Array.from({ length: 30 }, (_, i) => i + 1)); // seq 1..30 无空洞
    // 文件逐行合法 JSON（无交错撕裂）
    const lines = await readAudit(dir, "g1");
    expect(lines.length).toBe(30);
    expect(lines.every((l) => l.type === "goal.inject")).toBe(true);
  });

  it("拒绝非法事件（null/数组）与非法 goalId（显式报错，禁静默）", async () => {
    const dir = freshDir("audit-invalid");
    const err1: unknown = await appendAudit(dir, "g1", null as unknown as object).then(
      () => null,
      (e) => e,
    );
    expect(err1).toBeInstanceOf(BridgeError);
    const err2: unknown = await appendAudit(dir, "g1", [1] as unknown as object).then(
      () => null,
      (e) => e,
    );
    expect(err2).toBeInstanceOf(BridgeError);
    const err3: unknown = await appendAudit(dir, "../evil", { type: "x" }).then(
      () => null,
      (e) => e,
    );
    expect(err3).toBeInstanceOf(BridgeError);
    expect((err3 as BridgeError).code).toBe("GOAL_ID_INVALID");
  });
});

/* ───── reconcile：对账恢复（R-st3 幂等 / R-st4 重锚） ───── */

describe("reconcile 对账恢复", () => {
  it("Review-Focus-4：会话活 + injected 空 → 重锚注入契约恰一次；连续第二次 reconcile 不注入（指纹去重）", async () => {
    const dir = freshDir("reconcile-idempotent");
    const transport = new FakeTransport();
    const ref = await transport.start(EMPTY_CFG);
    await saveGoal(dir, makeState("g1", { session: ref }));

    const r1 = await reconcile(dir, { transport });
    expect(r1.resumed).toEqual(["g1"]);
    expect(r1.blocked).toEqual([]);
    expect(transport.injections.length).toBe(1);
    expect(transport.injections[0]!.text).toBe(buildContract("目标 g1", []));
    // 注入事实落盘：injected 指纹 + rounds 计一轮
    const after1 = (await loadGoals(dir)).goals.find((g) => g.goalId === "g1");
    expect(after1?.injected).toEqual([buildContract("目标 g1", [])]);
    expect(after1?.rounds).toBe(1);

    const r2 = await reconcile(dir, { transport });
    expect(r2.resumed).toEqual(["g1"]);
    expect(transport.injections.length).toBe(1); // 第二次不注入
  });

  it("并发两次 reconcile（互斥序列化）→ 仍只注入一次", async () => {
    const dir = freshDir("reconcile-concurrent");
    const transport = new FakeTransport();
    const ref = await transport.start(EMPTY_CFG);
    await saveGoal(dir, makeState("g1", { session: ref }));
    const [r1, r2] = await Promise.all([reconcile(dir, { transport }), reconcile(dir, { transport })]);
    expect(r1.resumed).toEqual(["g1"]);
    expect(r2.resumed).toEqual(["g1"]);
    expect(transport.injections.length).toBe(1);
  });

  it("会话活 + injected 指纹在场 → 不重发（R-st4 后半）", async () => {
    const dir = freshDir("reconcile-fingerprint");
    const transport = new FakeTransport();
    const ref = await transport.start(EMPTY_CFG);
    await saveGoal(dir, makeState("g1", { session: ref, injected: ["此前已有注入"], rounds: 1 }));
    const r = await reconcile(dir, { transport });
    expect(r.resumed).toEqual(["g1"]);
    expect(transport.injections.length).toBe(0);
  });

  it("会话死（有进度）→ 重建会话（复用旧 ref）+ 断点续跑契约 + injected 重置为该契约", async () => {
    const dir = freshDir("reconcile-dead-progress");
    const transport = new FakeTransport();
    const ref = await transport.start(EMPTY_CFG);
    await saveGoal(dir, makeState("g1", { session: ref, steps: [1, 2] }));
    await transport.stop(ref); // 会话死

    const r = await reconcile(dir, { transport });
    expect(r.resumed).toEqual(["g1"]);
    expect(r.blocked).toEqual([]);
    // 重建注入断点续跑契约（与 buildResumeContract 逐字一致）
    const resumeText = buildResumeContract({ objective: "目标 g1", doneSteps: [1, 2] });
    expect(transport.injections.length).toBe(1);
    expect(transport.injections[0]!.text).toBe(resumeText);
    expect(transport.injections[0]!.ref.id).toBe(ref.id); // 复用旧 ref（传输恢复语义）
    // 状态落盘：session 更新、injected 重置（重建全新会话清旧指纹）、rounds+1、strikes+1（重启计入循环保护）
    const after = (await loadGoals(dir)).goals.find((g) => g.goalId === "g1")!;
    expect(after.session?.id).toBe(ref.id);
    expect(after.injected).toEqual([resumeText]);
    expect(after.rounds).toBe(1);
    expect(after.strikes).toBe(1);
    expect(after.phase).toBe("active");
    // 审计留痕：restart + inject 两事件
    const audit = await readAudit(dir, "g1");
    expect(audit.map((e) => e.type)).toEqual(["goal.restart", "goal.inject"]);
    expect(audit[0]!.reason).toBe("reconcile-session-died");
  });

  it("会话死（无进度）→ 重建 + 全文契约（与 runner.restartLocked 同判据）", async () => {
    const dir = freshDir("reconcile-dead-fresh");
    const transport = new FakeTransport();
    const ref = await transport.start(EMPTY_CFG);
    await saveGoal(dir, makeState("g1", { session: ref }));
    await transport.stop(ref);
    const r = await reconcile(dir, { transport });
    expect(r.resumed).toEqual(["g1"]);
    expect(transport.injections[0]!.text).toBe(buildContract("目标 g1", []));
  });

  it("④③ 跨守护重启（未知 ref）→ alive 布尔契约判死 → 重建路径恢复（守护崩溃循环回归断言）", async () => {
    // 场景复刻演练 B：守护被杀重启后内存会话表为空，磁盘目标的 session ref 必然
    // 未知——修复前 alive() 抛 SESSION_UNKNOWN → reconcile 崩溃 → 守护永久下线。
    const dir = freshDir("reconcile-cross-daemon");
    const transport = new FakeTransport(); // 新进程：从未见过该 ref
    await saveGoal(dir, makeState("g1", { session: { kind: "pty", id: "fake-77" }, steps: [1] }));
    const r = await reconcile(dir, { transport });
    expect(r.resumed).toEqual(["g1"]);
    expect(r.blocked).toEqual([]);
    expect(transport.injections.length).toBe(1);
    expect(transport.injections[0]!.ref.id).toBe("fake-77"); // 复用旧 ref 重建（断点续跑契约）
    expect(transport.injections[0]!.text).toBe(buildResumeContract({ objective: "目标 g1", doneSteps: [1] }));
    const after = (await loadGoals(dir)).goals.find((g) => g.goalId === "g1")!;
    expect(after.phase).toBe("active");
  });

  it("重建失败 → phase=blocked 落盘 + fatal 审计 + blocked 列表", async () => {
    const dir = freshDir("reconcile-rebuild-fail");
    const transport = new FailingStartTransport();
    const ref: SessionRef = { kind: "pty", id: "dead-1" };
    await saveGoal(dir, makeState("g1", { session: ref }));

    const r = await reconcile(dir, { transport });
    expect(r.resumed).toEqual([]);
    expect(r.blocked).toEqual(["g1"]);
    const after = (await loadGoals(dir)).goals.find((g) => g.goalId === "g1")!;
    expect(after.phase).toBe("blocked");
    expect(after.auditId).toBe("g1-1");
    const audit = await readAudit(dir, "g1");
    expect(audit.length).toBe(1);
    expect(audit[0]!.type).toBe("goal.error");
    expect(audit[0]!.kind).toBe("reconcile-rebuild-failed");
    expect(audit[0]!.fatal).toBe(true);
  });

  it("终态与人工态（complete/stopped/paused/blocked）目标不触碰、不入返回列表", async () => {
    const dir = freshDir("reconcile-skip");
    const transport = new FakeTransport();
    const ref = await transport.start(EMPTY_CFG);
    await saveGoal(dir, makeState("g-done", { phase: "complete", session: ref }));
    await saveGoal(dir, makeState("g-stopped", { phase: "stopped", session: ref }));
    await saveGoal(dir, makeState("g-paused", { phase: "paused", session: ref }));
    await saveGoal(dir, makeState("g-blocked", { phase: "blocked", session: ref }));
    const r = await reconcile(dir, { transport });
    expect(r.resumed).toEqual([]);
    expect(r.blocked).toEqual([]);
    expect(transport.injections.length).toBe(0);
  });

  it("损坏目标经 loadGoals 标 blocked → 出现在 reconcile blocked 列表", async () => {
    const dir = freshDir("reconcile-corrupt");
    const transport = new FakeTransport();
    await mkdir(goalsDir(dir), { recursive: true });
    await writeFile(path.join(goalsDir(dir), "g-bad.json"), "坏数据", "utf8");
    const r = await reconcile(dir, { transport });
    expect(r.blocked).toEqual(["g-bad"]);
    expect(r.resumed).toEqual([]);
  });

  it("无会话的 active 目标跳过（首 tick 自举，不入列表）", async () => {
    const dir = freshDir("reconcile-no-session");
    const transport = new FakeTransport();
    await saveGoal(dir, makeState("g1"));
    const r = await reconcile(dir, { transport });
    expect(r.resumed).toEqual([]);
    expect(r.blocked).toEqual([]);
    expect(transport.injections.length).toBe(0);
  });
});

/* ───── daemon 启动对账钩子（T3-04 守护接入缝，T3-05 注入真实传输） ───── */

describe("daemon 启动对账钩子", () => {
  it("start 时以 cfg.stateDir 调用 reconcileOnStart 恰一次（监听建立前）", async () => {
    const stateDir = freshDir("daemon-hook");
    const cfg = loadConfig({ stateDir, daemonUrl: "http://127.0.0.1:0" }, {});
    const calls: string[] = [];
    const d = createDaemon(cfg, {
      reconcileOnStart: async (sd) => {
        calls.push(sd);
        return { resumed: ["g1"], blocked: [] };
      },
    });
    await d.start();
    expect(calls).toEqual([stateDir]);
    await d.stop();
  });

  it("钩子抛错 → start 显式拒绝（禁静默带病服务）", async () => {
    const stateDir = freshDir("daemon-hook-fail");
    const cfg = loadConfig({ stateDir, daemonUrl: "http://127.0.0.1:0" }, {});
    const d = createDaemon(cfg, {
      reconcileOnStart: async () => {
        throw new BridgeError("RECONCILE_FAILED", "对账爆炸");
      },
    });
    const err: unknown = await d.start().then(
      () => null,
      (e) => e,
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).message).toContain("对账爆炸");
    await d.stop(); // 未监听态 stop 幂等
  });

  it("未注入钩子 → 启动不做对账（T3-05 前的缺省缝，显式无操作）", async () => {
    const stateDir = freshDir("daemon-no-hook");
    const cfg = loadConfig({ stateDir, daemonUrl: "http://127.0.0.1:0" }, {});
    const d = createDaemon(cfg);
    const { port } = await d.start();
    expect(port).toBeGreaterThan(0);
    await d.stop();
  });
});

