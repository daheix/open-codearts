/**
 * codearts_run 工具与 runOnce 编排测试（T2-05，TDD）。
 *
 * 主控裁定对照（2026-10-31，逐条）：
 * - R-cr1（auto 传输选择显式）：selectTransport 纯函数——structured 当且仅当
 *   readAksk 有凭据；否则 pty（ptyHost=tmux 显式→tmux；script 显式→script；
 *   auto→探测 tmux 可用性二选一）；显式 transport 优先；结果必含 {mode, reason}。
 * - R-cr2（超时语义）：timeoutMs 到 → stop() + 结构化超时结果（含已捕获输出
 *   摘要；非静默、非错误）。
 * - R-cr3（进度与取消）：progress 按信号批次或 2s 节流更新（至少一次）；
 *   context.signal abort → transport.stop()（对齐 T9 abort 语义）。
 * - R-cr4（审计）：run.start / run.exit 写 audit/install.jsonl（含 mode/prompt
 *   摘要/session/结果摘要；prompt 全文不入审计——只记长度与前 80 字符）。
 * - 错误路径（任务书 Step1）：transport 报 retryable 错误 → 工具返回可重试
 *   标记与摘要；不静默重试（重试属目标引擎职责）。
 *
 * 隔离：FakeTransport（零进程零 FS 副作用）+ FakeClock（确定性时序）+ 临时
 * stateDir（审计落点仅插件 test/.tmp/，用后即删）；绝不触碰真实 HOME。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { loadConfig, type BridgeConfig } from "../src/core/config";
import { BridgeError } from "../src/core/errors";
import { FakeTransport } from "../src/core/transport/fake";
import type { CodeartsTransport, SessionRef } from "../src/core/transport/types";
import {
  RUN_DEFAULT_TIMEOUT_MS,
  RUN_PROMPT_PREVIEW_CHARS,
  RUN_SUMMARY_MAX_CHARS,
  runOnce,
  selectTransport,
  type RunClock,
  type RunResult,
  type TransportSelection,
} from "../src/core/run";
import { buildPlugin, TOOL_NAMES } from "../src/server";

/* ───── 测试环境装配 ───── */

/** 测试用临时根（工作目录内 .tmp/，用后即删，禁系统临时目录）。 */
const TMP_ROOT = path.join(import.meta.dir, ".tmp", "t13");
mkdirSync(TMP_ROOT, { recursive: true });

/** 每用例独立临时目录（afterEach 统一清理）。 */
let root: string;

/** 无凭据的隔离配置（akskFile 指向未写文件 → readAksk=undefined）。 */
function makeCfg(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return loadConfig(
    {
      stateDir: path.join(root, "state"),
      installDir: path.join(root, "installers"),
      ...overrides,
    },
    {},
  );
}

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined as unknown as string;
});

/** 等待条件成立（轮询真实事件循环；FakeTransport 注入/观察均为微任务级）。 */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  throw new Error("until 超时：条件未满足");
}

/** 等待已入队信号被 observe 循环消费（微任务链排空；一个宏任务足矣）。 */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 5));
}

/** FakeClock：确定性 now/delay（timeout 与 2s 节流均经测试显式驱动）。 */
class FakeClock implements RunClock {
  nowValue = 1_000_000;
  private readonly pending: Array<{ ms: number; resolve: () => void }> = [];

  now(): number {
    return this.nowValue;
  }

  advance(delta: number): void {
    this.nowValue += delta;
  }

  delay(ms: number): { promise: Promise<void>; cancel(): void } {
    const entry = { ms, resolve: () => {} };
    const promise = new Promise<void>((resolve) => {
      entry.resolve = resolve;
    });
    this.pending.push(entry);
    return {
      promise,
      cancel: () => {
        const i = this.pending.indexOf(entry);
        if (i >= 0) this.pending.splice(i, 1);
        entry.resolve();
      },
    };
  }

  /** 触发所有挂起定时（或仅指定 ms 者）——模拟超时到期。 */
  fire(ms?: number): void {
    for (const e of this.pending.splice(0)) {
      if (ms === undefined || e.ms === ms) e.resolve();
      else this.pending.push(e);
    }
  }
}

