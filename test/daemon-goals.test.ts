/**
 * T3-05 守护-目标对接测试（bun:test）——daemon + FakeTransport + 假时钟 + 手动循环。
 *
 * 裁定依据（progress.md Task 18 派发记录）：
 * - R-dg1：POST /goals → 建状态 → 以落盘状态构造 GoalRunner → saveGoal →
 *   tick 循环宿主（生产 setInterval 5s，测试经 TickLoop 手动驱动 sweep）；
 *   启动时以落盘状态 roster + reconcile（对账契约已入 injected 指纹，
 *   tick 重锚不重复注入）。
 * - R-dg2：control pause=相位翻转（此后 sweep 不再注入）；resume=注入继续；
 *   stop=终态；全部即时生效（端点响应前完成 runner 动作 + 审计冲刷）。
 * - R-dg3：logs 分页 cursor 前进、顺序稳定、不重复不遗漏。
 * - R-dg4：并发多目标独立状态隔离（专测）。
 * - R-dg5：① autoNudge 接线 runner（阈值配置经 cfg + 逐目标覆盖）；
 *   ② reconcile 时钟经 ReconcileDeps.clock 注入（M72，假时钟同一条时间线）；
 *   ③ pidfile 固化单守护前提（daemon.pid，陈旧清除/存活显式拒绝）。
 *
 * 纪律：
 * - 绝不触碰真实 HOME：stateDir 一律注入 <插件根>/.tmp/daemon-goals-test/；
 *   端口一律 0（内核随机分配）；env 显传 {} 与真实 process.env 隔离。
 * - runner 保持 R-rn1 纯 tick：本套件经手动 TickLoop 驱动 sweep，不依赖真实定时器。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../src/core/config";
import type { BridgeConfig } from "../src/core/config";
import { createDaemon, type DaemonHandle } from "../src/daemon";
import { GoalHost, type TickLoop } from "../src/daemon-goals";
import { FakeTransport } from "../src/core/transport/fake";
import { saveGoal } from "../src/core/goal/state";
import { BridgeError } from "../src/core/errors";
import type { GoalState } from "../src/core/goal/runner";
import { CONTINUE_PROMPT } from "../src/core/goal/protocol";

/** 插件根目录（test/ 的上一级）。 */
const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
/** 本套件专属临时目录（.tmp/ 已 gitignore）。 */
const TEST_ROOT = path.join(PLUGIN_ROOT, ".tmp", "daemon-goals-test");

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  // 只删本套件专属目录，不动 .tmp/ 根（可能被其他套件并行使用）
  await rm(TEST_ROOT, { recursive: true, force: true });
});

/* ───── 防悬挂兜底登记（测试基础设施，非业务兜底）：每个用例结束统一停守护 ───── */

const openDaemons: DaemonHandle[] = [];

afterEach(async () => {
  while (openDaemons.length > 0) {
    const d = openDaemons.pop() as DaemonHandle;
    await d.stop().catch(() => undefined);
  }
});

/* ───── 测试台架：FakeTransport + 假时钟 + 手动 TickLoop + 守护 ───── */

/** 手动循环句柄（测试驱动 sweep；wake 只计数不驱动——驱动权在用例手里）。 */
interface ManualLoop {
  loop: TickLoop;
  sweepOnce(): Promise<void>;
  wakeCount(): number;
}

function makeManualLoop(): ManualLoop {
  let sweepFn: (() => Promise<void>) | undefined;
  let wakes = 0;
  return {
    loop: {
      start(sweep: () => Promise<void>) {
        sweepFn = sweep;
      },
      wake() {
        wakes += 1;
      },
      stop() {
        sweepFn = undefined;
      },
    },
    sweepOnce: async () => {
      await sweepFn?.();
    },
    wakeCount: () => wakes,
  };
}

interface Harness {
  cfg: BridgeConfig;
  transport: FakeTransport;
  host: GoalHost;
  daemon: DaemonHandle;
  port: number;
  token: string;
  loop: ManualLoop;
  advance(ms: number): void;
  now(): number;
}

/**
 * 组装并启动一套守护台架（goals 宿主接线 FakeTransport + 假时钟 + 手动循环）。
 * opts.autoNudge 注入 cfg.autoNudge（缺省走 loadConfig 默认 true）。
 */
