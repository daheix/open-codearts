/**
 * codearts-bridge 守护进程骨架与 HTTP API（T3-01 骨架 + T3-05 目标域接线）。
 *
 * 职责（任务书 T3-01/T3-05 + 主控裁定 R-d1~R-d4、R-dg1~R-dg5）：
 * - 仅绑 127.0.0.1 的 HTTP 宿主——"目标永不挂起"承诺的宿主进程骨架；
 *   T3-05 起 /goals* 端点经可选挂载的 GoalHost（daemon-goals.ts）提供目标域。
 * - token 鉴权 + GET /health 健康端点；生命周期 start/stop（幂等）。
 * - daemon.pid 单守护前提固化（R-dg5-③/M69：状态层锁表为进程内 Map，双守护
 *   会双对账双注入——pidfile 在启动路径显式断言唯一性）。
 *
 * 主控裁定落点（SDD 2026-10-31，逐条；实现处再注）：
 * - R-d1（网络面）：绑定地址恒为 127.0.0.1（硬编码，不受 daemonUrl 主机名影响——
 *   守护是本机单用户服务，网络面必须最小化，暴露面裁定的权威来源是裁定而非配置）。
 *   端口取 cfg.daemonUrl 的端口部分：loadConfig 已对 daemonUrl 做合法性校验并默认
 *   "http://127.0.0.1:4577"，故"端口默认 4577 可配（loadConfig 覆盖）"经 daemonUrl
 *   的端口段实现（不新增第二个端口配置真相源）；端口 0 → 内核随机分配，实际端口
 *   经 start() 返回（任务书接口：start(): Promise<{port}>）。
 * - R-d2（token）：<stateDir>/daemon-token 首启自动生成（crypto.randomBytes(32)
 *   .toString("hex")）、mode 0600、重启复用；请求鉴权 Authorization: Bearer <token>；
 *   缺失/错误 → 401 结构化 JSON。复用路径显式 chmod 0600（幂等收紧，防外部工具
 *   放宽过权限；0600 本位为 no-op）。比较用 timingSafeEqual（常量时间，防时序侧信道）。
 * - R-d3（路由语义）：GET /health 免鉴权 → {ok, version, uptime, actives}。设计依据：
 *   健康探测不得要求凭据——systemd watchdog/监控脚本若须先读 token 才能探活，
 *   token 文件一旦损坏即探活死锁（watchdog 杀守护的判据失灵），探活通道必须零依赖；
 *   端点只回静态摘要（版本+运行秒数+活跃目标数），无凭据外泄面（T3-05 增 actives，
 *   spec §7.2 契约字段）。未知路由 → 404 结构化 {error:{code:"NOT_FOUND"}}；其余
 *   一切请求（含非 GET 打 /health）一律先过鉴权再路由——未鉴权者无从探测路由
 *   存在性，也拿不到 404 信息面。
 * - R-d4（生命周期）：start 幂等——进行中/已完成的 start 复用同一次 listen（监督
 *   循环与 CLI 可能重复触发 start，"拒绝"语义制造竞态脆弱点，"复用"与幂等恢复
 *   语义一致，此处为显式选择而非兜底）；stop 关闭监听并先斩断全部 keep-alive
 *   连接（否则活动连接令 close 回调悬挂，bun test 进程不退出）；stop 对未启动态
 *   幂等空操作，stop 后可再次 start（token 重启复用语义的重启路径）。
 * - R-d6（T3-04 启动对账缝）：DaemonHooks.reconcileOnStart 为测试缝——挂载
 *   GoalHost 时透传给它做对账实现替换；未挂载 GoalHost 且钩子在场的旧路径保持
 *   兼容。GoalHost 在场时由其以真实传输 + 注入时钟执行对账（M72：对账与 runner
 *   同一时间线），失败显式拒绝 start（状态层坏即不带病服务）。
 * - R-dg1~R-dg4（T3-05 目标域）：领域逻辑在 daemon-goals.ts（GoalHost），本文件
 *   只做 HTTP 形态：路由解析、请求体读取（1MB 上限）、BridgeError → HTTP 状态
 *   映射、统一 JSON 响应。GoalHost 缺省未挂载时 /goals* → 501 GOAL_HOST_DISABLED
 *   （显式声明功能未接线，禁静默假装存在；生产装配归守护服务任务 T3-07）。
 * - R-dg5-③（pidfile，M69 单守护前提）：<stateDir>/daemon.pid——start 时
 *   O_EXCL 独占创建写入自身 pid；已存在且指向活进程 → DAEMON_ALREADY_RUNNING
 *   显式拒绝（防双守护双对账）；指向死进程（ESRCH）或本进程残留 → 陈旧清除
 *   覆写（stderr 留痕）；内容非法 → DAEMON_PIDFILE_INVALID 显式报错（不代删
 *   ——内容损坏可能是外部工具写入，删除属用户决策）。stop 时仅当内容为自身
 *   pid 才清除；清除失败 stderr 可见、不阻断停止（残留文件按陈旧语义在下次
 *   启动自愈——显式登记的收尾决策，非静默吞错）。
 *
 * 错误纪律（仓库铁律：出错即显式报错，禁静默兜底）：
 * - FS/listen 失败统一 BridgeError 显式上抛（DAEMON_LISTEN_FAILED /
 *   DAEMON_TOKEN_INVALID / FS_READ_FAILED），消息含路径与原因码；
 * - token 文件存在但为空 → DAEMON_TOKEN_INVALID（拒绝空令牌，绝不静默重新生成——
 *   重新生成会使其他已缓存令牌的客户端静默失联，属掩盖问题的兜底行为）；
 * - 所有 HTTP 响应（含错误）均为 application/json 结构化，无文本态响应。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, open as fsOpen, readFile, unlink } from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import type { BridgeConfig } from "./core/config";
import { PLUGIN_VERSION, ensureStateDirs } from "./core/config";
import { BridgeError } from "./core/errors";
import { atomicWriteFile, errnoOf } from "./core/fsx";
import type { ReconcileResult } from "./core/goal/state";
import type { GoalHost } from "./daemon-goals";
import { ViewRegistry } from "./core/view-registry";

/** token 文件名（位于状态根，与裁定 <stateDir>/daemon-token 一致；mode 0600）。 */
const TOKEN_FILE_NAME = "daemon-token";