/** buildTransport 注入桩：记录每次选择并返回指定 fake 传输。 */
function makeBuildTransportSpy(transport: CodeartsTransport = new FakeTransport()) {
  const selections: TransportSelection[] = [];
  return {
    selections,
    transport,
    build: (sel: TransportSelection): CodeartsTransport => {
      selections.push(sel);
      return transport;
    },
  };
}

/** 轮询拿到 runOnce 已注入 prompt 后的会话引用（FakeTransport 注入留痕）。 */
async function injectedRef(tr: FakeTransport): Promise<SessionRef> {
  await until(() => tr.injections.length > 0);
  return tr.injections[tr.injections.length - 1]!.ref;
}

/** 完成一轮：注入后发 done 信号并等待 runOnce 落定。 */
async function finishWithDone(tr: FakeTransport, runPromise: Promise<RunResult>): Promise<RunResult> {
  const ref = await injectedRef(tr);
  tr.emit(ref, "done");
  return await runPromise;
}

/* ───── R-cr1：selectTransport 纯函数 ───── */

describe("selectTransport（R-cr1 auto 选择显式）", () => {
  it("显式 transport=structured → structured（无需凭据与 tmux 信息）", () => {
    const sel = selectTransport({ transport: "structured", ptyHost: "auto", hasAksk: false, tmuxAvailable: false });
    expect(sel.mode).toBe("structured");
    expect(sel.reason).toContain("structured");
    expect(sel.reason).toContain("显式");
  });

  it("显式 transport=pty + ptyHost=script/tmux → 对应宿主", () => {
    const script = selectTransport({ transport: "pty", ptyHost: "script", hasAksk: false, tmuxAvailable: false });
    expect(script.mode).toBe("pty-script");
    expect(script.reason).toContain("显式");
    const tmux = selectTransport({ transport: "pty", ptyHost: "tmux", hasAksk: true, tmuxAvailable: false });
    expect(tmux.mode).toBe("pty-tmux");
  });

  it("auto + 有 AK/SK 凭据 → structured（tmux 不可用也不影响）", () => {
    const sel = selectTransport({ transport: "auto", ptyHost: "auto", hasAksk: true, tmuxAvailable: false });
    expect(sel.mode).toBe("structured");
    expect(sel.reason).toContain("AK/SK");
  });

  it("auto + 无凭据 + ptyHost=auto → 按 tmux 可用性二选一", () => {
    const withTmux = selectTransport({ transport: "auto", ptyHost: "auto", hasAksk: false, tmuxAvailable: true });
    expect(withTmux.mode).toBe("pty-tmux");
    expect(withTmux.reason).toContain("tmux");
    const withoutTmux = selectTransport({ transport: "auto", ptyHost: "auto", hasAksk: false, tmuxAvailable: false });
    expect(withoutTmux.mode).toBe("pty-script");
    expect(withoutTmux.reason).toContain("script");
  });

  it("auto + 无凭据 + ptyHost 显式 → 不看 tmux 探测结果", () => {
    const tmux = selectTransport({ transport: "auto", ptyHost: "tmux", hasAksk: false, tmuxAvailable: false });
    expect(tmux.mode).toBe("pty-tmux");
    const script = selectTransport({ transport: "auto", ptyHost: "script", hasAksk: false, tmuxAvailable: true });
    expect(script.mode).toBe("pty-script");
  });
});

/* ───── runOnce 编排（fake 传输 + fake 时钟，全离线） ───── */

