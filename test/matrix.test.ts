/**
 * M3 故障矩阵（T3-08 / Task 21）——八格中断场景一次性钉死，证明"永不挂起"语义闭环。
 *
 * 八格（逐格独立用例，全部离线：FakeTransport + 注入时钟 + 手动 sweep + 真实 HTTP 守护）：
 *   1. 模型错误连续重试（retryable 不停止 → 第 5 信号恢复 → complete）
 *   2. 网络类错误注入（ECONNRESET/timeout 事件 → 同一无限重试语义）
 *   3. 杀回合进程（alive=false → 重建会话 + 断点契约 → 续跑完成）
 *   4. 杀守护（stop → 同 stateDir 重新 start → reconcile 对账 → 续跑完成，不双注入）
 *   5. opencode 服务重启（插件 setup 重跑 → 守护不受影响、工具恢复可用）
 *   6. 回显防护（注入含 [GOAL-DONE] 的回显 → 不误判完成）
 *   7. 双过验收（自报 done + verify 失败 → 注入原因继续；再成功 → complete）
 *   8. pause/resume/stop 在活跃目标上即时生效（三连击 + 审计 + 无泄漏）
 *
 * 主控裁定落点（progress.md Task 21 派发记录，2026-10-31，逐条）：
 * - R-mx1（测试组装）：复用既有测试基建——FakeTransport（T2-01）/假时钟/手动
 *   TickLoop/goal-tools 测试模式（fake fetch + ManualLoop）；守护矩阵用
 *   createDaemon + GoalHost 真实 HTTP（127.0.0.1:0 内核随机端口）打端到端；
 *   插件层（格 5）用注入 fake daemonFetch（绝不联网）。
 * - R-mx2（每格断言最低集合）：终态 phase、injections 次数与内容、审计事件序列
 *   关键项（经 GET /goals/:id/logs 读磁盘审计流）、无 fatal/blocked 残留；
 *   观察者泄漏在可断言处断言（格 8 stop 路径：观察槽释放 + 观察流立即终止——
 *   FakeTransport 观察者为私有会话态不外露计数；完成态观察泵按设计保持，会话
 *   保活语义，非泄漏）。
 * - R-mx3（格 4 kill 语义）：守护 stop→start 用既有 daemon 测试模式——同
 *   stateDir 重建（token/pidfile/目标状态全部落盘复用）→ loadGoals + reconcile
 *   恢复。守护进程之死 ⇒ 其观察泵随之消失：FakeTransport 以显式会话死亡模拟
 *   （旧 pump 随 closed 退出释放观察槽，与真进程死亡后传输观察者消失同构），
 *   走 reconcile 重建分支（会话死 → start 复用 ref + 断点契约恰一次）。
 *
 * 纪律（对齐 daemon-goals.test.ts）：绝不触碰真实 HOME（stateDir 一律
 * .tmp/matrix-test/）；端口一律 0；env 显传 {}；runner 保持 R-rn1 纯 tick，
 * sweep 由用例手动驱动，不依赖真实定时器。
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, rm } from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../src/core/config";
import type { BridgeConfig } from "../src/core/config";
import { createDaemon, type DaemonHandle } from "../src/daemon";
import { GoalHost, type TickLoop } from "../src/daemon-goals";
import { buildPlugin } from "../src/server";
import type { DaemonFetcher, GoalPollLoop } from "../src/goal-tools";
import { FakeTransport } from "../src/core/transport/fake";
import { CONTINUE_PROMPT, ECHO_GUARD_MS } from "../src/core/goal/protocol";

/** 插件根目录（test/ 的上一级）。 */
const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
/** 本套件专属临时目录（.tmp/ 已 gitignore，用后即删）。 */
const TEST_ROOT = path.join(PLUGIN_ROOT, ".tmp", "matrix-test");

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

/* ───── 守护矩阵台架：FakeTransport + 假时钟 + 手动 TickLoop + 真实 HTTP 守护 ───── */

/** 注入时钟（R-rn1：时间唯一来源；格 4 经共享实例贯通两代守护）。 */
interface FakeClock {
  now(): number;
  advance(ms: number): void;
}

function makeFakeClock(start = 1_000_000): FakeClock {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** 手动循环句柄（用例驱动 sweep；wake 只计数不驱动——驱动权在用例手里）。 */
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
  clock: FakeClock;
  /** verifyRun 间谍：按调用序记录 argv（R-mx2 双过验收断言面）。 */
  verifyCalls: string[][];
  advance(ms: number): void;
}