async function makeHarness(
  opts?: {
    autoNudge?: boolean;
    /** 修复环①：verifyRun 记录器注入（缺省恒通过）。 */
    verifyRun?: (cmd: string[], cwd?: string) => Promise<{ ok: boolean; out: string }>;
  },
): Promise<Harness> {
  const name = `h-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const cfg = loadConfig(
    {
      stateDir: path.join(TEST_ROOT, name),
      daemonUrl: "http://127.0.0.1:0",
      ...(opts?.autoNudge !== undefined ? { autoNudge: opts.autoNudge } : {}),
    },
    {},
  );
  const transport = new FakeTransport();
  let t = 1_000_000;
  const clock = { now: () => t };
  const loop = makeManualLoop();
  const host = new GoalHost({
    cfg,
    transport,
    clock,
    loop: loop.loop,
    verifyRun: opts?.verifyRun ?? (async () => ({ ok: true, out: "OK" })),
  });
  const daemon = createDaemon(cfg, undefined, host);
  openDaemons.push(daemon);
  const { port } = await daemon.start();
  return {
    cfg,
    transport,
    host,
    daemon,
    port,
    token: await readFile(path.join(cfg.stateDir, "daemon-token"), "utf8"),
    loop,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

/* ───── HTTP 助手 ───── */

interface HttpResult {
  status: number;
  body: unknown;
}

async function call(
  port: number,
  method: "GET" | "POST",
  pathname: string,
  token: string,
  body?: unknown,
): Promise<HttpResult> {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

function errCode(r: HttpResult): string {
  const b = r.body;
  if (typeof b !== "object" || b === null) return "";
  const e = (b as Record<string, unknown>)["error"];
  if (typeof e !== "object" || e === null) return "";
  return ((e as Record<string, unknown>)["code"] as string | undefined) ?? "";
}

/** control 响应的 state 载荷（形状守卫：缺失给空对象，交由断言暴露）。 */
function stateOf(r: HttpResult): Record<string, unknown> {
  const b = r.body;
  if (typeof b !== "object" || b === null) return {};
  const s = (b as Record<string, unknown>)["state"];
  return (typeof s === "object" && s !== null ? s : {}) as Record<string, unknown>;
}

/** 建目标并完成首轮 sweep（引导：建会话 + 契约注入）。返回 goalId。 */
async function createGoal(h: Harness, body?: Record<string, unknown>): Promise<string> {
  const r = await call(h.port, "POST", "/goals", h.token, body ?? { objective: "实现登录页" });
  expect(r.status).toBe(200);
  const goalId = (r.body as Record<string, string>)["goalId"] ?? "";
  expect(goalId).not.toBe("");
  await h.loop.sweepOnce(); // 引导 tick（建会话 + 注入契约）
  return goalId;
}

/* ───── R-dg1：POST /goals 全流程 ───── */

describe("POST /goals 全流程到 complete（R-dg1）", () => {
  it("start → 步进 → [GOAL-DONE] → verify 双过 → complete，且健康 actives 归零", async () => {
    const h = await makeHarness();
    const goalId = await createGoal(h);
    expect(goalId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
    expect(h.loop.wakeCount()).toBeGreaterThanOrEqual(1); // 创建即事件驱动唤醒

    // 契约已注入 1 次
    expect(h.transport.injections.length).toBe(1);

    // 健康端点 actives=1（在册 active 目标数）
    const health = await fetch(`http://127.0.0.1:${h.port}/health`).then((x) => x.json() as Promise<Record<string, unknown>>);
    expect(health["actives"]).toBe(1);

    // 步进：第 2 步标记出现 → 第 1 步记完成（回显守卫窗口先越过）
    h.advance(4000);
    const ref = h.transport.injections[0]!.ref;
    h.transport.emit(ref, "output", "[GOAL-STEP 2/2] 收尾联调 | 推荐方案: 先回归主链路");
    await h.loop.sweepOnce();

    let st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("active");
    expect(st["steps"]).toEqual([1]);
    expect(st["rounds"]).toBe(1);

    // AI 自报完成 → 双过核验（verifyRun 恒过）→ complete
    h.advance(4000);
    h.transport.emit(ref, "output", "全部步骤完成 [GOAL-DONE]");
    await h.loop.sweepOnce();

    st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("complete");

    // 列表与终态可见性；actives 归零；终态移出循环（再 sweep 不产生注入）
    const list = (await call(h.port, "GET", "/goals", h.token)).body as Array<Record<string, unknown>>;
    const item = list.find((x) => x["goalId"] === goalId) as Record<string, unknown>;
    expect(item["state"]).toBe("complete");
    expect(item["rounds"]).toBe(1);
    expect(typeof item["objective"]).toBe("string");
    const health2 = await fetch(`http://127.0.0.1:${h.port}/health`).then((x) => x.json() as Promise<Record<string, unknown>>);
    expect(health2["actives"]).toBe(0);
    const injectionsBefore = h.transport.injections.length;
    await h.loop.sweepOnce();
    expect(h.transport.injections.length).toBe(injectionsBefore);
  });

  it("POST /goals 未知路由形态（DELETE 语义不存在）→ 404；未知目标 → 404 GOAL_NOT_FOUND", async () => {
    const h = await makeHarness();
    const res = await fetch(`http://127.0.0.1:${h.port}/goals/does-not-exist`, {
      method: "PUT",
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.status).toBe(404);
    const r = await call(h.port, "GET", "/goals/no-such-goal", h.token);
    expect(r.status).toBe(404);
    expect(errCode(r)).toBe("GOAL_NOT_FOUND");
  });
});