describe("runOnce（R-cr1/R-cr2/R-cr3/R-cr4）", () => {
  it("正常完成：done → status=completed，返回 session/summary/signals/mode/reason/auditId", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "ok-"));
    const cfg = makeCfg({ transport: "pty", ptyHost: "script" });
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    const runPromise = runOnce({
      cfg,
      prompt: "只回复两个字：你好",
      buildTransport: spy.build,
      clock: new FakeClock(),
    });
    const ref = await injectedRef(tr);
    tr.emit(ref, "output", "你好");
    tr.emit(ref, "done");
    const result = await runPromise;

    expect(result.status).toBe("completed");
    expect(result.session).toEqual({ kind: "pty", id: ref.id });
    expect(result.mode).toBe("pty-script");
    expect(result.reason).toContain("pty");
    expect(result.signals).toBe(2);
    expect(result.errors).toBe(0);
    expect(result.retryable).toBe(false);
    expect(result.summary).toContain("你好");
    expect(result.outputBytes).toBeGreaterThan(0);
    expect(result.auditId.length).toBeGreaterThan(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    // 注入留痕：prompt 恰好注入一次
    expect(tr.injections).toHaveLength(1);
    expect(tr.injections[0]!.text).toBe("只回复两个字：你好");
  });

  it("auto：aksk 存在 → structured 选择（reason 说明凭据依据）", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "auto-aksk-"));
    const cfg = makeCfg(); // transport/ptyHost 缺省 auto；akskFile=<stateDir>/config.env
    mkdirSync(path.dirname(cfg.akskFile), { recursive: true });
    writeFileSync(cfg.akskFile, "AK=ak-test\nSK=sk-test\n", "utf8");
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    const result = await finishWithDone(
      tr,
      runOnce({ cfg, prompt: "hi", buildTransport: spy.build, clock: new FakeClock() }),
    );
    expect(result.mode).toBe("structured");
    expect(result.reason).toContain("AK/SK");
    expect(spy.selections).toHaveLength(1);
    expect(spy.selections[0]!.mode).toBe("structured");
  });

  it("auto：无凭据 + tmux 探测不可用 → pty-script（tmuxProbe 被调用）", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "auto-script-"));
    const cfg = makeCfg();
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    let probeCalls = 0;
    const result = await finishWithDone(
      tr,
      runOnce({
        cfg,
        prompt: "hi",
        buildTransport: spy.build,
        clock: new FakeClock(),
        tmuxProbe: async () => {
          probeCalls++;
          return false;
        },
      }),
    );
    expect(result.mode).toBe("pty-script");
    expect(result.reason).toContain("script");
    expect(probeCalls).toBe(1);
    expect(spy.selections[0]!.mode).toBe("pty-script");
  });

  it("显式 pty + ptyHost=script：不触发 tmux 探测", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "explicit-"));
    const cfg = makeCfg({ transport: "pty", ptyHost: "script" });
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    let probeCalls = 0;
    await finishWithDone(
      tr,
      runOnce({
        cfg,
        prompt: "hi",
        buildTransport: spy.build,
        clock: new FakeClock(),
        tmuxProbe: async () => {
          probeCalls++;
          return true;
        },
      }),
    );
    expect(probeCalls).toBe(0);
    expect(spy.selections[0]!.mode).toBe("pty-script");
  });

  it("进度（R-cr3）：注入后至少一次；信号批次按 2s 节流", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "progress-"));
    const cfg = makeCfg({ transport: "pty", ptyHost: "script" });
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    const clock = new FakeClock();
    const statuses: string[] = [];
    const runPromise = runOnce({
      cfg,
      prompt: "hi",
      buildTransport: spy.build,
      clock,
      progress: (u) => {
        statuses.push(u.status);
      },
    });
    const ref = await injectedRef(tr);
    expect(statuses.length).toBeGreaterThanOrEqual(1); // 注入后的初始进度
    tr.emit(ref, "output", "a");
    await settle();
    tr.emit(ref, "output", "b"); // 同一批次（时钟未推进）→ 不新增
    await settle();
    expect(statuses.length).toBe(1);
    clock.advance(2_001);
    tr.emit(ref, "output", "c"); // 跨过 2s 节流 → 新增
    await settle();
    expect(statuses.length).toBe(2);
    for (const s of statuses) expect(typeof s).toBe("string");
    expect(statuses[1]).toContain("3"); // 状态文本含已捕获信号数
    tr.emit(ref, "done");
    await runPromise;
    expect(statuses.length).toBe(2);
  });

  it("取消（R-cr3）：context.signal abort → stop 被调 + status=cancelled", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "cancel-"));
    const cfg = makeCfg({ transport: "pty", ptyHost: "script" });
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    const external = new AbortController();
    const runPromise = runOnce({
      cfg,
      prompt: "hi",
      buildTransport: spy.build,
      clock: new FakeClock(),
      signal: external.signal,
    });
    await injectedRef(tr);
    external.abort();
    const result = await runPromise;
    expect(result.status).toBe("cancelled");
    expect(await tr.alive(result.session)).toBe(false); // stop() 已调
  });

  it("取消（R-cr3 边界）：传入时已 abort 的信号 → 立即取消（不等事件）", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "cancel-pre-"));
    const cfg = makeCfg({ transport: "pty", ptyHost: "script" });
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    const external = new AbortController();
    external.abort(); // 运行前已取消
    const result = await runOnce({
      cfg,
      prompt: "hi",
      buildTransport: spy.build,
      clock: new FakeClock(),
      signal: external.signal,
    });
    expect(result.status).toBe("cancelled");
    expect(await tr.alive(result.session)).toBe(false);
    // M48（修复环裁定）：已取消的 prompt 不再写入目标会话——inject 零调用
    expect(tr.injections).toHaveLength(0);
  });

  it("超时（R-cr2）：timeoutMs 到 → stop + 结构化超时结果（含已捕获输出）", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "timeout-"));
    const cfg = makeCfg({ transport: "pty", ptyHost: "script" });
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    const clock = new FakeClock();
    const runPromise = runOnce({
      cfg,
      prompt: "hi",
      timeoutMs: 50_000,
      buildTransport: spy.build,
      clock,
    });
    const ref = await injectedRef(tr);
    tr.emit(ref, "output", "部分输出");
    await settle(); // 等待信号被 observe 循环消费（进入捕获缓冲）
    clock.fire(50_000);
    const result = await runPromise;
    expect(result.status).toBe("timeout");
    expect(result.summary).toContain("部分输出");
    expect(await tr.alive(result.session)).toBe(false); // stop() 已调
    expect(result.signals).toBe(1);
  });

  it("retryable 错误信号：返回可重试标记与摘要，不静默重试（注入恰一次）", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "retry-"));
    const cfg = makeCfg({ transport: "pty", ptyHost: "script" });
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    const runPromise = runOnce({ cfg, prompt: "hi", buildTransport: spy.build, clock: new FakeClock() });
    const ref = await injectedRef(tr);
    tr.emit(ref, "error", "request failed: ECONNRESET at socket");
    tr.emit(ref, "done");
    const result = await runPromise;
    expect(result.status).toBe("completed");
    expect(result.errors).toBe(1);
    expect(result.retryable).toBe(true);
    expect(result.summary).toContain("ECONNRESET");
    expect(tr.injections).toHaveLength(1); // 不静默重试——重试属目标引擎职责
  });

  it("ended：事件流结束但无 done（如回合失败退出）→ status=ended（非错误）", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "ended-"));
    const cfg = makeCfg({ transport: "pty", ptyHost: "script" });
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    const runPromise = runOnce({ cfg, prompt: "hi", buildTransport: spy.build, clock: new FakeClock() });
    const ref = await injectedRef(tr);
    tr.emit(ref, "error", "round failed: exit 1");
    tr.stop(ref); // 外部停/会话消亡：observe 正常终止且无 done
    const result = await runPromise;
    expect(result.status).toBe("ended");
    expect(result.signals).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.retryable).toBe(false);
  });

  it("会话续接：传入上次返回的 session → 复用同一会话（注入留痕同 id）", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "continue-"));
    const cfg = makeCfg({ transport: "pty", ptyHost: "script" });
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    const first = await finishWithDone(
      tr,
      runOnce({ cfg, prompt: "第一轮", buildTransport: spy.build, clock: new FakeClock() }),
    );
    const second = await finishWithDone(
      tr,
      runOnce({ cfg, prompt: "续接", session: first.session, buildTransport: spy.build, clock: new FakeClock() }),
    );
    expect(second.session.id).toBe(first.session.id);
    expect(tr.injections[1]!.ref.id).toBe(first.session.id);
    expect(tr.injections[1]!.text).toBe("续接");
  });

  it("审计（R-cr4）：run.start/run.exit 成对写入；prompt 全文不入（只记长度+前 80 字符）", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "audit-"));
    const cfg = makeCfg({ transport: "pty", ptyHost: "script" });
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    const longPrompt = "请详细分析这台电机的气隙磁密波形，".repeat(10) + "结尾标记XYZ";
    const result = await finishWithDone(
      tr,
      runOnce({ cfg, prompt: longPrompt, buildTransport: spy.build, clock: new FakeClock() }),
    );
    const lines = readFileSync(path.join(cfg.stateDir, "audit", "install.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const start = lines.find((l) => l.kind === "run.start") as Record<string, unknown>;
    const exit = lines.find((l) => l.kind === "run.exit") as Record<string, unknown>;
    expect(start).toBeDefined();
    expect(exit).toBeDefined();
    expect(start.auditId).toBe(result.auditId);
    expect(exit.auditId).toBe(result.auditId);
    expect(start.mode).toBe("pty-script");
    expect(start.session).toBe(result.session.id);
    expect(start.promptLength).toBe(longPrompt.length);
    expect(start.promptPreview).toBe(longPrompt.slice(0, RUN_PROMPT_PREVIEW_CHARS));
    // 全文不入审计：80 字符之后的尾部标记不得出现
    expect(JSON.stringify(lines)).not.toContain("结尾标记XYZ");
    expect(exit.status).toBe("completed");
    expect(exit.signals).toBe(1);
    expect(exit.mode).toBe("pty-script");
    expect(exit.session).toBe(result.session.id);
  });

  it("error 路径 run.exit 审计补 outputBytes/summary（M50：schema 与成功路径对齐）", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "audit-err-"));
    const cfg = makeCfg({ transport: "pty", ptyHost: "script" });
    const tr = new FakeTransport();
    const boom = new BridgeError("PTY_INJECT_FAILED", "观察中断（测试注入）");
    // 观察首个信号交付后传输层故障的包装传输（委托 FakeTransport，方法显式转发——
    // 类实例方法在原型上，spread 不复制）
    const throwing: CodeartsTransport = {
      kind: tr.kind,
      start: (c, r) => tr.start(c, r),
      inject: (r, t) => tr.inject(r, t),
      observe(r, o) {
        const src = tr.observe(r, o);
        return (async function* () {
          for await (const sig of src) {
            yield sig;
            throw boom; // 首信号后故障 → runOnce error 路径
          }
        })();
      },
      alive: (r) => tr.alive(r),
      stop: (r) => tr.stop(r),
      snapshot: (r) => tr.snapshot(r),
    };
    const runPromise = runOnce({ cfg, prompt: "hi", buildTransport: () => throwing, clock: new FakeClock() });
    const ref = await injectedRef(tr);
    tr.emit(ref, "output", "部分输出后传输故障");
    let caught: unknown;
    try {
      await runPromise;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BridgeError);
    expect((caught as BridgeError).code).toBe("PTY_INJECT_FAILED");
    const lines = readFileSync(path.join(cfg.stateDir, "audit", "install.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const exit = lines.find((l) => l.kind === "run.exit") as Record<string, unknown>;
    expect(exit).toBeDefined();
    expect(exit.status).toBe("error");
    expect(exit.errorCode).toBe("PTY_INJECT_FAILED");
    expect(typeof exit.outputBytes).toBe("number"); // M50：字段存在且与成功路径 schema 对齐
    expect(exit.outputBytes).toBeGreaterThan(0);
    expect(String(exit.summary)).toContain("部分输出后传输故障");
  });

  it("空 prompt / timeoutMs=0 → 显式 TOOL_INPUT_INVALID（禁静默截断/钳位）", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "invalid-"));
    const cfg = makeCfg();
    const badCases: Array<{ prompt: string; timeoutMs?: number }> = [{ prompt: "" }, { prompt: "hi", timeoutMs: 0 }];
    for (const bad of badCases) {
      let caught: unknown;
      try {
        await runOnce({
          cfg,
          prompt: bad.prompt,
          ...(bad.timeoutMs !== undefined ? { timeoutMs: bad.timeoutMs } : {}),
          buildTransport: makeBuildTransportSpy().build,
          clock: new FakeClock(),
        });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BridgeError);
      expect((caught as BridgeError).code).toBe("TOOL_INPUT_INVALID");
    }
  });

  it("缺省 timeoutMs = 120000（常量口径）", () => {
    expect(RUN_DEFAULT_TIMEOUT_MS).toBe(120_000);
    expect(RUN_SUMMARY_MAX_CHARS).toBe(500);
    expect(RUN_PROMPT_PREVIEW_CHARS).toBe(80);
  });
});