interface HarnessOptions {
  /** 复用既有 stateDir（格 4 同 stateDir 重建）；缺省每台架独立目录。 */
  stateDir?: string;
  /** 复用既有 transport（格 4 跨守护共享 FakeTransport 会话表）。 */
  transport?: FakeTransport;
  /** 复用既有时钟（格 4 两代守护同一条时间线）。 */
  clock?: FakeClock;
  /** verifyRun 按次弹出的脚本结果；缺省恒过（测试台架约定，注释明示非兜底）。 */
  verifyScript?: Array<{ ok: boolean; out: string }>;
}

/** 组装并启动一套守护台架（goals 宿主接线 FakeTransport + 假时钟 + 手动循环）。 */
async function makeHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const stateDir = opts.stateDir ?? path.join(TEST_ROOT, `mx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  const cfg = loadConfig({ stateDir, daemonUrl: "http://127.0.0.1:0" }, {});
  const transport = opts.transport ?? new FakeTransport();
  const clock = opts.clock ?? makeFakeClock();
  const loop = makeManualLoop();
  const verifyCalls: string[][] = [];
  const script = opts.verifyScript !== undefined ? [...opts.verifyScript] : undefined;
  const host = new GoalHost({
    cfg,
    transport,
    clock,
    loop: loop.loop,
    verifyRun: async (cmd) => {
      verifyCalls.push(cmd);
      if (script === undefined || script.length === 0) return { ok: true, out: "OK" };
      return script.shift() as { ok: boolean; out: string };
    },
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
    token: await readFile(path.join(stateDir, "daemon-token"), "utf8"),
    loop,
    clock,
    verifyCalls,
    advance: (ms: number) => clock.advance(ms),
  };
}

/* ───── HTTP 助手（对齐 daemon-goals.test.ts 口径） ───── */

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

/** GET /health（免鉴权探活端点）。 */
async function healthOf(port: number): Promise<Record<string, unknown>> {
  return (await fetch(`http://127.0.0.1:${port}/health`).then((x) => x.json())) as Record<string, unknown>;
}

/** 建目标并完成首轮 sweep（引导：建会话 + 契约注入）。返回 goalId。 */
async function createGoal(h: Harness, body?: Record<string, unknown>): Promise<string> {
  const r = await call(h.port, "POST", "/goals", h.token, body ?? { objective: "矩阵目标" });
  expect(r.status).toBe(200);
  const goalId = (r.body as Record<string, string>)["goalId"] ?? "";
  expect(goalId).not.toBe("");
  await h.loop.sweepOnce(); // 引导 tick（建会话 + 注入契约）
  return goalId;
}

/** 全量读审计流（R-mx2 审计断言面；经公开 logs 分页端点，遍历至空页）。 */
async function readAllLogs(h: Harness, goalId: string): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  let cursor = 0;
  for (let guard = 0; guard < 100; guard++) {
    const r = await call(h.port, "GET", `/goals/${goalId}/logs?cursor=${cursor}&limit=200`, h.token);
    expect(r.status).toBe(200);
    const page = r.body as { events: Array<Record<string, unknown>>; nextCursor: number };
    events.push(...page.events);
    if (page.events.length === 0) return events;
    cursor = page.nextCursor;
  }
  throw new Error(`logs 分页未收敛（守卫溢出）：goalId=${goalId}`);
}

/**
 * 轮询读审计流直至谓词满足（测试基建的写可见性等待，非业务兜底）：sweep 路径的
 * appendAudit 为宿主队列异步落盘（GoalHost makeAuditSink），读盘断言需等 FS 写
 * 可见；control 路径响应前已冲刷无需等待。有界等待（setImmediate 轮转），超限
 * 显式失败——绝不静默放过缺失的审计事件。
 */
async function readLogsUntil(
  h: Harness,
  goalId: string,
  pred: (events: Array<Record<string, unknown>>) => boolean,
  desc: string,
): Promise<Array<Record<string, unknown>>> {
  let last: Array<Record<string, unknown>> = [];
  for (let i = 0; i < 200; i++) {
    last = await readAllLogs(h, goalId);
    if (pred(last)) return last;
    await new Promise<void>((r) => setImmediate(r));
  }
  throw new Error(`审计事件未在期限内可见：${desc}（最后共 ${last.length} 条）`);
}

/** 排空微任务管线（观察泵退出/观察槽释放的确定性等待；无真实定时器）。 */
async function flushMicrotasks(): Promise<void> {
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 16; i++) await Promise.resolve();
    await new Promise<void>((r) => setImmediate(r));
  }
}

/* ───── 插件层台架（格 5 专用：fake daemonFetch + ManualPollLoop，绝不联网） ───── */

/** add 捕获到的工具信息（同 goal-tools.test.ts 口径）。 */
interface CapturedTool {
  name: string;
  execute: (input: unknown, context: unknown) => Promise<unknown>;
}