/* ───── R-dg2：control 语义 ───── */

describe("control 语义（R-dg2：pause/resume/stop 即时生效）", () => {
  it("pause → phase=paused 且 sweep 不再注入；resume → 注入继续指令；stop → 终态且移出循环", async () => {
    const h = await makeHarness();
    const goalId = await createGoal(h);
    expect(h.transport.injections.length).toBe(1);

    // pause：即时生效 + 落盘 + 审计冲刷后才响应
    let r = await call(h.port, "POST", `/goals/${goalId}/control`, h.token, { action: "pause" });
    expect(r.status).toBe(200);
    expect(stateOf(r)["phase"]).toBe("paused");

    // paused 期间信号与 sweep 都不产生注入
    h.advance(4000);
    const ref = h.transport.injections[0]!.ref;
    h.transport.emit(ref, "output", "[GOAL-STEP 2/2] 任意输出 | 推荐方案: x");
    h.advance(61_000); // 越过停滞阈值：paused 也不允许 nudge
    await h.loop.sweepOnce();
    expect(h.transport.injections.length).toBe(1);

    // resume：注入继续指令（含 CONTINUE_PROMPT 语义）
    r = await call(h.port, "POST", `/goals/${goalId}/control`, h.token, { action: "resume" });
    expect(r.status).toBe(200);
    expect(stateOf(r)["phase"]).toBe("active");
    expect(h.transport.injections.length).toBe(2);
    expect(h.transport.injections[1]!.text).toContain(CONTINUE_PROMPT);

    // stop：终态；后续 sweep 不再驱动
    r = await call(h.port, "POST", `/goals/${goalId}/control`, h.token, { action: "stop" });
    expect(r.status).toBe(200);
    expect(stateOf(r)["phase"]).toBe("stopped");
    await h.loop.sweepOnce();
    expect(h.transport.injections.length).toBe(2);
    // 终态目标仍可查询（读磁盘）
    const st = await call(h.port, "GET", `/goals/${goalId}`, h.token);
    expect(st.status).toBe(200);
    expect(((st.body as Record<string, unknown>)["phase"] as string)).toBe("stopped");
  });

  it("非法 action → 400 GOAL_ACTION_INVALID；未知目标 control → 404；终态 control → 409", async () => {
    const h = await makeHarness();
    const bad = await call(h.port, "POST", "/goals/x/control", h.token, { action: "reboot" });
    expect(bad.status).toBe(400);
    expect(errCode(bad)).toBe("GOAL_ACTION_INVALID");

    const goalId = await createGoal(h);
    await call(h.port, "POST", `/goals/${goalId}/control`, h.token, { action: "stop" });
    const onTerminal = await call(h.port, "POST", `/goals/${goalId}/control`, h.token, { action: "pause" });
    expect(onTerminal.status).toBe(409);
    expect(errCode(onTerminal)).toBe("GOAL_TERMINAL_STATE");

    const missing = await call(h.port, "POST", "/goals/no-such/control", h.token, { action: "pause" });
    expect(missing.status).toBe(404);
    expect(errCode(missing)).toBe("GOAL_NOT_FOUND");
  });

  it("blocked 目标：pause 显式拒绝（409）；resume 归一恢复并注入继续", async () => {
    const h = await makeHarness();
    // 直接触发 blocked：error 信号 + refusal 分类（runner fatal 路径）
    const goalId = await createGoal(h);
    h.advance(4000);
    const ref = h.transport.injections[0]!.ref;
    h.transport.emit(ref, "error", "content policy refused");
    await h.loop.sweepOnce();
    let st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("blocked");

    const pause = await call(h.port, "POST", `/goals/${goalId}/control`, h.token, { action: "pause" });
    expect(pause.status).toBe(409);
    expect(errCode(pause)).toBe("GOAL_PHASE_INVALID");

    // resume：blocked → active + 注入继续（R-dg2 语义）
    const resume = await call(h.port, "POST", `/goals/${goalId}/control`, h.token, { action: "resume" });
    expect(resume.status).toBe(200);
    expect(stateOf(resume)["phase"]).toBe("active");
    expect(h.transport.injections.length).toBe(2);
    expect(h.transport.injections[1]!.text).toContain(CONTINUE_PROMPT);
  });
});