/** pid 文件名（R-dg5-③：单守护前提固化；mode 0600）。 */
const PID_FILE_NAME = "daemon.pid";

/** daemonUrl 未写端口段时的默认端口（与 loadConfig 的 DEFAULT_DAEMON_URL 口径一致）。 */
const DEFAULT_DAEMON_PORT = 4577;

/** 请求体字节上限（goals 写路径防拖垮守护；超出显式 400）。 */
const MAX_BODY_BYTES = 1_000_000;

/** 守护句柄（任务书接口：createDaemon(cfg) 返回形态）。 */
export interface DaemonHandle {
  /** 底层 HTTP server（createDaemon 时创建、未监听；测试/上层可断言其形态）。 */
  server: http.Server;
  /** 启动监听；幂等复用；返回实际端口（port 0 → 内核分配值）。 */
  start(): Promise<{ port: number }>;
  /** 停止监听并斩断全部 keep-alive 连接；未启动时空操作；之后可再次 start。 */
  stop(): Promise<void>;
}

/** 守护可选钩子（T3-04）：启动对账缝（T3-05 起作为 GoalHost 对账实现的替换缝）。 */
export interface DaemonHooks {
  /**
   * 启动对账：token 就绪后、listen 之前以 cfg.stateDir 调用恰一次；抛错即
   * start 显式失败（R-d6：状态层坏不带病服务）。挂载 GoalHost 时本钩子透传给
   * GoalHost.start 作对账实现替换（测试缝）；未挂载 GoalHost 时保持旧路径
   * 直接调用并落启动摘要。
   */
  reconcileOnStart?(stateDir: string): Promise<ReconcileResult>;
}

/* ───── 配置派生（R-d1） ───── */

/**
 * 从 daemonUrl 提取监听端口：端口段缺省（含协议默认端口被 URL 归一为空串）→ 4577；
 * "0" 保留（随机端口）；其余须为 0~65535 整数，非法显式抛错。
 * daemonUrl 的合法性与协议校验由 loadConfig 负责（唯一校验点），此处只做端口派生。
 */