/** 一次守护 HTTP 调用的捕获记录。 */
interface RecordedCall {
  url: string;
  method: string;
  authorization?: string;
  contentType?: string;
  bodyText?: string;
}

/** 手动驱动的插件轮询循环（GoalPollLoop 测试缝：不依赖真实 30s 定时器）。 */
interface ManualPluginLoop extends GoalPollLoop {
  readonly started: boolean;
  readonly stopped: boolean;
  fire(): Promise<void>;
}

function makePluginLoop(): ManualPluginLoop {
  let tick: (() => void | Promise<void>) | undefined;
  const flags = { started: false, stopped: false };
  return {
    start(t) {
      tick = t;
      flags.started = true;
    },
    stop() {
      flags.stopped = true;
      tick = undefined;
    },
    get started() {
      return flags.started;
    },
    get stopped() {
      return flags.stopped;
    },
    async fire() {
      await tick?.();
    },
  };
}

/** fake 宿主上下文（同 goal-tools.test.ts makeFakeContext，无 synthetic）。 */
function makePluginContext(): { ctx: unknown; added: CapturedTool[] } {
  const added: CapturedTool[] = [];
  const ctx = {
    options: {},
    permission: undefined,
    tool: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({
          add: (tool: CapturedTool) => {
            added.push(tool);
          },
        });
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx, added };
}

function asHostContext(ctx: unknown): Parameters<ReturnType<typeof buildPlugin>["setup"]>[0] {
  return ctx as Parameters<ReturnType<typeof buildPlugin>["setup"]>[0];
}

/** 插件实例（格 5：setup 可重跑——opencode 服务重启模拟）。 */
interface PluginInstance {
  calls: RecordedCall[];
  sessions: Map<string, string>;
  loop: ManualPluginLoop;
  added: CapturedTool[];
  cleanup: () => Promise<void>;
  tool(name: string): CapturedTool;
}

/**
 * 组装一个插件实例（R-g1/R-g3/R-g4 语义全走真插件路径，仅 fetch 注入 fake）。
 * stateDir 指向守护 stateDir：daemon-token 真实在场（daemonRequest 唯一 token 源，
 * 与生产同构——插件与守护经同一 stateDir 约定对接）。
 */
async function setupPluginInstance(h: Harness): Promise<PluginInstance> {
  const calls: RecordedCall[] = [];
  const sessions = new Map<string, string>();
  const loop = makePluginLoop();
  const fetcher: DaemonFetcher = async (url, init) => {
    const rec: RecordedCall = {
      url,
      method: init.method,
      authorization: init.headers["Authorization"],
      contentType: init.headers["Content-Type"],
      bodyText: init.body,
    };
    calls.push(rec);
    // fake 守护响应器：POST /goals → 固定 goalId（其余路径空对象，交由断言暴露）
    const body = rec.method === "POST" && rec.url.includes("/goals") ? { goalId: "g-reloaded" } : {};
    return { status: 200, json: async () => body };
  };
  const plugin = buildPlugin({
    configOverrides: {
      stateDir: h.cfg.stateDir,
      installDir: path.join(PLUGIN_ROOT, ".tmp", "matrix-plugin-install"),
      daemonUrl: `http://127.0.0.1:${h.port}`,
    },
    daemonFetch: fetcher,
    goalSessions: sessions,
    goalPollLoop: loop,
  });
  const { ctx, added } = makePluginContext();
  const cleanup = await plugin.setup(asHostContext(ctx));
  return {
    calls,
    sessions,
    loop,
    added,
    cleanup: async () => {
      await cleanup?.();
    },
    tool: (name) => {
      const t = added.find((x) => x.name === name);
      expect(t).toBeDefined();
      return t!;
    },
  };
}