/* ───── R-dg3：logs 分页 ───── */

describe("GET /goals/:id/logs 分页（R-dg3：cursor 前进、顺序稳定）", () => {
  it("cursor 步进遍历：不重复、不遗漏、seq 单调递增，空 cursor 从头开始", async () => {
    const h = await makeHarness();
    const goalId = await createGoal(h);
    await call(h.port, "POST", `/goals/${goalId}/control`, h.token, { action: "pause" });
    await call(h.port, "POST", `/goals/${goalId}/control`, h.token, { action: "resume" });
    // 此刻审计流：goal.start, goal.inject, goal.pause, goal.resume, goal.inject ≥5 条

    const seen: number[] = [];
    const types: string[] = [];
    let cursor = 0;
    for (let guard = 0; guard < 50; guard++) {
      const page = (await call(
        h.port,
        "GET",
        `/goals/${goalId}/logs?cursor=${cursor}&limit=2`,
        h.token,
      )).body as { events: Array<Record<string, unknown>>; nextCursor: number };
      expect(page.events.length).toBeLessThanOrEqual(2);
      for (const e of page.events) {
        const seq = e["seq"] as number;
        expect(seq).toBeGreaterThan(cursor); // 不重复：严格前进
        seen.push(seq);
        types.push(e["type"] as string);
      }
      if (page.events.length === 0) break;
      expect(page.nextCursor).toBe(seen[seen.length - 1]!);
      cursor = page.nextCursor;
      if (page.events.length < 2) break;
    }
    // 不遗漏：1..max 连续覆盖
    expect(seen.length).toBeGreaterThanOrEqual(5);
    expect(seen).toEqual(Array.from({ length: seen.length }, (_, i) => i + 1));
    expect(types[0]).toBe("goal.start");
    expect(types).toContain("goal.pause");
    expect(types).toContain("goal.resume");
    expect(types).toContain("goal.inject");
  });

  it("非法 cursor / limit → 400 结构化；未知目标 → 404", async () => {
    const h = await makeHarness();
    const goalId = await createGoal(h);
    const badCursor = await call(h.port, "GET", `/goals/${goalId}/logs?cursor=abc`, h.token);
    expect(badCursor.status).toBe(400);
    expect(errCode(badCursor)).toBe("GOAL_CURSOR_INVALID");
    const badLimit = await call(h.port, "GET", `/goals/${goalId}/logs?limit=0`, h.token);
    expect(badLimit.status).toBe(400);
    expect(errCode(badLimit)).toBe("GOAL_LIMIT_INVALID");
    const missing = await call(h.port, "GET", "/goals/no-such/logs", h.token);
    expect(missing.status).toBe(404);
    expect(errCode(missing)).toBe("GOAL_NOT_FOUND");
    // cursor 越过末尾：空页 + nextCursor 原样回传（轮询续读语义，R-dg3）
    const past = (await call(h.port, "GET", `/goals/${goalId}/logs?cursor=99999`, h.token)).body as {
      events: unknown[];
      nextCursor: number;
    };
    expect(past.events).toEqual([]);
    expect(past.nextCursor).toBe(99999);
    // limit 超上限：显式 400（禁静默钳位）
    const overLimit = await call(h.port, "GET", `/goals/${goalId}/logs?limit=1001`, h.token);
    expect(overLimit.status).toBe(400);
    expect(errCode(overLimit)).toBe("GOAL_LIMIT_INVALID");
  });
});

