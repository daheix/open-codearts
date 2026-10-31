/**
 * codearts_goal_* / codearts_daemon_status 六工具 + 守护 HTTP 薄代理 + 目标回呼轮询（T3-06）。
 *
 * 文件归属说明：任务书 Files 只列 server.ts，但 server.ts 已 730 行，叠加六工具
 * 与回呼轮询将突破"单文件 ≤1000 行"仓库铁律——按 T1-05 upgrade.ts 独立成文件的
 * 既有裁决先例（主控裁定 2026-10-31），本域实现独立成文件；server.ts 仅做装配。
 *
 * 职责边界：
 * - 薄代理（R-g1）：六个工具是守护 HTTP API 的薄代理——Bearer daemon-token 鉴权、
 *   daemonUrl 取自 cfg、守护响应（含结构化错误）透传为工具 content；本文件不做
 *   任何领域决策（目标状态机/分页语义全在守护侧 daemon-goals.ts）。
 * - 回呼轮询（R-g3）：插件侧 30s 轮询 GET /goals，对比上次快照检测目标终态/告警，
 *   经 ctx.session.synthetic 向发起会话尽力通知（**尽力通知，非投递保证**——
 *   通知失败仅审计不阻塞、不重试；守护重启或插件卸载期间的窗口不补偿）。
 *
 * 主控裁定落点（SDD 2026-10-31，逐条）：
 * - R-g1（代理语义）：六工具=守护 HTTP 的薄代理（Bearer daemon-token；daemonUrl
 *   从 cfg）；响应透传为 content；守护 501 GOAL_HOST_DISABLED 原样透传（含
 *   remediation）——实现路径：守护非 2xx 结构化错误体 {error:{code,message,
 *   remediation?}} 原样构造 BridgeError，经 server.ts R-t1 出口落 content，
 *   三字段零改写。
 * - R-g2（不可达显式）：fetch 失败（ECONNREFUSED/超时）→ BridgeError
 *   (DAEMON_UNAVAILABLE)（remediation 含 `codearts-bridge daemon` 启动指引）；
 *   无静默兜底、不自动启动守护（启动接线属 T3-07）。
 * - R-g3（回呼尽力通知）：插件轮询 30s（setup 注册、unload 清理）；检测目标
 *   终态/告警（对比上次快照）→ ctx.session.synthetic（若发起会话 id 已知）通知；
 *   失败仅审计不阻塞。告警分级：终态(complete/stopped) > blocked(等人工) >
 *   strikes 达阈值(连续无进展)——快照对比按级别单调升级触发，恰好一次。
 * - R-g4（会话绑定）：goal_start 记录发起 sessionID（context.sessionID）入守护
 *   请求体（initiatedBy 字段经 body 透传）。守护侧 parseCreateInput 仅取已知键、
 *   未知字段前向容忍（读码实证，daemon-goals.ts 头注"未知字段忽略"口径），无需
 *   降级路径；发起会话另存插件本地映射（goal_start 成功后 goalId→sessionID），
 *   供回呼轮询定位通知目标。
 *
 * 错误码登记（本文件新增，与 errors.ts 开放 string 约定一致）：
 * - DAEMON_UNAVAILABLE：守护不可达（连接失败/超时/token 缺失=从未启动）；
 * - DAEMON_RESPONSE_INVALID：守护响应形态非法（非 JSON/非结构化错误体/缺 goalId）；
 * - DAEMON_TOKEN_INVALID：daemon-token 文件为空（与 daemon.ts 同码同义）。
 *
 * 审计词表登记（appendInstallAudit，spec §8 审计原则）：
 * - goal.notify：回呼通知已投递（info）；
 * - goal.notify-failed：synthetic 投递失败（warn；尽力通知失败仅审计不阻塞）；
 * - goal.notify-skipped：无投递通道（发起会话未知/宿主未注入 synthetic）仅审计；
 * - goal.poll-failed：GET /goals 轮询失败（warn；下轮重试）。
 *
 * 权限说明：goal_* 与 daemon_status 属目标域操作（spec §6.5 权限清单仅列
 * upgrade/repair/hygiene 执行），不设权限门——与 codearts_run 同口径。
 */