export function daemonPortOf(daemonUrl: string): number {
  const url = new URL(daemonUrl); // loadConfig 已校验；形态非法属编程错误，任其抛 TypeError
  if (url.port === "") return DEFAULT_DAEMON_PORT;
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new BridgeError(
      "DAEMON_CONFIG_INVALID",
      `daemonUrl 端口段非法（须为 0~65535 整数）：${JSON.stringify(url.port)}`,
    );
  }
  return port;
}

/* ───── token（R-d2） ───── */

/** token 文件绝对路径（<stateDir>/daemon-token）。 */
export function daemonTokenPath(cfg: BridgeConfig): string {
  return path.join(cfg.stateDir, TOKEN_FILE_NAME);
}

/**
 * 载入或首启生成 token：存在 → 读入（trim 后非空才收，空文件显式报错）并收紧
 * mode 0600；不存在（ENOENT）→ randomBytes(32).hex 经 atomicWriteFile 原子写入
 * （mode 0600，umask 无关）。其他读错误（EACCES/EISDIR 等）显式抛出。
 */
async function loadOrCreateToken(cfg: BridgeConfig): Promise<string> {
  const tokenPath = daemonTokenPath(cfg);
  let content: string;
  try {
    content = await readFile(tokenPath, "utf8");
  } catch (e) {
    if (errnoOf(e) !== "ENOENT") {
      const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
      throw new BridgeError(
        "FS_READ_FAILED",
        `读取 daemon-token 失败：path=${tokenPath} reason=${reason}`,
        { cause: e },
      );
    }
    // 首启：生成（R-d2 固定算法）并原子落盘；内存值与文件同源，重启复用即重读该文件
    const token = randomBytes(32).toString("hex");
    await atomicWriteFile(tokenPath, token, 0o600);
    return token;
  }
  const token = content.trim();
  if (token.length === 0) {
    throw new BridgeError(
      "DAEMON_TOKEN_INVALID",
      `daemon-token 文件为空（拒绝空令牌）：path=${tokenPath}`,
      { remediation: "删除该文件后重启守护进程即可重新生成" },
    );
  }
  // 复用路径：显式收紧 0600（幂等；防外部工具放宽过权限后残留）
  await chmod(tokenPath, 0o600);
  return token;
}

/* ───── pidfile（R-dg5-③，M69 单守护前提固化） ───── */

/** pid 文件绝对路径（<stateDir>/daemon.pid）。 */
export function daemonPidPath(cfg: BridgeConfig): string {
  return path.join(cfg.stateDir, PID_FILE_NAME);
}

/**
 * 启动时断言本 stateDir 仅有一个守护进程（头注 R-dg5-③，逐分支）：
 * - pidfile 不存在 → O_EXCL（"wx"）独占创建写自身 pid——与并发启动竞态安全，
 *   双守护中至多一个能创建成功；
 * - 已存在：读内容解析 pid——活进程（kill(pid,0) 不抛 / EPERM=存在但非本用户）
 *   → DAEMON_ALREADY_RUNNING 显式拒绝；死进程（ESRCH）→ 陈旧清除覆写（stderr
 *   留痕）；本进程残留（同 pid 重启路径）→ 直接覆写；内容非法 →
 *   DAEMON_PIDFILE_INVALID 显式报错（不代删，头注决策）。
 */