/* ───── codearts_run 工具接线（server 层） ───── */

/** 工具层 fake ctx（R-cr3：progress/signal 经宿主上下文注入）。 */
interface FakeToolCtx {
  sessionID: string;
  agent?: string;
  messageID: string;
  id: string;
  progress?: (update: Record<string, unknown>) => unknown;
  signal?: AbortSignal;
}

interface CapturedTool {
  name: string;
  options?: { namespace?: string };
  input: Record<string, unknown>;
  description: string;
  execute: (input: unknown, context: unknown) => Promise<{ content: Array<{ type: string; text: string }> }>;
}

/** 组装注入 fake 依赖的插件并捕获注册的工具。 */
async function setupTools(deps: Parameters<typeof buildPlugin>[0] = {}): Promise<CapturedTool[]> {
  const added: CapturedTool[] = [];
  const plugin = buildPlugin(deps);
  await plugin.setup({
    options: {},
    permission: undefined,
    tool: {
      transform: async (cb: (editor: { add: (t: CapturedTool) => void }) => void) => {
        cb({ add: (t) => added.push(t) });
        return { dispose: async () => {} };
      },
    },
  } as unknown as Parameters<typeof plugin.setup>[0]);
  return added;
}

describe("codearts_run 工具接线（server 层）", () => {
  it("TOOL_NAMES 含 run（六工具）；run schema：prompt 必填 + 封闭对象", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "wire-"));
    expect(TOOL_NAMES).toContain("run");
    const added = await setupTools();
    expect(added.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    const run = added.find((t) => t.name === "run")!;
    expect(run.options?.namespace).toBe("codearts");
    expect(run.description.length).toBeGreaterThan(0);
    expect(run.input["type"]).toBe("object");
    expect(run.input["additionalProperties"]).toBe(false);
    expect((run.input as { required?: string[] }).required).toContain("prompt");
    expect((run.input as { properties?: Record<string, unknown> }).properties?.prompt).toBeDefined();
  });

  it("execute 成功路径：content[0]=结构化 JSON（session/summary/signals/mode/reason/auditId）", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "exec-ok-"));
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    const added = await setupTools({
      configOverrides: { stateDir: path.join(root, "state"), installDir: path.join(root, "installers"), transport: "pty", ptyHost: "script" },
      buildTransport: spy.build,
      clock: new FakeClock(),
    });
    const run = added.find((t) => t.name === "run")!;
    const runPromise = run.execute({ prompt: "只回复两个字：你好" }, { sessionID: "s", messageID: "m", id: "t" } satisfies FakeToolCtx);
    const ref = await injectedRef(tr);
    tr.emit(ref, "output", "你好");
    tr.emit(ref, "done");
    const result = await runPromise;
    expect(result.content).toHaveLength(2);
    expect(result.content[0]!.type).toBe("text");
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect((payload.session as Record<string, unknown>).id).toBe(ref.id);
    expect(payload.mode).toBe("pty-script");
    expect(typeof payload.reason).toBe("string");
    expect(payload.signals).toBe(2);
    expect(payload.summary).toContain("你好");
    expect(typeof payload.auditId).toBe("string");
    expect(result.content[1]!.text).toContain("codearts_run");
  });

  it("ctx.progress 透传（R-cr3）：fake ctx 记录到至少一次 status 更新", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "exec-progress-"));
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    const added = await setupTools({
      configOverrides: { stateDir: path.join(root, "state"), installDir: path.join(root, "installers"), transport: "pty", ptyHost: "script" },
      buildTransport: spy.build,
      clock: new FakeClock(),
    });
    const run = added.find((t) => t.name === "run")!;
    const statuses: string[] = [];
    const runPromise = run.execute(
      { prompt: "hi" },
      {
        sessionID: "s",
        messageID: "m",
        id: "t",
        progress: (u) => {
          statuses.push(String(u.status));
        },
      } satisfies FakeToolCtx,
    );
    const ref = await injectedRef(tr);
    tr.emit(ref, "done");
    await runPromise;
    expect(statuses.length).toBeGreaterThanOrEqual(1);
  });

  it("ctx.signal 取消（R-cr3）：abort → status=cancelled 结构化返回", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "exec-cancel-"));
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    const added = await setupTools({
      configOverrides: { stateDir: path.join(root, "state"), installDir: path.join(root, "installers"), transport: "pty", ptyHost: "script" },
      buildTransport: spy.build,
      clock: new FakeClock(),
    });
    const run = added.find((t) => t.name === "run")!;
    const external = new AbortController();
    const runPromise = run.execute(
      { prompt: "hi" },
      { sessionID: "s", messageID: "m", id: "t", signal: external.signal } satisfies FakeToolCtx,
    );
    await injectedRef(tr);
    external.abort();
    const result = await runPromise;
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(payload.status).toBe("cancelled");
  });

  it("错误路径（R-t1）：续接非法会话引用（kind 不符）→ SESSION_UNKNOWN 结构化 error content；同 kind 未知 ref 按修复环③裁定采纳重建（不报错）", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "exec-err-"));
    const spy = makeBuildTransportSpy();
    const tr = spy.transport as FakeTransport;
    const added = await setupTools({
      configOverrides: { stateDir: path.join(root, "state"), installDir: path.join(root, "installers"), transport: "pty", ptyHost: "script" },
      buildTransport: spy.build,
      clock: new FakeClock(),
    });
    const run = added.find((t) => t.name === "run")!;
    const result = await run.execute(
      { prompt: "hi", session: { kind: "structured", id: "ghost" } },
      { sessionID: "s", messageID: "m", id: "t" } satisfies FakeToolCtx,
    );
    const payload = JSON.parse(result.content[0]!.text) as { error?: { code?: string } };
    expect(payload.error?.code).toBe("SESSION_UNKNOWN");
    expect(result.content[1]!.text).toContain("SESSION_UNKNOWN");
    // 修复环③（2026-10-31）：同 kind 的未知 ref = 跨守护对账采纳语义——start
    // 采纳重建并正常驱动（不再 SESSION_UNKNOWN；错误映射由 kind 不符路径承载）
    const runPromise = run.execute(
      { prompt: "hi", session: { kind: "pty", id: "adopted-1" } },
      { sessionID: "s", messageID: "m", id: "t" } satisfies FakeToolCtx,
    );
    const adopted = await injectedRef(tr);
    expect(adopted.id).toBe("adopted-1");
    tr.emit(adopted, "done");
    await runPromise;
    expect(tr.injections.some((i) => i.ref.id === "adopted-1")).toBe(true);
  });

  it("输入校验（R-t1）：空 prompt / timeoutMs=0 → TOOL_INPUT_INVALID error content", async () => {
    root = mkdtempSync(path.join(TMP_ROOT, "exec-invalid-"));
    const added = await setupTools({
      configOverrides: { stateDir: path.join(root, "state"), installDir: path.join(root, "installers") },
      buildTransport: makeBuildTransportSpy().build,
      clock: new FakeClock(),
    });
    const run = added.find((t) => t.name === "run")!;
    for (const badInput of [{ prompt: "" }, { prompt: "hi", timeoutMs: 0 }]) {
      const result = await run.execute(badInput, { sessionID: "s", messageID: "m", id: "t" } satisfies FakeToolCtx);
      const payload = JSON.parse(result.content[0]!.text) as { error?: { code?: string } };
      expect(payload.error?.code).toBe("TOOL_INPUT_INVALID");
    }
  });
});