/* ───── R-dg4：多目标隔离 ───── */

describe("并发多目标隔离（R-dg4）", () => {
  it("两个目标独立会话/状态：驱动 A 到 complete 不影响 B；pause B 不影响 A", async () => {
    const h = await makeHarness();
    const a = await createGoal(h, { objective: "目标A" });
    const b = await createGoal(h, { objective: "目标B" });
    expect(a).not.toBe(b);
    await h.loop.sweepOnce(); // A、B 同轮各自引导
    expect(h.transport.injections.length).toBe(2);
    const [refA, refB] = h.transport.injections.map((i) => i.ref);
    expect(refA!.id).not.toBe(refB!.id); // 独立会话

    // B 暂停后 A 继续驱动到完成
    await call(h.port, "POST", `/goals/${b}/control`, h.token, { action: "pause" });
    h.advance(4000);
    h.transport.emit(refA!, "output", "[GOAL-STEP 2/2] 收尾 | 推荐方案: x"); // 2/2 → 步 1 记完成
    h.advance(4000);
    h.transport.emit(refA!, "output", "done [GOAL-DONE]");
    await h.loop.sweepOnce();

    const sa = (await call(h.port, "GET", `/goals/${a}`, h.token)).body as Record<string, unknown>;
    const sb = (await call(h.port, "GET", `/goals/${b}`, h.token)).body as Record<string, unknown>;
    expect(sa["phase"]).toBe("complete");
    expect(sb["phase"]).toBe("paused");
    expect(sa["steps"]).toEqual([1]);
    expect(sb["steps"]).toEqual([]);

    // B 恢复后注入继续，A 已终态不受影响
    await call(h.port, "POST", `/goals/${b}/control`, h.token, { action: "resume" });
    expect(h.transport.injections.length).toBe(3);
    expect(h.transport.injections[2]!.ref.id).toBe(refB!.id);
    const sa2 = (await call(h.port, "GET", `/goals/${a}`, h.token)).body as Record<string, unknown>;
    expect(sa2["phase"]).toBe("complete");
  });
});

/* ───── R-dg1/R-st4/M72：启动对账接线（落盘状态构造 runner + 不重复注入 + 时钟注入） ───── */

describe("守护启动对账接线（R-dg1 落盘构造 / R-st4 不重复注入 / M72 时钟注入）", () => {
  it("重启后以落盘状态 roster：reconcile 重锚恰一次，tick 不重复注入；对账时刻取注入时钟", async () => {
    const stateDir = path.join(TEST_ROOT, `reconcile-${Date.now().toString(36)}`);
    const cfg = loadConfig({ stateDir, daemonUrl: "http://127.0.0.1:0" }, {});
    const transport = new FakeTransport();
    let t = 1_000_000;
    const clock = { now: () => t };
    // 预置：已存在会话的 active 目标（injected 空 → 对账重锚分支）
    const ref = await transport.start(cfg);
    const seed: GoalState = {
      goalId: "g-seed-1",
      objective: "预置目标",
      verify: [],
      phase: "active",
      rounds: 0,
      steps: [],
      strikes: 0,
      injected: [],
      lastProgressAt: 555, // 陈旧值：对账后应被注入时钟刷新为 1_000_000（而非墙钟）
      session: ref,
    };
    await saveGoal(stateDir, seed);

    const loop = makeManualLoop();
    const host = new GoalHost({ cfg, transport, clock, loop: loop.loop, verifyRun: async () => ({ ok: true, out: "OK" }) });
    const daemon = createDaemon(cfg, undefined, host);
    openDaemons.push(daemon);
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    };
    let port: number;
    try {
      port = (await daemon.start()).port;
    } finally {
      console.error = origError;
    }
    const token = await readFile(path.join(stateDir, "daemon-token"), "utf8");

    // 启动摘要可见（resumed=1）
    expect(errors.join("\n")).toContain("resumed=1");

    // 对账重锚：恰一次注入
    expect(transport.injections.length).toBe(1);
    // M72：对账刷新的 lastProgressAt 取注入时钟（1_000_000），不是系统墙钟（~1.7e12）
    const st = (await call(port, "GET", "/goals/g-seed-1", token)).body as Record<string, unknown>;
    expect(st["lastProgressAt"]).toBe(1_000_000);
    expect(st["rounds"]).toBe(1);

    // roster runner 首轮 sweep：injected 指纹在场 → 不重复注入（R-st4/R-dg1）
    await loop.sweepOnce();
    expect(transport.injections.length).toBe(1);
    // 越过停滞阈值再 sweep：会话活、无信号 → nudge 注入继续（证明 roster runner 在驱动）
    t += 61_000;
    await loop.sweepOnce();
    expect(transport.injections.length).toBe(2);
    expect(transport.injections[1]!.text).toContain(CONTINUE_PROMPT);
  });
});