/** 执行工具并解析 content[0] 的机器可读 JSON（R-t1 统一出口）。 */
async function executeToolJson(tool: CapturedTool, input: unknown, sessionID = "ses_origin"): Promise<Record<string, unknown>> {
  const result = (await tool.execute(input, {
    sessionID,
    agent: "build",
    messageID: "msg-1",
    id: "call-1",
  })) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

/* ═══════════════════════════ 八格矩阵 ═══════════════════════════ */

/* ───── 矩阵 1：模型错误连续重试——无限重试不停止直至完成 ───── */

describe("矩阵1：模型错误连续重试", () => {
  it("连续 4 次 retryable 模型错误（server 类）→ 无限重试不停止 → 第 5 信号起恢复 → complete", async () => {
    const h = await makeHarness();
    const goalId = await createGoal(h, { objective: "重试矩阵目标", verify: ["make check"] });
    const ref = h.transport.injections[0]!.ref;
    expect(h.transport.injections.length).toBe(1); // 引导契约恰 1 次

    // 错误 1：RetryEngine 首错立即重试（同 tick 排程并注入）
    h.transport.emit(ref, "output", "internal server error 500");
    await h.loop.sweepOnce();
    expect(h.transport.injections.length).toBe(2);
    // 错误 2~4：retryCapSeconds（60s）封顶间隔到期重试——次数无上限，任何一次都不终止
    for (let i = 2; i <= 4; i++) {
      h.transport.emit(ref, "output", "internal server error 500");
      await h.loop.sweepOnce(); // 消费错误并排程（未到期不注入）
      h.advance(60_000);
      await h.loop.sweepOnce(); // 到期 → 重注
      expect(h.transport.injections.length).toBe(1 + i);
    }
    // 重试注入全为全文契约（无进度 → 重发契约，C++ pumpRetry 语义）
    for (let i = 1; i < 5; i++) {
      expect(h.transport.injections[i]!.text).toContain("【/goal 目标契约】");
    }

    // 第 5 信号起恢复：步进 → done → 双过 → complete
    h.transport.emit(ref, "output", "[GOAL-STEP 1/2] 调研 | 推荐方案: A");
    await h.loop.sweepOnce();
    expect(h.transport.injections.length).toBe(5); // 恢复后不再注入
    h.advance(46_000); // 跨回显守卫窗（thresholds.echoGuardMs=45000，2026-11-01 热修）+1s // 越过回显守卫窗（下同）
    h.transport.emit(ref, "output", "[GOAL-STEP 2/2] 收尾 | 推荐方案: B");
    await h.loop.sweepOnce();
    h.advance(46_000); // 跨回显守卫窗（thresholds.echoGuardMs=45000，2026-11-01 热修）+1s
    h.transport.emit(ref, "output", "全部步骤完成\n[GOAL-DONE]");
    await h.loop.sweepOnce();

    const st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("complete");
    expect(st["rounds"]).toBe(5); // 契约 1 + 重试重注 4
    expect(st["steps"]).toEqual([1]);
    expect(await healthOf(h.port)).toMatchObject({ actives: 0 }); // 终态出册无残留

    // 审计关键项（R-mx2）：retry ×4（kind=server、consecutive 1..4）、无 fatal、complete 收尾
    const events = await readLogsUntil(h, goalId, (es) => es[es.length - 1]!["type"] === "goal.complete", "goal.complete 收尾");
    const retries = events.filter((e) => e["type"] === "goal.retry");
    expect(retries.map((e) => e["kind"])).toEqual(["server", "server", "server", "server"]);
    expect(retries.map((e) => e["consecutive"])).toEqual([1, 2, 3, 4]);
    expect(events.some((e) => e["fatal"] === true)).toBe(false);
    expect(events[events.length - 1]!["type"]).toBe("goal.complete");
  });
});

/* ───── 矩阵 2：网络类错误注入（ECONNRESET/timeout 事件）——同一无限重试语义 ───── */

describe("矩阵2：网络类错误注入", () => {
  it("transport error 信号（network/timeout 类）连续 3 次 → 不停止 → 恢复 → complete", async () => {
    const h = await makeHarness();
    const goalId = await createGoal(h, { objective: "网络故障矩阵目标", verify: ["make check"] });
    const ref = h.transport.injections[0]!.ref;
    const cases: Array<{ text: string; kind: string }> = [
      { text: "ECONNRESET", kind: "network" },
      { text: "ETIMEDOUT", kind: "timeout" },
      { text: "network error: fetch failed", kind: "network" },
    ];
    // 第 1 个 error 事件：立即重试
    h.transport.emit(ref, "error", cases[0]!.text);
    await h.loop.sweepOnce();
    expect(h.transport.injections.length).toBe(2);
    // 第 2、3 个：封顶间隔到期重试
    for (let i = 1; i < cases.length; i++) {
      h.transport.emit(ref, "error", cases[i]!.text);
      await h.loop.sweepOnce();
      h.advance(60_000);
      await h.loop.sweepOnce();
      expect(h.transport.injections.length).toBe(2 + i);
    }

    // 恢复路径：步进 → done → complete
    h.advance(46_000); // 跨回显守卫窗（thresholds.echoGuardMs=45000，2026-11-01 热修）+1s
    h.transport.emit(ref, "output", "[GOAL-STEP 1/1] 联调 | 推荐方案: A");
    await h.loop.sweepOnce();
    h.advance(46_000); // 跨回显守卫窗（thresholds.echoGuardMs=45000，2026-11-01 热修）+1s
    h.transport.emit(ref, "output", "完成\n[GOAL-DONE]");
    await h.loop.sweepOnce();

    const st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("complete");
    expect(st["rounds"]).toBe(4);

    // 审计：错误分类逐一对齐模式表（network/timeout/network）、无 fatal
    const events = await readLogsUntil(h, goalId, (es) => es[es.length - 1]!["type"] === "goal.complete", "goal.complete 收尾");
    expect(events.filter((e) => e["type"] === "goal.retry").map((e) => e["kind"])).toEqual([
      "network",
      "timeout",
      "network",
    ]);
    expect(events.some((e) => e["fatal"] === true)).toBe(false);
    expect(events[events.length - 1]!["type"]).toBe("goal.complete");
  });
});

/* ───── 矩阵 3：杀回合进程（alive=false）→ 重建会话 + 断点契约 → 续跑完成 ───── */

describe("矩阵3：杀回合进程", () => {
  it("外部杀会话 → goal.restart 审计 → start 复用 ref 重建 + 断点续跑契约 → 完成", async () => {
    const h = await makeHarness();
    const goalId = await createGoal(h, { objective: "进程死矩阵目标", verify: ["make check"] });
    const ref = h.transport.injections[0]!.ref;
    // 制造进度（断点契约判据：steps 非空）
    h.transport.emit(ref, "output", "[GOAL-STEP 1/2] 调研\n[GOAL-STEP 2/2] 实现 | 推荐方案: X");
    await h.loop.sweepOnce();
    let st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["steps"]).toEqual([1]);

    // 杀回合进程
    await h.transport.stop(ref);
    h.advance(1_000);
    await h.loop.sweepOnce(); // tick 第 4 步：alive=false → 进程死重建立即执行（不等 60s）

    // 断言：重建 + 断点契约 + ref 复用（传输重连语义）
    expect(h.transport.injections.length).toBe(2);
    expect(h.transport.injections[1]!.text).toContain("【/goal 断点续跑】");
    expect(h.transport.injections[1]!.ref.id).toBe(ref.id);
    const snap = await h.transport.snapshot(ref);
    expect(snap.meta["alive"]).toBe(true);
    st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("active");
    expect(st["rounds"]).toBe(2); // 契约 + 断点续跑

    // 续跑至完成
    h.advance(46_000); // 跨回显守卫窗（thresholds.echoGuardMs=45000，2026-11-01 热修）+1s
    h.transport.emit(ref, "output", "完成\n[GOAL-DONE]");
    await h.loop.sweepOnce();
    expect(h.transport.injections.length).toBe(2); // 重建后不再注入
    st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("complete");

    // 审计关键项
    const events = await readLogsUntil(h, goalId, (es) => es[es.length - 1]!["type"] === "goal.complete", "goal.complete 收尾");
    const restart = events.find((e) => e["type"] === "goal.restart") as Record<string, unknown>;
    expect(restart["reason"]).toBe("session-died");
    expect(events.filter((e) => e["type"] === "goal.start").length).toBe(1); // start 仅引导时一次
    expect(events[events.length - 1]!["type"]).toBe("goal.complete");
  });
});

