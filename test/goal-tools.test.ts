/**
 * 插件目标工具与回呼测试（T3-06，TDD）。
 *
 * 覆盖（任务书 Step1 + 主控裁定 R-g1..R-g4，逐条）：
 * - R-g1（薄代理）：goal_start/status/list/logs/control 经 daemonUrl HTTP 代理守护
 *   API（Bearer daemon-token）；守护结构化错误（含 501 GOAL_HOST_DISABLED）原样
 *   透传（code/message/remediation 三字段经 R-t1 出口落 content）；
 * - R-g2（不可达显式）：fetch 失败（ECONNREFUSED/超时/token 缺失）→
 *   DAEMON_UNAVAILABLE（remediation 含 `codearts-bridge daemon` 启动指引）；
 *   无静默兜底、不自动启动守护；
 * - R-g3（回呼尽力通知）：轮询 30s（setup 注册、unload 清理）；目标终态/告警
 *   （对比上次快照）→ ctx.session.synthetic 恰好一次；session 缺失→仅审计；
 *   通知失败仅审计不阻塞；
 * - R-g4（会话绑定）：goal_start 把发起 sessionID 以 initiatedBy 透传守护请求体。
 *
 * 隔离：daemonFetch 注入 fake（绝不联网）；goalPollLoop 注入手动驱动（绝不真等
 * 30s）；stateDir 为工作目录内 .tmp/（用后即删）；绝不触碰真实 HOME。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { buildPlugin } from "../src/server";
import { GOAL_POLL_INTERVAL_MS } from "../src/goal-tools";
import type { DaemonFetcher, GoalPollLoop } from "../src/goal-tools";

/* ───── 测试环境装配 ───── */

/** 测试用临时根（工作目录内 .tmp/，afterEach 统一清理，禁系统临时目录）。 */
const TMP_ROOT = path.join(import.meta.dir, ".tmp", "t19");
mkdirSync(TMP_ROOT, { recursive: true });

let root: string | undefined;
let seq = 0;

/** 每用例独立目录（含 state/；token 由用例按需写入）。 */
function makeRoot(): { root: string; stateDir: string } {
  seq += 1;
  const r = path.join(TMP_ROOT, `case-${seq}`);
  const stateDir = path.join(r, "state");
  mkdirSync(stateDir, { recursive: true });
  root = r;
  return { root: r, stateDir };
}