/* ───── R-dg5-①：autoNudge 接线 ───── */

describe("autoNudge 接线（R-dg5-①：宿主 cfg 默认 + 逐目标覆盖）", () => {
  it("cfg.autoNudge=false：停滞不注入、strikes 不累计；逐目标 autoNudge=true 覆盖后恢复注入", async () => {
    const h = await makeHarness({ autoNudge: false });
    const quiet = await createGoal(h);
    expect(h.transport.injections.length).toBe(1);
    h.advance(61_000);
    await h.loop.sweepOnce();
    expect(h.transport.injections.length).toBe(1); // 停滞不自动续跑
    let st = (await call(h.port, "GET", `/goals/${quiet}`, h.token)).body as Record<string, unknown>;
    expect(st["strikes"]).toBe(0); // 未尝试恢复 → 不计 strike

    // 逐目标显式覆盖 true：停滞注入继续
    const loud = await createGoal(h, { objective: "覆盖目标", autoNudge: true });
    await h.loop.sweepOnce();
    expect(h.transport.injections.length).toBe(2);
    h.advance(61_000);
    await h.loop.sweepOnce();
    expect(h.transport.injections.length).toBe(3);
    expect(h.transport.injections[2]!.text).toContain(CONTINUE_PROMPT);
    st = (await call(h.port, "GET", `/goals/${loud}`, h.token)).body as Record<string, unknown>;
    expect(st["strikes"]).toBe(1);
  });
});

/* ───── R-dg5-③：pidfile 单守护前提 ───── */

describe("daemon.pid 单守护前提（R-dg5-③）", () => {
  async function pidPathOf(cfg: BridgeConfig): Promise<string> {
    return path.join(cfg.stateDir, "daemon.pid");
  }

  it("start 写入自身 pid（0600）；stop 清除；重启再写", async () => {
    const cfg = loadConfig(
      { stateDir: path.join(TEST_ROOT, `pid-${Date.now().toString(36)}`), daemonUrl: "http://127.0.0.1:0" },
      {},
    );
    const pidPath = await pidPathOf(cfg);
    const daemon = createDaemon(cfg);
    openDaemons.push(daemon);
    await daemon.start();
    const content = await readFile(pidPath, "utf8");
    expect(content).toBe(`${process.pid}\n`);
    const st = await stat(pidPath);
    expect(st.mode & 0o777).toBe(0o600);
    await daemon.stop();
    await expect(readFile(pidPath, "utf8")).rejects.toThrow(); // 已清除
    const again = createDaemon(cfg);
    openDaemons.push(again);
    await again.start(); // 重启可再写
    expect(await readFile(pidPath, "utf8")).toBe(`${process.pid}\n`);
    await again.stop();
    await unlink(pidPath).catch(() => undefined);
  });

  it("陈旧 pid（进程已死）→ 启动成功并覆写", async () => {
    const dead = Bun.spawn(["true"]);
    await dead.exited; // 保证 pid 已死
    const cfg = loadConfig(
      { stateDir: path.join(TEST_ROOT, `pid-stale-${Date.now().toString(36)}`), daemonUrl: "http://127.0.0.1:0" },
      {},
    );
    await mkdir(cfg.stateDir, { recursive: true });
    await writeFile(path.join(cfg.stateDir, "daemon.pid"), `${dead.pid}\n`);
    const daemon = createDaemon(cfg);
    openDaemons.push(daemon);
    await daemon.start(); // 不抛：陈旧清除
    expect(await readFile(path.join(cfg.stateDir, "daemon.pid"), "utf8")).toBe(`${process.pid}\n`);
  });

  it("活进程 pid → DAEMON_ALREADY_RUNNING 显式拒绝；内容非法 → DAEMON_PIDFILE_INVALID", async () => {
    const sleeper = Bun.spawn(["sleep", "30"]);
    try {
      const cfg = loadConfig(
        { stateDir: path.join(TEST_ROOT, `pid-live-${Date.now().toString(36)}`), daemonUrl: "http://127.0.0.1:0" },
        {},
      );
      await mkdir(cfg.stateDir, { recursive: true });
      await writeFile(path.join(cfg.stateDir, "daemon.pid"), `${sleeper.pid}\n`);
      const daemon = createDaemon(cfg);
      let caught: unknown;
      try {
        await daemon.start();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BridgeError);
      expect((caught as BridgeError).code).toBe("DAEMON_ALREADY_RUNNING");
      await daemon.stop().catch(() => undefined);

      const cfg2 = loadConfig(
        { stateDir: path.join(TEST_ROOT, `pid-corrupt-${Date.now().toString(36)}`), daemonUrl: "http://127.0.0.1:0" },
        {},
      );
      await mkdir(cfg2.stateDir, { recursive: true });
      await writeFile(path.join(cfg2.stateDir, "daemon.pid"), "not-a-pid\n");
      const daemon2 = createDaemon(cfg2);
      let caught2: unknown;
      try {
        await daemon2.start();
      } catch (e) {
        caught2 = e;
      }
      expect((caught2 as BridgeError).code).toBe("DAEMON_PIDFILE_INVALID");
    } finally {
      sleeper.kill();
    }
  });
});