async function acquirePidfile(cfg: BridgeConfig): Promise<void> {
  const pidPath = daemonPidPath(cfg);
  try {
    const fh = await fsOpen(pidPath, "wx", 0o600);
    try {
      await fh.writeFile(`${process.pid}\n`, "utf8");
      await fh.sync();
    } finally {
      await fh.close().catch(() => undefined);
    }
    return;
  } catch (e) {
    if (errnoOf(e) !== "EEXIST") {
      throw new BridgeError(
        "FS_WRITE_FAILED",
        `创建 daemon.pid 失败：path=${pidPath} reason=${errnoOf(e) ?? "UNKNOWN"}`,
        { cause: e },
      );
    }
  }
  let raw: string;
  try {
    raw = await readFile(pidPath, "utf8");
  } catch (e) {
    throw new BridgeError(
      "FS_READ_FAILED",
      `读取 daemon.pid 失败：path=${pidPath} reason=${errnoOf(e) ?? "UNKNOWN"}`,
      { cause: e },
    );
  }
  const pid = Number(raw.trim());
  if (raw.trim().length === 0 || !Number.isInteger(pid) || pid <= 0) {
    throw new BridgeError(
      "DAEMON_PIDFILE_INVALID",
      `daemon.pid 内容非法（须为正整数 pid）：path=${pidPath} content=${JSON.stringify(raw.slice(0, 64))}`,
      { remediation: "确认无守护进程在跑后手工删除该文件再启动。" },
    );
  }
  if (pid === process.pid) {
    // 本进程残留（start 失败重试路径）：直接覆写为当前持有声明
    await atomicWriteFile(pidPath, `${process.pid}\n`, 0o600);
    return;
  }
  let alive = true;
  try {
    process.kill(pid, 0); // 信号 0 = 仅存在性探测
  } catch (e) {
    const code = errnoOf(e);
    if (code === "ESRCH") {
      alive = false; // 陈旧 pid：清除
    } else if (code === "EPERM") {
      alive = true; // 存在但非本用户：按在跑处理（保守拒绝，禁双守护）
    } else {
      throw new BridgeError(
        "DAEMON_PIDFILE_INVALID",
        `探测 daemon.pid 进程存在性失败：pid=${pid} reason=${code ?? "UNKNOWN"}`,
        { cause: e },
      );
    }
  }
  if (alive) {
    throw new BridgeError(
      "DAEMON_ALREADY_RUNNING",
      `已有守护进程在跑（pid=${pid}），禁止双守护：path=${pidPath}`,
      {
        remediation: `先停止该守护进程（kill ${pid}）并确认退出；若确认其已死亡，删除 daemon.pid 后重试。`,
      },
    );
  }
  console.error(`[codearts-bridge] 清除陈旧 daemon.pid（pid=${pid} 已不存在）：path=${pidPath}`);
  await atomicWriteFile(pidPath, `${process.pid}\n`, 0o600);
}

/**
 * 停止时清除 pidfile：仅当内容为自身 pid 才删（防误删接管者的声明）；不存在
 * 幂等返回；其他失败 stderr 可见、不阻断停止（残留按陈旧语义下次启动自愈——
 * 头注 R-dg5-③ 显式登记的收尾决策，非静默吞错）。
 */
async function releasePidfile(cfg: BridgeConfig): Promise<void> {
  const pidPath = daemonPidPath(cfg);
  let raw: string;
  try {
    raw = await readFile(pidPath, "utf8");
  } catch (e) {
    if (errnoOf(e) === "ENOENT") return;
    console.error(
      `[codearts-bridge] 读取 daemon.pid 失败（保留现场）：path=${pidPath} reason=${errnoOf(e) ?? "UNKNOWN"}`,
    );
    return;
  }
  if (raw.trim() !== String(process.pid)) {
    console.error(
      `[codearts-bridge] daemon.pid 非本进程声明（content=${JSON.stringify(raw.slice(0, 64))}），不清除：path=${pidPath}`,
    );
    return;
  }
  try {
    await unlink(pidPath);
  } catch (e) {
    if (errnoOf(e) === "ENOENT") return;
    console.error(
      `[codearts-bridge] 删除 daemon.pid 失败（残留将由下次启动按陈旧清除）：path=${pidPath} reason=${errnoOf(e) ?? "UNKNOWN"}`,
    );
  }
}

/** 提取请求的 Bearer 令牌；头缺失或方案非 "Bearer"（精确匹配，本插件客户端约定）→ undefined。 */
function bearerTokenOf(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string") return undefined;
  const m = /^Bearer (.+)$/.exec(header);
  const token = m?.[1];
  return token === undefined ? undefined : token;
}