afterEach(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

/** 写入 daemon-token（守护首启产物的最小替身；readDaemonToken 按同一路径约定读取）。 */
function writeToken(stateDir: string, token = "test-token"): void {
  writeFileSync(path.join(stateDir, "daemon-token"), token, "utf8");
}

/** 一次守护 HTTP 调用的捕获记录（只取断言关心的字段）。 */
interface RecordedCall {
  url: string;
  method: string;
  authorization?: string;
  contentType?: string;
  bodyText?: string;
}

/** fake 守护响应器：输入捕获调用、输出 {status, body}；抛错=模拟连接失败。 */
type FakeResponder = (call: RecordedCall) => { status: number; body: unknown };

/** 注入式 fake fetch（捕获 URL/method/头/体；绝不联网）。 */
function makeFakeDaemon(respond: FakeResponder): { fetcher: DaemonFetcher; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetcher: DaemonFetcher = async (url, init) => {
    const rec: RecordedCall = {
      url,
      method: init.method,
      authorization: init.headers["Authorization"],
      contentType: init.headers["Content-Type"],
      bodyText: init.body,
    };
    calls.push(rec);
    return { status: respond(rec).status, json: async () => respond(rec).body };
  };
  return { fetcher, calls };
}

/** add 被调用时捕获到的工具信息（同 server.test.ts 口径）。 */
interface CapturedTool {
  name: string;
  options?: { namespace?: string };
  execute: (input: unknown, context: unknown) => Promise<unknown>;
}

type SyntheticSpy = (input: { sessionID: string; text: string }) => Promise<unknown>;

/** 带 session 域的 fake 宿主上下文（synthetic 缺省=宿主未提供通知通道）。 */
function makeFakeContext(opts: { synthetic?: SyntheticSpy } = {}): { ctx: unknown; added: CapturedTool[] } {
  const added: CapturedTool[] = [];
  const ctx = {
    options: {},
    permission: undefined,
    ...(opts.synthetic !== undefined ? { session: { synthetic: opts.synthetic } } : {}),
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

/** 手动驱动的轮询循环（R-g3 测试缝：不依赖真实 30s 定时器）。 */
interface ManualLoop extends GoalPollLoop {
  readonly started: boolean;
  readonly stopped: boolean;
  fire(): Promise<void>;
}

function makeManualLoop(): ManualLoop {
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

/** 插件测试夹具：隔离配置 + fake fetch + 共享会话表 + 手动轮询循环。 */
interface Harness {
  stateDir: string;
  added: CapturedTool[];
  sessions: Map<string, string>;
  calls: RecordedCall[];
  loop: ManualLoop;
  cleanup: () => Promise<void>;
  tool(name: string): CapturedTool;
}

async function makeHarness(opts: {
  respond: FakeResponder;
  synthetic?: SyntheticSpy;
  writeTokenFile?: boolean;
}): Promise<Harness> {
  const { root: r, stateDir } = makeRoot();
  if (opts.writeTokenFile !== false) writeToken(stateDir);
  const sessions = new Map<string, string>();
  const loop = makeManualLoop();
  const { fetcher, calls } = makeFakeDaemon(opts.respond);
  const plugin = buildPlugin({
    configOverrides: {
      stateDir,
      installDir: path.join(r, "installers"),
      daemonUrl: "http://127.0.0.1:4599",
    },
    daemonFetch: fetcher,
    goalSessions: sessions,
    goalPollLoop: loop,
  });
  const { ctx, added } = makeFakeContext({ synthetic: opts.synthetic });
  const cleanup = await plugin.setup(asHostContext(ctx));
  return {
    stateDir,
    added,
    sessions,
    calls,
    loop,
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
async function executeJson(
  tool: CapturedTool,
  input: unknown,
  sessionID = "ses_origin",
): Promise<Record<string, unknown>> {
  const result = (await tool.execute(input, {
    sessionID,
    agent: "build",
    messageID: "msg-1",
    id: "call-1",
  })) as { content: Array<{ type: string; text: string }> };
  return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
}

/** 读审计流（<stateDir>/audit/install.jsonl）为对象数组；文件不存在=空数组。 */
function auditEntries(stateDir: string): Array<Record<string, unknown>> {
  let text: string;
  try {
    text = readFileSync(path.join(stateDir, "audit", "install.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/* ───── R-g1/R-g2：守护 HTTP 薄代理 ───── */

describe("codearts_goal_* 守护薄代理（R-g1/R-g2）", () => {
  it("goal_start 代理 POST /goals：Bearer token、R-g4 initiatedBy 透传、返回 goalId 并登记发起会话", async () => {
    const h = await makeHarness({ respond: () => ({ status: 200, body: { goalId: "gabc-123" } }) });
    const payload = await executeJson(h.tool("goal_start"), {
      objective: "修复编译错误",
      verify: ["bun test"],
    });
    expect(payload.goalId).toBe("gabc-123");
    expect(h.calls).toHaveLength(1);
    const c = h.calls[0]!;
    expect(c.method).toBe("POST");
    expect(c.url).toBe("http://127.0.0.1:4599/goals");
    expect(c.authorization).toBe("Bearer test-token");
    expect(c.contentType).toBe("application/json");
    const body = JSON.parse(c.bodyText!) as Record<string, unknown>;
    expect(body.objective).toBe("修复编译错误");
    expect(body.verify).toEqual(["bun test"]);
    expect(body.initiatedBy).toBe("ses_origin"); // R-g4：发起会话透传守护（守护侧前向容忍未知字段）
    expect(h.sessions.get("gabc-123")).toBe("ses_origin"); // R-g3：本地登记发起会话（回呼通知目标）
    await h.cleanup();
  });

  it("daemon 连接失败 → DAEMON_UNAVAILABLE（remediation 含 codearts-bridge daemon 启动指引，R-g2）", async () => {
    const h = await makeHarness({
      respond: () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:4599");
      },
    });
    const payload = await executeJson(h.tool("goal_start"), { objective: "x" });
    const err = payload.error as Record<string, unknown>;
    expect(err.code).toBe("DAEMON_UNAVAILABLE");
    expect(String(err.message)).toContain("ECONNREFUSED");
    expect(String(err.remediation)).toContain("codearts-bridge daemon");
    await h.cleanup();
  });

  it("守护 501 GOAL_HOST_DISABLED 原样透传（含 remediation，R-g1）", async () => {
    const h = await makeHarness({
      respond: () => ({
        status: 501,
        body: {
          error: {
            code: "GOAL_HOST_DISABLED",
            message: "守护未挂载目标域宿主（GoalHost），/goals* 端点不可用",
            remediation: "以 createDaemon(cfg, hooks, goals) 挂载 GoalHost 后启动。",
          },
        },
      }),
    });
    const payload = await executeJson(h.tool("goal_list"), {});
    const err = payload.error as Record<string, unknown>;
    expect(err.code).toBe("GOAL_HOST_DISABLED");
    expect(err.message).toBe("守护未挂载目标域宿主（GoalHost），/goals* 端点不可用");
    expect(err.remediation).toBe("以 createDaemon(cfg, hooks, goals) 挂载 GoalHost 后启动。");
    await h.cleanup();
  });

  it("goal_status/list/logs/control 代理路径、查询串与控制体（R-g1）", async () => {
    const h = await makeHarness({
      respond: (c) => {
        if (c.method === "GET" && c.url.endsWith("/goals/g-1")) {
          return { status: 200, body: { goalId: "g-1", phase: "active", rounds: 2, strikes: 0 } };
        }
        if (c.method === "GET" && c.url.endsWith("/goals")) return { status: 200, body: [] };
        if (c.method === "GET" && c.url.endsWith("/goals/g-1/logs?cursor=3&limit=10")) {
          return { status: 200, body: { goalId: "g-1", events: [], nextCursor: 3 } };
        }
        if (c.method === "GET" && c.url.endsWith("/goals/g-1/logs")) {
          return { status: 200, body: { goalId: "g-1", events: [], nextCursor: 0 } };
        }
        if (c.method === "POST" && c.url.endsWith("/goals/g-1/control")) {
          return { status: 200, body: { state: { goalId: "g-1", phase: "paused" } } };
        }
        throw new Error(`fake daemon 未预期调用：${c.method} ${c.url}`);
      },
    });
    const status = await executeJson(h.tool("goal_status"), { goalId: "g-1" });
    expect(status.phase).toBe("active");

    const list = await executeJson(h.tool("goal_list"), {});
    expect(Array.isArray(list)).toBe(true);

    const page = await executeJson(h.tool("goal_logs"), { goalId: "g-1", cursor: 3, limit: 10 });
    expect(page.nextCursor).toBe(3);
    const bare = await executeJson(h.tool("goal_logs"), { goalId: "g-1" });
    expect(bare.nextCursor).toBe(0);

    const ctrl = await executeJson(h.tool("goal_control"), { goalId: "g-1", action: "resume" });
    const ctrlState = ctrl.state as Record<string, unknown>;
    expect(ctrlState.phase).toBe("paused");
    const ctrlCall = h.calls.find((c) => c.url.endsWith("/goals/g-1/control"))!;
    expect(ctrlCall.method).toBe("POST");
    expect(JSON.parse(ctrlCall.bodyText!)).toEqual({ action: "resume" });
    await h.cleanup();
  });

  it("非法输入就地报错且不发起请求：goalId 路径穿越→GOAL_ID_INVALID、action 非法→TOOL_INPUT_INVALID", async () => {
    const h = await makeHarness({ respond: () => ({ status: 200, body: {} }) });
    const badId = await executeJson(h.tool("goal_status"), { goalId: "../etc/passwd" });
    expect((badId.error as Record<string, unknown>).code).toBe("GOAL_ID_INVALID");
    const badAction = await executeJson(h.tool("goal_control"), { goalId: "g-1", action: "purge" });
    expect((badAction.error as Record<string, unknown>).code).toBe("TOOL_INPUT_INVALID");
    expect(h.calls).toHaveLength(0);
    await h.cleanup();
  });

  it("daemon_status 透传 /health 健康载荷", async () => {
    const h = await makeHarness({
      respond: (c) => {
        if (c.method === "GET" && c.url.endsWith("/health")) {
          return { status: 200, body: { ok: true, version: "dev", uptime: 1.5, actives: 2 } };
        }
        throw new Error(`fake daemon 未预期调用：${c.method} ${c.url}`);
      },
    });
    const payload = await executeJson(h.tool("daemon_status"), {});
    expect(payload.ok).toBe(true);
    expect(payload.actives).toBe(2);
    await h.cleanup();
  });

  it("daemon_status 不可达 → DAEMON_UNAVAILABLE（显式指引，不静默假装，R-g2）", async () => {
    const h = await makeHarness({
      respond: () => {
        throw new Error("connect ECONNREFUSED 127.0.0.1:4599");
      },
    });
    const payload = await executeJson(h.tool("daemon_status"), {});
    const err = payload.error as Record<string, unknown>;
    expect(err.code).toBe("DAEMON_UNAVAILABLE");
    expect(String(err.remediation)).toContain("codearts-bridge daemon");
    await h.cleanup();
  });

  it("daemon-token 缺失 → DAEMON_UNAVAILABLE（守护从未启动；消息含 token 路径）", async () => {
    const h = await makeHarness({
      respond: () => ({ status: 200, body: {} }),
      writeTokenFile: false,
    });
    const payload = await executeJson(h.tool("goal_list"), {});
    const err = payload.error as Record<string, unknown>;
    expect(err.code).toBe("DAEMON_UNAVAILABLE");
    expect(String(err.message)).toContain("daemon-token");
    expect(h.calls).toHaveLength(0); // 无 token 时根本不应发起 HTTP
    await h.cleanup();
  });
});

/* ───── R-g3：目标回呼轮询（尽力通知，非投递保证） ───── */

describe("目标回呼轮询（R-g3）", () => {
  it("GOAL_POLL_INTERVAL_MS 缺省 30s（轮询节拍唯一真相）", () => {
    expect(GOAL_POLL_INTERVAL_MS).toBe(30000);
  });

  it("setup 注册轮询、unload 清理（R-g3）", async () => {
    const h = await makeHarness({ respond: () => ({ status: 200, body: [] }) });
    expect(h.loop.started).toBe(true);
    await h.cleanup();
    expect(h.loop.stopped).toBe(true);
  });

  it("终态事件后 synthetic 恰好调用一次（快照对比不重复通知）", async () => {
    let listBody: unknown = [{ goalId: "g-1", state: "active", rounds: 1, strikes: 0, objective: "写文档" }];
    const synCalls: Array<{ sessionID: string; text: string }> = [];
    const h = await makeHarness({
      respond: (c) => {
        if (c.method === "POST" && c.url.endsWith("/goals")) return { status: 200, body: { goalId: "g-1" } };
        if (c.method === "GET" && c.url.endsWith("/goals")) return { status: 200, body: listBody };
        throw new Error(`fake daemon 未预期调用：${c.method} ${c.url}`);
      },
      synthetic: async (input) => {
        synCalls.push(input);
      },
    });
    await executeJson(h.tool("goal_start"), { objective: "写文档" });
    await h.loop.fire(); // active：记录基线，不通知
    expect(synCalls).toHaveLength(0);
    listBody = [{ goalId: "g-1", state: "complete", rounds: 5, strikes: 0, objective: "写文档" }];
    await h.loop.fire(); // 终态：通知恰一次
    expect(synCalls).toHaveLength(1);
    expect(synCalls[0]!.sessionID).toBe("ses_origin");
    expect(synCalls[0]!.text).toContain("已完成");
    expect(synCalls[0]!.text).toContain("g-1");
    await h.loop.fire(); // 仍为终态：不重复通知
    expect(synCalls).toHaveLength(1);
    const notify = auditEntries(h.stateDir).find((e) => e["kind"] === "goal.notify");
    expect(notify).toBeDefined();
    expect(notify!["goalId"]).toBe("g-1");
    await h.cleanup();
  });

  it("session 缺失（goalId 不在会话表）→ 仅审计不通知", async () => {
    const synCalls: Array<{ sessionID: string; text: string }> = [];
    let listBody: unknown = [{ goalId: "g-9", state: "active", rounds: 3, strikes: 0, objective: "别处发起的目标" }];
    const h = await makeHarness({
      respond: () => ({ status: 200, body: listBody }),
      synthetic: async (input) => {
        synCalls.push(input);
      },
    });
    // 会话表非空（保证轮询运行）但不含 g-9：模拟发起实例重载后映射丢失的形态
    h.sessions.set("g-lost", "ses_gone");
    await h.loop.fire(); // active：基线
    expect(synCalls).toHaveLength(0);
    listBody = [{ goalId: "g-9", state: "blocked", rounds: 3, strikes: 0, objective: "别处发起的目标" }];
    await h.loop.fire(); // blocked 升级 → 尝试通知 → 会话未知 → 仅审计
    expect(synCalls).toHaveLength(0);
    const skipped = auditEntries(h.stateDir).find((e) => e["kind"] === "goal.notify-skipped");
    expect(skipped).toBeDefined();
    expect(skipped!["goalId"]).toBe("g-9");
    expect(skipped!["reason"]).toBe("session-unknown");
    await h.cleanup();
  });

  it("本实例未发起任何目标时跳过网络轮询（零通知对象）", async () => {
    const h = await makeHarness({
      respond: () => {
        throw new Error("不应发起任何请求");
      },
      synthetic: async () => undefined,
    });
    await h.loop.fire();
    expect(h.calls).toHaveLength(0);
    await h.cleanup();
  });

  it("通知失败（synthetic 抛错）→ 仅审计不阻塞，后续目标照常尝试", async () => {
    let listBody: unknown = [{ goalId: "g-1", state: "complete", rounds: 2, strikes: 0, objective: "A" }];
    let attempts = 0;
    const h = await makeHarness({
      respond: (c) => {
        if (c.method === "GET" && c.url.endsWith("/goals")) return { status: 200, body: listBody };
        throw new Error(`fake daemon 未预期调用：${c.method} ${c.url}`);
      },
      synthetic: async () => {
        attempts += 1;
        throw new Error("session 已关闭");
      },
    });
    h.sessions.set("g-1", "ses_origin");
    await h.loop.fire();
    expect(attempts).toBe(1);
    const failed = auditEntries(h.stateDir).find((e) => e["kind"] === "goal.notify-failed");
    expect(failed).toBeDefined();
    expect(String(failed!["message"])).toContain("session 已关闭");
    listBody = [
      { goalId: "g-1", state: "complete", rounds: 2, strikes: 0, objective: "A" },
      { goalId: "g-2", state: "stopped", rounds: 1, strikes: 0, objective: "B" },
    ];
    h.sessions.set("g-2", "ses_origin");
    await h.loop.fire(); // 不阻塞：第二个目标照常尝试通知
    expect(attempts).toBe(2);
    await h.cleanup();
  });

  it("strikes 达阈值告警通知（active 相位、对比快照升级触发）", async () => {
    let listBody: unknown = [{ goalId: "g-1", state: "active", rounds: 4, strikes: 1, objective: "调参" }];
    const synCalls: Array<{ sessionID: string; text: string }> = [];
    const h = await makeHarness({
      respond: () => ({ status: 200, body: listBody }),
      synthetic: async (input) => {
        synCalls.push(input);
      },
    });
    h.sessions.set("g-1", "ses_origin");
    await h.loop.fire(); // strikes=1 < 阈值 3：基线
    expect(synCalls).toHaveLength(0);
    listBody = [{ goalId: "g-1", state: "active", rounds: 4, strikes: 3, objective: "调参" }];
    await h.loop.fire(); // strikes=3 达阈值：告警通知
    expect(synCalls).toHaveLength(1);
    expect(synCalls[0]!.text).toContain("无进展");
    await h.cleanup();
  });
});