/* ───── 目标域未接线 → 显式 501（禁静默假装功能存在） ───── */

describe("未接线 GoalHost 的守护（显式 501）", () => {
  it("GET/POST /goals → 501 GOAL_HOST_DISABLED 结构化", async () => {
    const cfg = loadConfig(
      { stateDir: path.join(TEST_ROOT, `nohost-${Date.now().toString(36)}`), daemonUrl: "http://127.0.0.1:0" },
      {},
    );
    const daemon = createDaemon(cfg);
    openDaemons.push(daemon);
    const { port } = await daemon.start();
    const token = await readFile(path.join(cfg.stateDir, "daemon-token"), "utf8");
    const g = await call(port, "GET", "/goals", token);
    expect(g.status).toBe(501);
    expect(errCode(g)).toBe("GOAL_HOST_DISABLED");
    const p = await call(port, "POST", "/goals", token, { objective: "x" });
    expect(p.status).toBe(501);
    expect(errCode(p)).toBe("GOAL_HOST_DISABLED");
  });
});

/* ───── POST /goals 输入校验（显式 400，禁静默截断/补缺） ───── */

describe("POST /goals 输入校验", () => {
  it("objective 缺失/空白、verify 非数组、workdir 相对路径、maxRounds 非正整数 → 400 GOAL_INPUT_INVALID", async () => {
    const h = await makeHarness();
    const cases: Array<Record<string, unknown>> = [
      {},
      { objective: "   " },
      { objective: "x", verify: "bun test" },
      { objective: "x", workdir: "relative/path" },
      { objective: "x", maxRounds: 0 },
      { objective: "x", autoNudge: "yes" },
    ];
    for (const body of cases) {
      const r = await call(h.port, "POST", "/goals", h.token, body);
      expect(r.status).toBe(400);
      expect(errCode(r)).toBe("GOAL_INPUT_INVALID");
    }
  });

  it("非 JSON 请求体 → 400 GOAL_BODY_INVALID", async () => {
    const h = await makeHarness();
    const res = await fetch(`http://127.0.0.1:${h.port}/goals`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.token}`, "content-type": "application/json" },
      body: "{not-json",
    });
    expect(res.status).toBe(400);
    expect(errCode({ status: res.status, body: await res.json() })).toBe("GOAL_BODY_INVALID");
  });

  it("合法可选字段（workdir/maxRounds/autoNudge）持久化并在 GET 中可见", async () => {
    const h = await makeHarness();
    const goalId = await createGoal(h, {
      objective: "带元数据目标",
      verify: ["echo ok"],
      workdir: "/tmp/project-x",
      maxRounds: 20,
      autoNudge: false,
    });
    const st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["workdir"]).toBe("/tmp/project-x");
    expect(st["maxRounds"]).toBe(20);
    expect(st["autoNudge"]).toBe(false);
    expect(st["verify"]).toEqual(["echo ok"]);
  });
});

/* ───── HTTP 形态卫生 ───── */

describe("响应形态卫生", () => {
  it("所有 /goals 响应均为 application/json", async () => {
    const h = await makeHarness();
    const res = await fetch(`http://127.0.0.1:${h.port}/goals`, {
      headers: { authorization: `Bearer ${h.token}` },
    });
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("GET /health 免鉴权且含 actives 字段（无目标=0）", async () => {
    const h = await makeHarness();
    const body = (await fetch(`http://127.0.0.1:${h.port}/health`).then((r) => r.json())) as Record<string, unknown>;
    expect(body["ok"]).toBe(true);
    expect(body["actives"]).toBe(0);
  });
});