/* ───── 矩阵 4：杀守护（stop→同 stateDir 重新 start）→ reconcile → 续跑完成（R-mx3） ───── */

describe("矩阵4：杀守护", () => {
  it("守护 A stop → 会话随之死 → 同 stateDir 重建守护 B：reconcile 重建+断点契约恰一次 → 完成（不双注入）", async () => {
    const stateDir = path.join(TEST_ROOT, "mx4-shared");
    const transport = new FakeTransport();
    const clock = makeFakeClock(); // 两代守护同一条时间线（M72 同源口径）
    const hA = await makeHarness({ stateDir, transport, clock });
    const goalId = await createGoal(hA, { objective: "杀守护矩阵目标", verify: ["make check"] });
    const ref = hA.transport.injections[0]!.ref;
    hA.transport.emit(ref, "output", "[GOAL-STEP 1/2] 调研\n[GOAL-STEP 2/2] 实现 | 推荐方案: X");
    await hA.loop.sweepOnce(); // 进度落盘（steps=[1]）

    // 杀守护：daemon.stop 摘 sweep 循环 + HTTP + pidfile（R-mx3 kill 语义）
    await hA.daemon.stop();
    // 守护进程之死 ⇒ 其传输观察泵随之消失：FakeTransport 以显式会话死亡模拟，
    // 排空微任务等旧 pump 退出释放观察槽（与真进程死亡后观察者消失同构）
    await transport.stop(ref);
    await flushMicrotasks();

    // 守护 B：同 stateDir 重建（token/pidfile/目标状态全部落盘复用）
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map((a) => String(a)).join(" "));
    };
    let hB: Harness;
    try {
      hB = await makeHarness({ stateDir, transport, clock });
    } finally {
      console.error = origError;
    }
    expect(errors.join("\n")).toContain("resumed=1"); // 对账恢复恰 1 个未终态目标

    // reconcile 重建：断点契约恰一次注入（幂等——原文契约不重发、不双注入）
    expect(transport.injections.length).toBe(2);
    expect(transport.injections[0]!.text).toContain("【/goal 目标契约】");
    expect(transport.injections[1]!.text).toContain("【/goal 断点续跑】");
    expect(transport.injections.filter((i) => i.text.includes("【/goal 目标契约】")).length).toBe(1);
    expect(transport.injections[1]!.ref.id).toBe(ref.id); // start 复用旧 ref

    // B 首轮 sweep：指纹在场 → 不重锚、不 nudge（不双注入）
    await hB.loop.sweepOnce();
    expect(transport.injections.length).toBe(2);

    let st = (await call(hB.port, "GET", `/goals/${goalId}`, hB.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("active");
    expect(st["rounds"]).toBe(2); // 契约 + reconcile 重建
    expect(st["steps"]).toEqual([1]); // 进度跨守护保留
    expect(st["strikes"]).toBe(1); // 重建计入循环保护（对账与 runner 同口径）

    // 续跑至完成
    hB.advance(ECHO_GUARD_MS + 1_000);
    hB.transport.emit(ref, "output", "完成\n[GOAL-DONE]");
    await hB.loop.sweepOnce();
    st = (await call(hB.port, "GET", `/goals/${goalId}`, hB.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("complete");
    expect(await healthOf(hB.port)).toMatchObject({ actives: 0 });

    // 审计：start 不重复（幂等）、reconcile 重建事件齐备、complete 收尾
    const events = await readLogsUntil(hB, goalId, (es) => es[es.length - 1]!["type"] === "goal.complete", "goal.complete 收尾");
    expect(events.filter((e) => e["type"] === "goal.start").length).toBe(1);
    const restart = events.find((e) => e["type"] === "goal.restart") as Record<string, unknown>;
    expect(restart["reason"]).toBe("reconcile-session-died");
    expect(events.some((e) => e["type"] === "goal.inject" && e["kind"] === "reconcile-rebuild")).toBe(true);
    expect(events[events.length - 1]!["type"]).toBe("goal.complete");
  });
});

/* ───── 矩阵 5：opencode 服务重启（插件 setup 重跑）→ 守护不受影响、工具恢复可用 ───── */

describe("矩阵5：opencode 服务重启（插件重载）", () => {
  it("插件实例 1 unload → 实例 2 setup：旧轮询清理、新工具可用、守护目标照常驱动至完成", async () => {
    const h = await makeHarness();
    const goalId = await createGoal(h, { objective: "插件重载不惊扰守护" });

    // 插件实例 1（fake fetch；stateDir=守护 stateDir → daemon-token 真实在场）
    const inst1 = await setupPluginInstance(h);
    expect(inst1.loop.started).toBe(true);

    // 宿主重启：unload（cleanup）→ setup 重跑（实例 2）
    await inst1.cleanup();
    expect(inst1.loop.stopped).toBe(true);
    const inst2 = await setupPluginInstance(h);
    expect(inst2.loop.started).toBe(true);
    expect(inst2.loop.stopped).toBe(false);

    // 工具恢复可用：实例 2 的 goal_start 经代理发出（fake fetch 捕获）+ 会话绑定登记（R-g4）
    const res = await executeToolJson(inst2.tool("goal_start"), { objective: "重载后的目标" });
    expect(res["goalId"]).toBe("g-reloaded");
    expect(inst2.calls.length).toBe(1);
    expect(inst2.calls[0]!.method).toBe("POST");
    expect(inst2.calls[0]!.url).toContain("/goals");
    expect(inst2.calls[0]!.authorization).toBe(`Bearer ${h.token}`); // 同一守护 token（同 stateDir）
    expect(inst2.sessions.get("g-reloaded")).toBe("ses_origin");
    // 旧实例已卸载：轮询 tick 摘除（fire 为无操作，不产生任何请求）
    await inst1.loop.fire();
    expect(inst1.calls.length).toBe(0);

    // 守护不受影响：health/在册目标/sweep 驱动循环全部照常
    expect(await healthOf(h.port)).toMatchObject({ ok: true, actives: 1 });
    let st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("active");
    h.advance(241_000); // 跨停滞阈值（stallSeconds=240，2026-11-01 热修）
    await h.loop.sweepOnce(); // 守护 sweep 循环仍在驱动（停滞续跑注入）
    expect(h.transport.injections.length).toBe(2);
    expect(h.transport.injections[1]!.text).toContain(CONTINUE_PROMPT);

    // 守护生命周期独立于插件重载：继续驱动至完成
    h.advance(46_000); // 跨回显守卫窗（thresholds.echoGuardMs=45000，2026-11-01 热修）+1s
    const ref = h.transport.injections[0]!.ref;
    h.transport.emit(ref, "output", "完成\n[GOAL-DONE]");
    await h.loop.sweepOnce();
    st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("complete");
    await inst2.cleanup(); // 实例 2 轮询清理（R-g3 unload 契约）
  });
});

/* ───── 矩阵 6：回显防护——注入含 [GOAL-DONE] 的回显不误判完成 ───── */

describe("矩阵6：回显防护", () => {
  it("守卫窗口内契约回显作废；窗外契约回显被剥离；真实申报才双过完成", async () => {
    const h = await makeHarness();
    const goalId = await createGoal(h, { objective: "回显防护矩阵目标", verify: ["make check"] });
    const ref = h.transport.injections[0]!.ref;
    const contract = h.transport.injections[0]!.text; // 契约正文含 [GOAL-DONE] 协议说明

    // (a) 注入后立即整段回显（守卫窗口内，TUI 回显含 [GOAL-DONE]）→ 守卫作废 done
    h.transport.emit(ref, "output", contract);
    await h.loop.sweepOnce();
    let st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("active");
    expect(h.verifyCalls.length).toBe(0); // 未触发验收
    expect(h.transport.injections.length).toBe(1); // 未误注入

    // (b) 守卫窗外整段契约回显 → stripInjectionEcho 剥离 → 同样不误判
    h.advance(46_000); // 跨回显守卫窗（thresholds.echoGuardMs=45000，2026-11-01 热修）+1s
    h.transport.emit(ref, "output", contract);
    await h.loop.sweepOnce();
    st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("active");
    expect(h.verifyCalls.length).toBe(0);
    expect(h.transport.injections.length).toBe(1);

    // (c) 真实完成申报（窗外、非回显文本）→ 双过 → complete
    h.advance(46_000); // 跨回显守卫窗（thresholds.echoGuardMs=45000，2026-11-01 热修）+1s
    h.transport.emit(ref, "output", "全部步骤完成\n[GOAL-DONE]");
    await h.loop.sweepOnce();
    st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("complete");
    expect(h.verifyCalls.length).toBe(1);
    expect(h.verifyCalls[0]).toEqual(["make", "check"]);

    // 审计：complete 恰一次（前两轮回显均未误判）
    const events = await readLogsUntil(
      h,
      goalId,
      (es) => es.filter((e) => e["type"] === "goal.complete").length === 1,
      "goal.complete 恰一次",
    );
    expect(events.filter((e) => e["type"] === "goal.complete").length).toBe(1);
  });
});

/* ───── 矩阵 7：双过验收——自报 done + verify 失败继续；再成功才 complete ───── */

describe("矩阵7：双过验收", () => {
  it("verify 首败 → 注入失败原因继续驱动；再次申报 + verify 过 → complete", async () => {
    const h = await makeHarness({
      verifyScript: [
        { ok: false, out: "1 test failed: 登录页快照不匹配" },
        { ok: true, out: "all passing" },
      ],
    });
    const goalId = await createGoal(h, { objective: "双过验收矩阵目标", verify: ["make check"] });
    const ref = h.transport.injections[0]!.ref;

    // 第一次自报完成 → verify 失败 → 注入失败原因继续（不终止、不 blocked）
    h.advance(46_000); // 跨回显守卫窗（thresholds.echoGuardMs=45000，2026-11-01 热修）+1s
    h.transport.emit(ref, "output", "全部完成\n[GOAL-DONE]");
    await h.loop.sweepOnce();
    let st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("active"); // 验收未过不完成
    expect(st["rounds"]).toBe(2);
    expect(h.transport.injections.length).toBe(2);
    expect(h.transport.injections[1]!.text).toContain("验收未通过");
    expect(h.transport.injections[1]!.text).toContain("登录页快照不匹配"); // 失败原因全文注入
    expect(h.transport.injections[1]!.text).toContain("[GOAL-DONE]"); // 驱动再次申报

    // 第二次自报 → verify 通过 → complete
    h.advance(46_000); // 跨回显守卫窗（thresholds.echoGuardMs=45000，2026-11-01 热修）+1s
    h.transport.emit(ref, "output", "已修复，全部完成\n[GOAL-DONE]");
    await h.loop.sweepOnce();
    st = (await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>;
    expect(st["phase"]).toBe("complete");
    expect(h.verifyCalls.length).toBe(2);
    expect(h.verifyCalls[1]).toEqual(["make", "check"]);

    // 审计：verify ok 序列 [false, true]；注入种类 [contract, verify-fail]
    const events = await readLogsUntil(h, goalId, (es) => es[es.length - 1]!["type"] === "goal.complete", "goal.complete 收尾");
    expect(events.filter((e) => e["type"] === "goal.verify").map((e) => e["ok"])).toEqual([false, true]);
    expect(events.filter((e) => e["type"] === "goal.inject").map((e) => e["kind"])).toEqual([
      "contract",
      "verify-fail",
    ]);
    expect(events[events.length - 1]!["type"]).toBe("goal.complete");
  });
});

/* ───── 矩阵 8：pause/resume/stop 在活跃目标上即时生效（三连击） ───── */

describe("矩阵8：pause/resume/stop 即时生效", () => {
  it("三连击：pause 冻结驱动 → resume 注入继续 → stop 终态，各状态断言 + 审计顺序 + 无泄漏", async () => {
    const h = await makeHarness();
    const goalId = await createGoal(h, { objective: "控制三连击目标" });
    const ref = h.transport.injections[0]!.ref;
    expect(await healthOf(h.port)).toMatchObject({ actives: 1 });

    // pause：响应载荷与状态同步翻转（即时生效）
    const paused = await call(h.port, "POST", `/goals/${goalId}/control`, h.token, { action: "pause" });
    expect(paused.status).toBe(200);
    expect(stateOf(paused)["phase"]).toBe("paused");
    // 暂停期 sweep 不注入（驱动冻结，R-dg2 契约）
    await h.loop.sweepOnce();
    expect(h.transport.injections.length).toBe(1);
    expect(
      ((await call(h.port, "GET", `/goals/${goalId}`, h.token)).body as Record<string, unknown>)["phase"],
    ).toBe("paused");

    // resume：转 active + 注入继续指令（恰 1 次）
    const resumed = await call(h.port, "POST", `/goals/${goalId}/control`, h.token, { action: "resume" });
    expect(resumed.status).toBe(200);
    expect(stateOf(resumed)["phase"]).toBe("active");
    expect(h.transport.injections.length).toBe(2);
    expect(h.transport.injections[1]!.text).toContain(CONTINUE_PROMPT);

    // 进度推进后 stop：终态 + 会话停止 + 出册
    h.advance(46_000); // 跨回显守卫窗（thresholds.echoGuardMs=45000，2026-11-01 热修）+1s
    h.transport.emit(ref, "output", "[GOAL-STEP 1/2] 调研 | 推荐方案: A");
    await h.loop.sweepOnce();
    const stopped = await call(h.port, "POST", `/goals/${goalId}/control`, h.token, { action: "stop" });
    expect(stopped.status).toBe(200);
    expect(stateOf(stopped)["phase"]).toBe("stopped");
    expect(await h.transport.alive(ref)).toBe(false); // 会话停止
    expect(await healthOf(h.port)).toMatchObject({ actives: 0 }); // 出册无残留

    // 终态后：sweep 无注入；control 显式 409（终态只读）
    await h.loop.sweepOnce();
    expect(h.transport.injections.length).toBe(2);
    const again = await call(h.port, "POST", `/goals/${goalId}/control`, h.token, { action: "resume" });
    expect(again.status).toBe(409);
    expect(errCode(again)).toBe("GOAL_TERMINAL_STATE");

    // 泄漏检查（R-mx2 可断言处）：观察槽已释放（不抛 OBSERVER_ACTIVE）且观察流立即终止
    await flushMicrotasks();
    const postStop = h.transport.observe(ref)[Symbol.asyncIterator]();
    expect((await postStop.next()).done).toBe(true);

    // 审计序列关键项：pause → resume → stop 顺序齐备，stop 收尾
    // （control 路径响应前已冲刷审计；readLogsUntil 只作可见性统一入口）
    const events = await readLogsUntil(h, goalId, (es) => es[es.length - 1]!["type"] === "goal.stop", "goal.stop 收尾");
    const types = events.map((e) => e["type"]);
    expect(types).toContain("goal.pause");
    expect(types).toContain("goal.resume");
    expect(types).toContain("goal.stop");
    expect(types.indexOf("goal.pause")).toBeLessThan(types.indexOf("goal.resume"));
    expect(types.indexOf("goal.resume")).toBeLessThan(types.indexOf("goal.stop"));
    expect(events[events.length - 1]!["type"]).toBe("goal.stop");
  });
});