import { readFile } from "node:fs/promises";
import type { BridgeConfig } from "./core/config";
import { BridgeError } from "./core/errors";
import { errnoOf } from "./core/fsx";
import { requireValidGoalId } from "./core/goal/state";
import { daemonTokenPath } from "./daemon";
import type { ToolCtxLike, BridgeToolDef } from "./server";

/* ───── 守护 HTTP 薄代理（R-g1/R-g2） ───── */

/** 守护调用超时（毫秒）：本机回环 + 本守护，10s 足够容忍 logs 大页；超时按 R-g2 显式不可用。 */
export const DAEMON_HTTP_TIMEOUT_MS = 10_000;

/** 目标回呼轮询周期（R-g3 固定 30s；导出供测试钉死唯一真相）。 */
export const GOAL_POLL_INTERVAL_MS = 30_000;

/** R-g2 启动指引（remediation 固定文案；CLI daemon 命令见 src/cli.ts）。
 * 终审修复波 F2（2026-10-31）：生产常驻指引改为指向已交付能力（T3-07
 * `service install`：systemd user service + 每分钟 watchdog），不再称"后续任务交付"。 */
export const DAEMON_START_REMEDIATION =
  "先启动守护进程再重试：bun <本插件包>/src/cli.ts daemon（全局安装可用 codearts-bridge daemon）；" +
  "生产常驻请执行 `codearts-bridge service install`（systemd user service + 每分钟 watchdog）。";

/** 守护 HTTP 响应的最小结构面（与全局 fetch 的 Response 结构兼容）。 */
export interface DaemonHttpResponse {
  status: number;
  json(): Promise<unknown>;
}

/** 守护 HTTP 请求 init（fetch(RequestInit) 的结构子集；测试 fake 按此实现）。 */
export interface DaemonRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** 守护 HTTP 客户端抽象（生产=daemonHttpFetcher；测试注入 fake，绝不联网）。 */
export type DaemonFetcher = (url: string, init: DaemonRequestInit) => Promise<DaemonHttpResponse>;

/** 生产实现：全局 fetch 透传（Response 结构兼容 DaemonHttpResponse）。 */
export const daemonHttpFetcher: DaemonFetcher = (url, init) => fetch(url, init);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 读守护令牌（<stateDir>/daemon-token；路径唯一真相=daemon.ts daemonTokenPath）。
 * - ENOENT → DAEMON_UNAVAILABLE（守护从未启动过——token 由守护首启生成，文件缺失
 *   即不可用，属 R-g2 口径而非普通 FS 错误）；
 * - 其他读错误 → FS_READ_FAILED（真实 IO 故障，不冒充不可用）；
 * - 空文件 → DAEMON_TOKEN_INVALID（与守护侧同码同义：拒绝空令牌）。
 * 每次调用即读（不缓存）：token 仅在删文件重启守护时更替，直读永远新鲜且零状态。
 */
async function readDaemonToken(cfg: BridgeConfig): Promise<string> {
  const tokenPath = daemonTokenPath(cfg);
  let content: string;
  try {
    content = await readFile(tokenPath, "utf8");
  } catch (e) {
    if (errnoOf(e) === "ENOENT") {
      throw new BridgeError(
        "DAEMON_UNAVAILABLE",
        `daemon-token 不存在（守护从未启动）：path=${tokenPath}`,
        { remediation: DAEMON_START_REMEDIATION },
      );
    }
    const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
    throw new BridgeError("FS_READ_FAILED", `读取 daemon-token 失败：path=${tokenPath} reason=${reason}`, {
      cause: e,
    });
  }
  const token = content.trim();
  if (token.length === 0) {
    throw new BridgeError("DAEMON_TOKEN_INVALID", `daemon-token 文件为空（拒绝空令牌）：path=${tokenPath}`, {
      remediation: "删除该文件后重启守护进程即可重新生成",
    });
  }
  return token;
}

/** daemonRequest 依赖（cfg + fetcher；测试经 fetcher 注入 fake）。 */
export interface DaemonRequestDeps {
  cfg: BridgeConfig;
  fetcher: DaemonFetcher;
}