/* ───── 修复环第 1 轮（真机 T4-02 缺陷①：verifyRun 生产装配接线） ───── */

describe("修复环① verifyRun 装配接线", () => {
  it("带 verify 目标 done 后执行验收：cmd 逐字透传、cwd=goal.workdir；通过 → complete 落盘", async () => {
    const calls: Array<{ cmd: string[]; cwd?: string }> = [];
    const h = await makeHarness({
      verifyRun: async (cmd, cwd) => {
        calls.push({ cmd, cwd });
        return { ok: true, out: "OK" };
      },
    });
    const workdir = path.join(TEST_ROOT, "verify-wd");
    await mkdir(workdir, { recursive: true });
    const created = (await call(h.port, "POST", "/goals", h.token, {
      objective: "制造验收物",
      verify: ["echo hi", "ls -la"],
      workdir,
    })).body as { goalId: string };
    await h.loop.sweepOnce(); // 引导：建会话 + 契约注入
    const st0 = (await call(h.port, "GET", `/goals/${created.goalId}`, h.token)).body as GoalState;
    if (st0.session === undefined) throw new Error("引导后 session 应在场");
    h.advance(4_000); // 越过回显守卫窗
    h.transport.emit(st0.session, "output", "完成 [GOAL-DONE]");
    await h.loop.sweepOnce(); // done 核验 → verifyRun 逐条执行 → 双过
    const st1 = (await call(h.port, "GET", `/goals/${created.goalId}`, h.token)).body as GoalState;
    expect(st1.phase).toBe("complete");
    expect(calls.map((c) => c.cmd)).toEqual([["echo", "hi"], ["ls", "-la"]]);
    expect(calls.every((c) => c.cwd === workdir)).toBe(true); // cwd 缺省目标 workdir（裁定①）
    await new Promise((r) => setTimeout(r, 30)); // 审计队列为异步追加（sweep 成功路径最终一致），让渡落盘
    const audit = await readFile(path.join(h.cfg.stateDir, "audit", `${created.goalId}.jsonl`), "utf8");
    expect(audit).toContain("goal.verify");
    expect(audit).toContain("goal.complete");
  });

  it("验收未过 → 注入失败原因继续驱动（verifyRun 失败透传，不 complete）", async () => {
    let n = 0;
    const h = await makeHarness({
      verifyRun: async () => {
        n += 1;
        return { ok: false, out: "断言失败" };
      },
    });
    const created = (await call(h.port, "POST", "/goals", h.token, {
      objective: "必然失败",
      verify: ["false"],
    })).body as { goalId: string };
    await h.loop.sweepOnce();
    const st0 = (await call(h.port, "GET", `/goals/${created.goalId}`, h.token)).body as GoalState;
    if (st0.session === undefined) throw new Error("引导后 session 应在场");
    h.advance(4_000);
    h.transport.emit(st0.session, "output", "完成 [GOAL-DONE]");
    await h.loop.sweepOnce();
    const st1 = (await call(h.port, "GET", `/goals/${created.goalId}`, h.token)).body as GoalState;
    expect(st1.phase).toBe("active"); // 验收未过：继续驱动
    expect(n).toBe(1);
    expect(h.transport.injections.length).toBe(2); // 契约 + 验收失败重注
    expect(h.transport.injections[1]!.text).toContain("验收未通过");
    expect(h.transport.injections[1]!.text).toContain("断言失败");
  });
});