/** 常量时间令牌比较（长度不等先短路——长度本身不属机密）；空串永不相等。 */
function tokenMatches(presented: string, expected: string): boolean {
  if (presented.length === 0) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/* ───── HTTP 处理（R-d3） ───── */

/** 统一 JSON 响应出口：所有响应（含错误）application/json 结构化。 */
function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

/** BridgeError code → HTTP 状态映射（T3-05：目标域错误的结构化出口）。 */
function httpStatusOf(e: unknown): number {
  if (!(e instanceof BridgeError)) return 500;
  switch (e.code) {
    case "GOAL_NOT_FOUND":
      return 404;
    case "GOAL_TERMINAL_STATE":
    case "GOAL_PHASE_INVALID":
      return 409;
    case "GOAL_INPUT_INVALID":
    case "GOAL_BODY_INVALID":
    case "GOAL_ACTION_INVALID":
    case "GOAL_ID_INVALID":
    case "GOAL_CURSOR_INVALID":
    case "GOAL_LIMIT_INVALID":
      return 400;
    default:
      return 500;
  }
}

/** 统一错误响应：BridgeError 结构化字段全量透出；未知错误 INTERNAL 500。 */
function sendError(res: http.ServerResponse, e: unknown): void {
  const be = e instanceof BridgeError ? e : undefined;
  const payload = {
    error: {
      code: be?.code ?? "INTERNAL",
      message: e instanceof Error ? e.message : String(e),
      ...(be?.remediation !== undefined ? { remediation: be.remediation } : {}),
    },
  };
  try {
    sendJson(res, httpStatusOf(e), payload);
  } catch (sendErr) {
    // 响应已终结（客户端断开等 socket 级失败）：无可控出口，stderr 留痕即止
    console.error(`[codearts-bridge] 错误响应发送失败：${sendErr instanceof Error ? sendErr.message : String(sendErr)}`);
  }
}

/** 读取并解析 JSON 请求体（上限 MAX_BODY_BYTES；超限/非 JSON 显式 400）。 */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const fail = (e: BridgeError): void => {
      if (settled) return;
      settled = true;
      reject(e);
    };
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        fail(new BridgeError("GOAL_BODY_INVALID", `请求体超过 ${MAX_BODY_BYTES} 字节上限`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        reject(new BridgeError("GOAL_BODY_INVALID", "请求体非合法 JSON"));
      }
    });
    req.on("error", (e: Error) => {
      fail(new BridgeError("GOAL_BODY_INVALID", `读取请求体失败：${e.message}`, { cause: e }));
    });
  });
}

/** logs 分页参数解析：cursor/limit 须为非负/正整数（显式 400）。 */
function parseLogsQuery(url: URL): { cursor?: number; limit?: number } {
  const out: { cursor?: number; limit?: number } = {};
  const cursorRaw = url.searchParams.get("cursor");
  if (cursorRaw !== null && cursorRaw !== "") {
    if (!/^\d+$/.test(cursorRaw)) {
      throw new BridgeError("GOAL_CURSOR_INVALID", `cursor 须为非负整数（实际 ${JSON.stringify(cursorRaw)}）`);
    }
    out.cursor = Number(cursorRaw);
  }
  const limitRaw = url.searchParams.get("limit");
  if (limitRaw !== null && limitRaw !== "") {
    if (!/^\d+$/.test(limitRaw) || Number(limitRaw) < 1) {
      throw new BridgeError("GOAL_LIMIT_INVALID", `limit 须为正整数（实际 ${JSON.stringify(limitRaw)}）`);
    }
    out.limit = Number(limitRaw);
  }
  return out;
}

/* ───── createDaemon（R-d1~R-d4、R-dg1~R-dg5） ───── */

/**
 * 组装守护进程句柄：HTTP 路由（含 /goals* 目标域）、token 鉴权、pidfile、
 * 幂等 start/stop。
 *
 * @param cfg   守护配置（端口/状态根，唯一真相源 loadConfig）
 * @param hooks 可选钩子（T3-04 对账测试缝；挂载 goals 时透传给 GoalHost.start）
 * @param goals 可选目标域宿主（T3-05；缺省未挂载 → /goals* 显式 501，生产装配
 *              归守护服务任务 T3-07）
 */