/**
 * 守护 HTTP 薄代理内核（R-g1/R-g2 唯一出口）：
 * - Bearer daemon-token 鉴权；POST body JSON；10s 超时（AbortSignal.timeout）；
 * - 2xx → 解析 JSON 原样返回（透传载荷）；
 * - 非 2xx 且错误体为守护结构化形态 {error:{code,message,remediation?}} →
 *   原样构造 BridgeError（经 server.ts R-t1 出口三字段零改写落 content——
 *   含 501 GOAL_HOST_DISABLED 的 remediation 透传）；
 * - 连接失败/超时 → DAEMON_UNAVAILABLE（R-g2：不自动启动守护，仅给启动指引）；
 * - 响应非 JSON / 错误体形态非法 → DAEMON_RESPONSE_INVALID（显式，禁猜）。
 */
export async function daemonRequest(
  deps: DaemonRequestDeps,
  args: { method: "GET" | "POST"; path: string; body?: unknown },
): Promise<unknown> {
  const token = await readDaemonToken(deps.cfg);
  const url = `${deps.cfg.daemonUrl.replace(/\/+$/, "")}${args.path}`;
  let res: DaemonHttpResponse;
  try {
    res = await deps.fetcher(url, {
      method: args.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(args.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
      signal: AbortSignal.timeout(DAEMON_HTTP_TIMEOUT_MS),
    });
  } catch (e) {
    // R-g2：ECONNREFUSED/超时等全部显式不可用（无静默兜底、不自动启动守护）
    throw new BridgeError(
      "DAEMON_UNAVAILABLE",
      `守护进程不可达：${url}（${e instanceof Error ? e.message : String(e)}）`,
      { remediation: DAEMON_START_REMEDIATION, cause: e },
    );
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    throw new BridgeError("DAEMON_RESPONSE_INVALID", `守护响应非 JSON：status=${res.status} url=${url}`, {
      cause: e,
    });
  }
  if (res.status < 200 || res.status >= 300) {
    const errRec = isPlainObject(body) && isPlainObject(body["error"]) ? body["error"] : undefined;
    const code = typeof errRec?.["code"] === "string" ? errRec["code"] : undefined;
    if (code !== undefined) {
      // R-g1：守护结构化错误原样透传（GOAL_HOST_DISABLED 501 同路径，remediation 零改写）
      throw new BridgeError(
        code,
        typeof errRec!["message"] === "string" ? (errRec!["message"] as string) : `守护返回 HTTP ${res.status}`,
        {
          remediation:
            typeof errRec!["remediation"] === "string" ? (errRec!["remediation"] as string) : undefined,
        },
      );
    }
    throw new BridgeError(
      "DAEMON_RESPONSE_INVALID",
      `守护响应形态非法（非结构化错误体）：status=${res.status} url=${url}`,
    );
  }
  return body;
}

/* ───── 目标回呼轮询（R-g3：尽力通知，非投递保证） ───── */

/** 告警级别（对比快照按级别单调升级触发；级别序：无 < strikes告警 < blocked < 终态）。 */
export const GOAL_ALERT_NONE = 0;
export const GOAL_ALERT_STRIKES = 1;
export const GOAL_ALERT_BLOCKED = 2;
export const GOAL_ALERT_TERMINAL = 3;

/** GET /goals 摘要行（守护契约字段；插件侧不再二次校验——薄代理口径）。 */
export interface GoalNotifySnapshot {
  goalId: string;
  state: string;
  rounds: number;
  strikes: number;
  objective: string;
}

/** 由摘要行计算告警级别（终态 > blocked > strikes 达阈值 > 无）。 */
export function goalAlertLevel(state: string, strikes: number, strikesThreshold: number): number {
  if (state === "complete" || state === "stopped") return GOAL_ALERT_TERMINAL;
  if (state === "blocked") return GOAL_ALERT_BLOCKED;
  if (typeof strikes === "number" && strikes >= strikesThreshold) return GOAL_ALERT_STRIKES;
  return GOAL_ALERT_NONE;
}

/** 通知文本（中文人话；goalId/objective/rounds 入文，便于会话续查 goal_status/logs）。 */
export function goalNotifyText(g: GoalNotifySnapshot, level: number): string {
  const base = `「${g.objective}」（goalId=${g.goalId}，rounds=${g.rounds}）`;
  if (level === GOAL_ALERT_TERMINAL) {
    return g.state === "complete" ? `codearts 目标已完成：${base}` : `codearts 目标已停止：${base}`;
  }
  if (level === GOAL_ALERT_BLOCKED) return `codearts 目标已阻塞，等待人工处理：${base}`;
  return `codearts 目标连续无进展告警（strikes=${g.strikes}）：${base}`;
}

/** 轮询定时器宿主（生产=setInterval 30s unref；测试注入手动驱动）。 */
export interface GoalPollLoop {
  start(tick: () => void | Promise<void>): void;
  stop(): void;
}

/** 生产缺省循环：setInterval + unref（插件存活由宿主进程承载，定时器不得悬挂测试/卸载）。 */
export function defaultGoalPollLoop(intervalMs: number): GoalPollLoop {
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    start(tick: () => void | Promise<void>): void {
      if (timer !== undefined) clearInterval(timer); // 重复 start 先摘旧（幂等）
      timer = setInterval(() => {
        void Promise.resolve()
          .then(tick)
          .catch((e: unknown) => {
            // pollOnce 内部已自容错；此处是框架级意外：stderr 可见非静默
            console.error(`[codearts-bridge] 目标回呼轮询框架异常：${e instanceof Error ? e.message : String(e)}`);
          });
      }, intervalMs);
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** 回呼轮询依赖（R-g3；synthetic/audit 均可缺省失败——尽力通知语义）。 */
export interface GoalCallbackDeps {
  cfg: BridgeConfig;
  fetcher: DaemonFetcher;
  /** GET /goals 代理（装配层注入；内含 Bearer/token 细节）。 */
  listGoals: () => Promise<GoalNotifySnapshot[]>;
  /** goalId → 发起会话映射（goal_start 登记；实例内存，插件重载后即失——尽力通知口径）。 */
  sessions: ReadonlyMap<string, string>;
  /** 宿主通知通道（ctx.session.synthetic；缺省=无通道，通知转 skipped 审计）。 */
  synthetic?: (input: { sessionID: string; text: string }) => Promise<unknown>;
  /** 审计出口（appendInstallAudit；失败仅 stderr 留痕，不阻塞轮询）。 */
  audit: (entry: Record<string, unknown>) => Promise<void>;
  /** 定时器宿主。 */
  loop: GoalPollLoop;
}

/**
 * 目标回呼轮询（R-g3）。**尽力通知，非投递保证**：
 * - 本实例未发起任何目标（sessions 空）→ 无通知对象，直接跳过网络轮询；
 * - 每轮拉取 GET /goals，与上次快照按告警级别对比：级别升级才通知（终态/strikes
 *   首见即终态且为本实例发起 → 通知，覆盖"goal_start 后 30s 内即完成"快路径；
 *   其余首见仅记基线，防插件重载后对历史终态目标刷屏）；
 * - 通知走 synthetic（发起会话已知且通道在场）；任何失败（无通道/synthetic 抛错/
 *   轮询失败/审计失败）仅审计或 stderr 留痕，不阻塞、不重试、不外抛。
 */
export function createGoalCallbackLoop(deps: GoalCallbackDeps): {
  pollOnce(): Promise<void>;
  stop(): void;
} {
  /** goalId → 上次快照告警级别（快照对比的状态基座）。 */
  const levels = new Map<string, number>();
  const auditSafe = async (entry: Record<string, unknown>): Promise<void> => {
    try {
      await deps.audit(entry);
    } catch (e) {
      // 审计写失败不阻塞轮询，但必须可见（禁静默吞错）：stderr 结构化留痕
      console.error(
        `[codearts-bridge] 目标回呼审计写入失败：kind=${String(entry["kind"])} reason=${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };
  async function notify(g: GoalNotifySnapshot, level: number): Promise<void> {
    const sessionID = deps.sessions.get(g.goalId);
    if (sessionID === undefined || deps.synthetic === undefined) {
      // "session 缺失→仅审计"（任务书 Step1）：无投递通道的显式留痕，非静默丢弃
      await auditSafe({
        ts: new Date().toISOString(),
        kind: "goal.notify-skipped",
        goalId: g.goalId,
        state: g.state,
        reason: sessionID === undefined ? "session-unknown" : "synthetic-unavailable",
      });
      return;
    }
    try {
      await deps.synthetic({ sessionID, text: goalNotifyText(g, level) });
      await auditSafe({
        ts: new Date().toISOString(),
        kind: "goal.notify",
        level: "info",
        goalId: g.goalId,
        sessionID,
        state: g.state,
      });
    } catch (e) {
      // 尽力通知失败仅审计不阻塞（R-g3；不重试——重试属守护域监督职责）
      await auditSafe({
        ts: new Date().toISOString(),
        kind: "goal.notify-failed",
        level: "warn",
        goalId: g.goalId,
        sessionID,
        state: g.state,
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  async function pollOnce(): Promise<void> {
    if (deps.sessions.size === 0) return; // 零通知对象：跳过网络（显式语义，见头注）
    let raw: unknown;
    try {
      raw = await deps.listGoals();
    } catch (e) {
      await auditSafe({
        ts: new Date().toISOString(),
        kind: "goal.poll-failed",
        level: "warn",
        message: `目标列表轮询失败（下轮重试）：${e instanceof Error ? e.message : String(e)}`,
      });
      return;
    }
    if (!Array.isArray(raw)) {
      // 守护契约破坏（GET /goals 必回数组）：显式审计留痕并跳过本轮，禁静默猜形
      await auditSafe({
        ts: new Date().toISOString(),
        kind: "goal.poll-failed",
        level: "warn",
        message: `GET /goals 响应非数组（守护契约破坏）：${JSON.stringify(raw).slice(0, 200)}`,
      });
      return;
    }
    const next = raw as GoalNotifySnapshot[];
    for (const g of next) {
      const prev = levels.get(g.goalId);
      const level = goalAlertLevel(g.state, g.strikes, deps.cfg.thresholds.strikes);
      levels.set(g.goalId, level);
      const firstSeen = prev === undefined;
      const shouldNotify = firstSeen
        ? deps.sessions.has(g.goalId) && level === GOAL_ALERT_TERMINAL // 快完成路径（头注）
        : level > prev!; // 级别升级才通知（恰好一次的关键）
      if (!shouldNotify) continue;
      await notify(g, level);
    }
  }
  deps.loop.start(() =>
    // 返回 Promise 而非 void 启动：可等待的定时器宿主（测试手动 loop）能 await 到
    // 单轮完成；defaultGoalPollLoop 的 .catch 已兜住框架级意外（pollOnce 内部自容错）
    pollOnce().catch((e: unknown) => {
      // 框架级意外（pollOnce 已自容错，理论不可达）：stderr 可见非静默
      console.error(`[codearts-bridge] 目标回呼轮询框架异常：${e instanceof Error ? e.message : String(e)}`);
    }),
  );
  return {
    pollOnce,
    stop: () => deps.loop.stop(),
  };
}

/* ───── 六工具定义（schema/摘要/execute；装配经 createGoalTools） ───── */

/* 输入归一助手（与 server.ts 同码两道防线口径：宿主 schema 校验 + execute 内同码复检） */

function inputRecord(raw: unknown): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new BridgeError("TOOL_INPUT_INVALID", `工具输入须为 JSON 对象，实际为 ${typeof raw}`);
  }
  return raw as Record<string, unknown>;
}

function optBoolean(input: Record<string, unknown> | undefined, key: string): boolean | undefined {
  const v = input?.[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") {
    throw new BridgeError("TOOL_INPUT_INVALID", `参数 ${key} 须为布尔值，实际为 ${typeof v}`);
  }
  return v;
}

function optString(input: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = input?.[key];
  if (v === undefined) return undefined;
  if (typeof v !== "string") {
    throw new BridgeError("TOOL_INPUT_INVALID", `参数 ${key} 须为字符串，实际为 ${typeof v}`);
  }
  return v;
}

function optStringArray(input: Record<string, unknown> | undefined, key: string): string[] | undefined {
  const v = input?.[key];
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new BridgeError("TOOL_INPUT_INVALID", `参数 ${key} 须为字符串数组，实际为 ${JSON.stringify(v)}`);
  }
  return v as string[];
}

function optNonNegativeInt(input: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = input?.[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new BridgeError("TOOL_INPUT_INVALID", `参数 ${key} 须为非负整数，实际为 ${JSON.stringify(v) ?? "undefined"}`);
  }
  return v;
}

function optPositiveInt(input: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = input?.[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new BridgeError("TOOL_INPUT_INVALID", `参数 ${key} 须为正整数，实际为 ${JSON.stringify(v) ?? "undefined"}`);
  }
  return v;
}

/** goalId 归一：类型检查 + 守护同源白名单（requireValidGoalId，路径穿越拒绝面单一真相）。 */
function requireGoalId(input: Record<string, unknown> | undefined): string {
  const raw = optString(input, "goalId");
  if (raw === undefined) {
    throw new BridgeError("TOOL_INPUT_INVALID", "参数 goalId 须为非空字符串");
  }
  return requireValidGoalId(raw);
}

/* ───── 输入 schema（严格封闭：additionalProperties:false） ───── */

const GOAL_START_INPUT_SCHEMA = {
  type: "object",
  properties: {
    objective: {
      type: "string",
      minLength: 1,
      description: "目标描述（非空；由守护监督的 AI 会话负责跑到底）",
    },
    verify: {
      type: "array",
      items: { type: "string" },
      description: "独立验收命令清单（每条须独立执行并通过；缺省无）",
    },
    workdir: { type: "string", description: "目标工作目录（绝对路径；缺省随守护）" },
    // F3（终审修复波 2026-10-31）：如实表述——当前守护只持久化记录该值，轮次
    // 上限的消费（到轮强制停止）为路线图项，不夸大为已生效的强制上限。
    maxRounds: {
      type: "integer",
      minimum: 1,
      description: "目标轮次上限（持久化记录；守护消费为路线图项）",
    },
    autoNudge: { type: "boolean", description: "逐目标自动续跑覆盖（缺省随宿主配置）" },
  },
  required: ["objective"],
  additionalProperties: false,
} as const;

const GOAL_ID_INPUT_SCHEMA = {
  type: "object",
  properties: {
    goalId: { type: "string", minLength: 1, description: "目标 id（codearts_goal_start 返回）" },
  },
  required: ["goalId"],
  additionalProperties: false,
} as const;

const GOAL_LOGS_INPUT_SCHEMA = {
  type: "object",
  properties: {
    goalId: { type: "string", minLength: 1, description: "目标 id" },
    cursor: {
      type: "integer",
      minimum: 0,
      description: "续读游标（上次响应 nextCursor 原样回传；缺省从头读）",
    },
    limit: { type: "integer", minimum: 1, description: "单页事件上限（缺省 200，上限 1000 由守护裁定）" },
  },
  required: ["goalId"],
  additionalProperties: false,
} as const;

const GOAL_CONTROL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    goalId: { type: "string", minLength: 1, description: "目标 id" },
    action: {
      type: "string",
      enum: ["pause", "resume", "stop"],
      description: "pause=暂停注入；resume=注入继续；stop=终态停止",
    },
  },
  required: ["goalId", "action"],
  additionalProperties: false,
} as const;

/* ───── 人类可读简报（content[1]） ───── */

function summarizeGoalStart(p: Record<string, any>): string {
  return `codearts_goal_start：已创建目标 ${p.goalId}（终态/告警将随 30s 轮询尽力通知本会话——非投递保证）`;
}

function summarizeGoalStatus(p: Record<string, any>): string {
  return `codearts_goal_status：目标 ${p.goalId} phase=${p.phase} rounds=${p.rounds} strikes=${p.strikes}`;
}

function summarizeGoalList(p: Record<string, any>): string {
  const items = Array.isArray(p) ? (p as Array<Record<string, any>>) : [];
  const head = items.slice(0, 8).map((g) => `${g.goalId}:${g.state}`).join(", ");
  return `codearts_goal_list：共 ${items.length} 个目标${items.length > 0 ? ` [${head}${items.length > 8 ? ", …" : ""}]` : ""}`;
}

function summarizeGoalLogs(p: Record<string, any>): string {
  const n = Array.isArray(p.events) ? p.events.length : 0;
  return `codearts_goal_logs：返回 ${n} 条事件，nextCursor=${p.nextCursor}（续读请原样回传）`;
}

function summarizeGoalControl(p: Record<string, any>): string {
  const st = (p.state ?? {}) as Record<string, any>;
  return `codearts_goal_control：目标 ${st.goalId} → phase=${st.phase}`;
}

function summarizeDaemonStatus(p: Record<string, any>): string {
  return `codearts_daemon_status：守护运行中 version=${p.version} uptime=${Math.round(Number(p.uptime ?? 0))}s 活跃目标=${p.actives}`;
}

/* ───── 装配入口 ───── */

/** wrap 函数形态（server.ts wrapTool 的柯里化出口；类型自 server.ts 结构引用）。 */
export type GoalToolWrap = (
  tool: string,
  summarize: (payload: Record<string, any>) => string,
  body: (input: Record<string, unknown> | undefined, ctx: ToolCtxLike) => Promise<unknown>,
) => BridgeToolDef["execute"];

/** createGoalTools 依赖（server.ts createTools 装配时注入同一 cfg/fetcher/会话表）。 */
export interface GoalToolDeps {
  cfg: BridgeConfig;
  fetcher: DaemonFetcher;
  /** goalId → 发起会话映射（goal_start 写、回呼轮询读；server.ts 装配层持有同一实例）。 */
  sessions: Map<string, string>;
  /** server.ts 的 wrapTool 柯里化（R-t1 统一出口复用）。 */
  wrap: GoalToolWrap;
}

/** proxy 调用薄封装（六工具共用；path 由各工具按守护 API 契约拼装）。 */
function proxy(deps: GoalToolDeps, args: { method: "GET" | "POST"; path: string; body?: unknown }): Promise<unknown> {
  return daemonRequest({ cfg: deps.cfg, fetcher: deps.fetcher }, args);
}

/**
 * 构造六目标域工具（T3-06）：goal_start/status/list/logs/control + daemon_status。
 * 全部经 daemonRequest 薄代理（R-g1）；业务校验/状态机在守护侧，本层只做输入
 * 归一（两道防线同码）与 goalId 路径安全白名单（与守护同源）。
 */
export function createGoalTools(deps: GoalToolDeps): BridgeToolDef[] {
  const goalStartTool: BridgeToolDef = {
    name: "goal_start",
    description:
      "创建守护监督目标（POST /goals）：objective 由守护监督的 AI 会话跑到底（停滞自动续跑、" +
      "会话死重建续跑、verify 命令双过验收）。返回 {goalId}；本会话 id 自动随请求透传守护" +
      "（initiatedBy），并登记回呼通知——目标终态/告警将经 30s 轮询尽力通知本会话（非投递保证，" +
      "可用 codearts_goal_status 主动查）。需要守护进程在跑（否则返回 DAEMON_UNAVAILABLE 与启动指引）。" +
      "非管理动作，无需权限。",
    input: GOAL_START_INPUT_SCHEMA,
    options: { namespace: "codearts" },
    execute: deps.wrap("goal_start", summarizeGoalStart, async (input, ctx) => {
      const objective = optString(input, "objective");
      if (objective === undefined || objective.trim().length === 0) {
        throw new BridgeError("TOOL_INPUT_INVALID", "参数 objective 须为非空字符串");
      }
      const verify = optStringArray(input, "verify");
      const workdir = optString(input, "workdir");
      const maxRounds = optPositiveInt(input, "maxRounds");
      const autoNudge = optBoolean(input, "autoNudge");
      const payload = (await proxy(deps, {
        method: "POST",
        path: "/goals",
        body: {
          objective,
          ...(verify !== undefined ? { verify } : {}),
          ...(workdir !== undefined ? { workdir } : {}),
          ...(maxRounds !== undefined ? { maxRounds } : {}),
          ...(autoNudge !== undefined ? { autoNudge } : {}),
          initiatedBy: ctx.sessionID, // R-g4：发起会话透传（守护 parseCreateInput 前向容忍未知字段）
        },
      })) as Record<string, unknown>;
      const goalId = payload["goalId"];
      if (typeof goalId !== "string" || goalId.length === 0) {
        // 守护契约破坏（POST /goals 必回 goalId）：显式报错，禁猜禁兜底
        throw new BridgeError(
          "DAEMON_RESPONSE_INVALID",
          `POST /goals 响应缺 goalId：${JSON.stringify(payload).slice(0, 200)}`,
        );
      }
      deps.sessions.set(goalId, ctx.sessionID); // R-g3：本地登记发起会话（回呼通知目标）
      return payload;
    }),
  };

  const goalStatusTool: BridgeToolDef = {
    name: "goal_status",
    description:
      "查询单个目标完整状态（GET /goals/:id，透传守护）：phase(active/paused/blocked/complete/stopped)、" +
      "rounds、strikes、steps、session 引用等。在册目标实时、终态目标读盘。非管理动作，无需权限。",
    input: GOAL_ID_INPUT_SCHEMA,
    options: { namespace: "codearts" },
    execute: deps.wrap("goal_status", summarizeGoalStatus, async (input) => {
      const goalId = requireGoalId(input);
      return await proxy(deps, { method: "GET", path: `/goals/${goalId}` });
    }),
  };

  const goalListTool: BridgeToolDef = {
    name: "goal_list",
    description:
      "列出全部目标摘要（GET /goals，磁盘全生命周期视图）：[{goalId, state, rounds, strikes, " +
      "objective(≤120字)}]。非管理动作，无需权限。",
    input: { type: "object", properties: {}, additionalProperties: false } as const,
    options: { namespace: "codearts" },
    execute: deps.wrap("goal_list", summarizeGoalList, async () => {
      return await proxy(deps, { method: "GET", path: "/goals" });
    }),
  };

  const goalLogsTool: BridgeToolDef = {
    name: "goal_logs",
    description:
      "分页读取目标审计流（GET /goals/:id/logs?cursor=，顺序稳定分页）：events 为追加序审计事件" +
      "（每条含 seq），nextCursor 为续读游标（原样回传即不重不漏）。非管理动作，无需权限。",
    input: GOAL_LOGS_INPUT_SCHEMA,
    options: { namespace: "codearts" },
    execute: deps.wrap("goal_logs", summarizeGoalLogs, async (input) => {
      const goalId = requireGoalId(input);
      const cursor = optNonNegativeInt(input, "cursor");
      const limit = optPositiveInt(input, "limit");
      const query =
        cursor !== undefined || limit !== undefined
          ? `?${[...(cursor !== undefined ? [`cursor=${cursor}`] : []), ...(limit !== undefined ? [`limit=${limit}`] : [])].join("&")}`
          : "";
      return await proxy(deps, { method: "GET", path: `/goals/${goalId}/logs${query}` });
    }),
  };

  const goalControlTool: BridgeToolDef = {
    name: "goal_control",
    description:
      "控制目标（POST /goals/:id/control，即时生效）：pause=暂停注入（此后不再驱动）；" +
      "resume=注入继续并转 active；stop=终态停止。blocked（等人工）目标 pause 显式 409。" +
      "返回 {state}。非管理动作，无需权限。",
    input: GOAL_CONTROL_INPUT_SCHEMA,
    options: { namespace: "codearts" },
    execute: deps.wrap("goal_control", summarizeGoalControl, async (input) => {
      const goalId = requireGoalId(input);
      const action = optString(input, "action");
      if (action !== "pause" && action !== "resume" && action !== "stop") {
        throw new BridgeError(
          "TOOL_INPUT_INVALID",
          `参数 action 须为 pause/resume/stop 之一，实际为 ${JSON.stringify(action ?? null)}`,
        );
      }
      return await proxy(deps, { method: "POST", path: `/goals/${goalId}/control`, body: { action } });
    }),
  };

  const daemonStatusTool: BridgeToolDef = {
    name: "daemon_status",
    description:
      "守护进程健康（GET /health，免鉴权端点透传）：{ok, version, uptime, actives}。守护未运行时" +
      "显式返回 DAEMON_UNAVAILABLE 与启动指引（codearts-bridge daemon）——不静默假装、不自动启动。" +
      "非管理动作，无需权限。",
    input: { type: "object", properties: {}, additionalProperties: false } as const,
    options: { namespace: "codearts" },
    execute: deps.wrap("daemon_status", summarizeDaemonStatus, async () => {
      return await proxy(deps, { method: "GET", path: "/health" });
    }),
  };

  return [goalStartTool, goalStatusTool, goalListTool, goalLogsTool, goalControlTool, daemonStatusTool];
}