export function createDaemon(cfg: BridgeConfig, hooks?: DaemonHooks, goals?: GoalHost): DaemonHandle {
  const port = daemonPortOf(cfg.daemonUrl); // R-d1：端口唯一来源 = daemonUrl 端口段
  let token: string | undefined; // start() 载入；请求处理闭包读取
  let startedAtMs: number | undefined; // uptime 基准（start 时置位）
  let listening = false; // stop 幂等判据（listen 成功才置 true）
  let startPromise: Promise<{ port: number }> | undefined; // start 幂等复用句柄
  let views: ViewRegistry | undefined; // 画面状态注册表（start 且 goals 挂载时装配）

  /** /goals* 路由分发（goals 宿主已挂载前提；领域逻辑在 GoalHost）。 */
  async function handleGoalRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    if (goals === undefined) {
      // R-dg1：未挂载目标域 → 显式 501（功能未接线，禁静默假装存在）
      sendJson(res, 501, {
        error: {
          code: "GOAL_HOST_DISABLED",
          message: "守护未挂载目标域宿主（GoalHost），/goals* 端点不可用",
          remediation: "以 createDaemon(cfg, hooks, goals) 挂载 GoalHost 后启动（生产装配见守护服务任务）。",
        },
      });
      return;
    }
    const segs = url.pathname.split("/").filter((s) => s.length > 0); // ["goals", ...]
    if (segs[0] !== "goals") return; // 理论不可达（调用方已判前缀）；防御保持类型收窄
    if (segs.length === 1) {
      if (req.method === "GET") {
        sendJson(res, 200, await goals.listGoals());
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        sendJson(res, 200, await goals.createGoal(body));
        return;
      }
    } else if (segs.length === 2 || segs.length === 3) {
      const goalId = segs[1] as string;
      const sub = segs.length === 3 ? (segs[2] as string) : undefined;
      if (sub === undefined && req.method === "GET") {
        sendJson(res, 200, await goals.getGoal(goalId));
        return;
      }
      if (sub === "logs" && req.method === "GET") {
        const q = parseLogsQuery(url);
        sendJson(res, 200, await goals.getLogs(goalId, q.cursor, q.limit));
        return;
      }
      if (sub === "control" && req.method === "POST") {
        const body = (await readJsonBody(req)) as Record<string, unknown>;
        const state = await goals.control(goalId, body["action"]);
        sendJson(res, 200, { state });
        return;
      }
    }
    sendJson(res, 404, {
      error: { code: "NOT_FOUND", message: `未知路由：${req.method} ${url.pathname}` },
    });
  }

  /** 请求处理主体（async：/goals 写路径需要读体与领域 await）。 */
  async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    // R-d3：仅 "GET + /health" 免鉴权（探活零依赖）；其余一律先鉴权再路由
    const isHealthRoute = req.method === "GET" && url.pathname === "/health";
    if (!isHealthRoute) {
      const presented = bearerTokenOf(req);
      if (presented === undefined || token === undefined || !tokenMatches(presented, token)) {
        sendJson(res, 401, {
          error: {
            code: "UNAUTHORIZED",
            message: "缺少或错误的 Authorization: Bearer 令牌（token 见 <stateDir>/daemon-token）",
          },
        });
        return;
      }
    }
    if (isHealthRoute) {
      const uptimeSeconds = startedAtMs === undefined ? 0 : (Date.now() - startedAtMs) / 1000;
      // actives：在册活跃目标数（spec §7.2；未挂载目标域恒 0）
      sendJson(res, 200, {
        ok: true,
        version: PLUGIN_VERSION,
        uptime: uptimeSeconds,
        actives: goals?.activeCount() ?? 0,
      });
      return;
    }
    if (url.pathname === "/goals" || url.pathname.startsWith("/goals/")) {
      await handleGoalRoute(req, res, url);
      return;
    }
    // 视图端点（2026-11-01 用户裁决：非托管 TUI 画面可在侧栏只读查看）：
    // 只读观察面——不提供任何注入/停止通道，目标驱动权保持在监督循环。
    if (url.pathname === "/tuis" && req.method === "GET") {
      if (goals === undefined) {
        sendJson(res, 501, {
          error: {
            code: "GOAL_HOST_DISABLED",
            message: "守护未挂载目标域宿主（GoalHost），/tuis 端点不可用",
            remediation: "以 createDaemon(cfg, hooks, goals) 挂载 GoalHost 后启动。",
          },
        });
        return;
      }
      const tuis = [];
      for (const s of goals.listSessions()) {
        try {
          const snap = await goals.viewSnapshot(s.ref.id);
          tuis.push({
            goalId: s.goalId,
            phase: s.phase,
            refId: s.ref.id,
            kind: typeof snap.meta["kind"] === "string" ? (snap.meta["kind"] as string) : null,
            pid: typeof snap.meta["pid"] === "number" ? (snap.meta["pid"] as number) : null,
            alive: snap.meta["alive"] === true,
            rawLen: snap.raw.length,
            rawDroppedBytes: typeof snap.meta["rawDroppedBytes"] === "number" ? (snap.meta["rawDroppedBytes"] as number) : 0,
          });
        } catch (e) {
          // 单会话快照失败不拖垮整个清单（其余会话照常列出），错误如实进条目
          tuis.push({
            goalId: s.goalId,
            phase: s.phase,
            refId: s.ref.id,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }
      sendJson(res, 200, { ok: true, tuis });
      return;
    }
    if (url.pathname === "/tui/view" && req.method === "GET") {
      if (goals === undefined) {
        sendJson(res, 501, {
          error: {
            code: "GOAL_HOST_DISABLED",
            message: "守护未挂载目标域宿主（GoalHost），/tui/view 端点不可用",
            remediation: "以 createDaemon(cfg, hooks, goals) 挂载 GoalHost 后启动。",
          },
        });
        return;
      }
      if (views === undefined) {
        sendJson(res, 501, {
          error: {
            code: "VIEW_REGISTRY_DISABLED",
            message: "画面状态注册表未装配（仅守护 start 路径装配）",
            remediation: "经 createDaemon(...).start() 启动守护（测试直调 handler 不会装配）。",
          },
        });
        return;
      }
      const refId = url.searchParams.get("ref") ?? "";
      if (refId === "") {
        sendJson(res, 400, {
          error: { code: "GOAL_INPUT_INVALID", message: "缺少 ref 查询参数（会话引用）" },
        });
        return;
      }
      // ref 必须归属在册目标（防任意引用探测）；喂入增量后序列化当前网格
      const session = goals.listSessions().find((s) => s.ref.id === refId);
      if (session === undefined) {
        throw new BridgeError("SESSION_UNKNOWN", `会话引用不属于任何在册目标：${JSON.stringify(refId)}`, {
          remediation: "仅可查看 GET /tuis 列出的会话。",
        });
      }
      const rev = await views.feed(session.ref);
      sendJson(res, 200, {
        ok: true,
        refId,
        rev,
        rows: views.rowsOf(refId).map(([y, frame]) => [y, frame]),
        meta: { ...views.metaOf(refId), goalId: session.goalId, phase: session.phase },
      });
      return;
    }
    // 鉴权已通过但无此路由
    sendJson(res, 404, {
      error: { code: "NOT_FOUND", message: `未知路由：${req.method} ${url.pathname}` },
    });
  }

  const server = http.createServer((req, res) => {
    // async 路由主体：异常统一结构化映射（BridgeError code → HTTP 状态）
    void handleRequest(req, res).catch((e: unknown) => {
      sendError(res, e);
    });
  });

  function start(): Promise<{ port: number }> {
    // R-d4 幂等：进行中/已完成的 start 复用同一 Promise（不重复 listen）
    if (startPromise !== undefined) return startPromise;
    startPromise = (async () => {
      await ensureStateDirs(cfg); // 状态根先行（token/pidfile 落点；T1-02 幂等原语）
      token = await loadOrCreateToken(cfg);
      await acquirePidfile(cfg); // R-dg5-③：单守护前提（双守护会双对账双注入）
      if (goals !== undefined) {
        // T3-05：目标域装配（对账 → 落盘状态 roster → sweep 循环）；对账实现
        // 可被 hooks.reconcileOnStart 替换（测试缝）；失败显式拒绝 start
        const r = await goals.start(hooks?.reconcileOnStart);
        console.error(
          `[codearts-bridge] 启动对账完成：resumed=${r.resumed.length} blocked=${r.blocked.length}`,
        );
      } else if (hooks?.reconcileOnStart !== undefined) {
        // 旧路径兼容：未挂载目标域但显式注入了对账钩子（T3-04 语义原样保留）
        const r = await hooks.reconcileOnStart(cfg.stateDir);
        console.error(
          `[codearts-bridge] 启动对账完成：resumed=${r.resumed.length} blocked=${r.blocked.length}`,
        );
      }
      startedAtMs = Date.now();
      if (goals !== undefined) {
        // 画面状态注册表（2026-11-02）：持续喂入会话 raw 增量，维护可随时序列化的
        // 屏幕网格（码道 TUI 增量重绘 + rawBuf 512KB 尾截断，重放 raw 无法重建画面）
        views = new ViewRegistry(goals.viewTransport);
        views.start(() => goals.listSessions().map((s) => s.ref));
      }
      await listenOnce(server, port, "127.0.0.1"); // R-d1：绑定地址恒 127.0.0.1
      listening = true;
      // 监听建立后的偶发 socket 错误：显式落 stderr（可见），保持守护存活
      // （探活宿主进程崩溃会连锁打断被监督目标的续跑，属"保持运行"的显式语义而非吞错）
      server.on("error", (e: Error) => {
        console.error(`[codearts-bridge] 守护 server 错误（保持运行）：${e.message}`);
      });
      const addr = server.address();
      if (addr === null || typeof addr === "string") {
        // 仅 AF_INET("127.0.0.1", port) 监听，不可能出现 string 形态；防御性显式报错
        throw new BridgeError("DAEMON_LISTEN_FAILED", `监听地址形态异常：${String(addr)}`);
      }
      return { port: addr.port };
    })();
    // 失败后清空幂等句柄，允许调用方修正配置后重试 start（成功态不受影响）
    startPromise.catch(() => {
      startPromise = undefined;
    });
    return startPromise;
  }

  async function stop(): Promise<void> {
    startPromise = undefined; // 允许 stop 后再次 start（重启复用 token 的重启路径）
    goals?.stop(); // 先摘目标 sweep 循环（不再产生 tick）；会话与状态不销毁（重启对账续跑）
    views?.stop(); // 摘画面网格 ticker 并清状态（start 重建时随新会话重灌）
    if (!listening) {
      // 未启动/已停止：幂等空操作；pidfile 若在本进程 start 失败路径残留，
      // 也按自身声明清除（content 校验使未持有者不会被误删）
      await releasePidfile(cfg);
      return;
    }
    listening = false;
    startedAtMs = undefined;
    // R-d4：先斩全部 keep-alive 连接再 close（否则活动连接令 close 回调悬挂，
    // bun test 进程不退出——任务书"测试防悬挂"要求）
    server.closeAllConnections();
    // 运行时差异（Bun 1.4 实证）：closeAllConnections() 在 Bun 中会顺带停掉监听
    // （listening=false、端口即释），此时再 close(cb) 会以 ERR_SERVER_NOT_RUNNING
    // 回调报错；Node 中 closeAllConnections 不动监听，必须显式 close。
    // 以 server.listening 实际状态分派两条路径——非兜底：两条路径的收敛不变量一致
    // （stop 返回后端口已释放、keep-alive 连接已全断），差异只是"由谁停的监听"。
    if (!server.listening) {
      await releasePidfile(cfg);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((e) => {
        if (e !== undefined && e !== null) {
          reject(
            new BridgeError("DAEMON_STOP_FAILED", `关闭守护失败：${e.message}`, { cause: e }),
          );
        } else {
          resolve();
        }
      });
    });
    await releasePidfile(cfg);
  }

  return { server, start, stop };
}

/** listen 的 Promise 化（一次性 error 监听，成功后摘除，避免污染后续错误通道）。 */
function listenOnce(srv: http.Server, port: number, host: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (e: Error) => {
      reject(
        new BridgeError(
          "DAEMON_LISTEN_FAILED",
          `监听 ${host}:${port} 失败：${e.message}（errno=${errnoOf(e) ?? "UNKNOWN"}）`,
          { cause: e },
        ),
      );
    };
    srv.once("error", onError);
    srv.listen(port, host, () => {
      srv.removeListener("error", onError);
      resolve();
    });
  });
}
