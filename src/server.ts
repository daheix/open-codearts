/**
 * codearts-bridge opencode 插件入口与 M1 工具接线（T1-08）+ M2 run 工具（T2-05）。
 *
 * 职责边界：插件定义、管理工具的注册与编排（薄编排层）；
 * 安装探测/修复/升级/健康/治理的业务逻辑全部在 src/core/*（T1-02~T1-07），
 * run 工具的传输选择/单轮运行/超时取消/审计编排全部在 src/core/run.ts（T2-05），
 * 本文件不做任何业务判断——只做 参数归一 → 权限门 → 调 core → 结构化返回。
 *
 * 工具集（全部经 T1-02~T1-07、T2-05、T3-06 模块接线；对外有效名 = namespace + "_" + name）：
 * - codearts_status            → probeInstall + readAksk + collectHealth 摘要 + 传输/守护状态
 * - codearts_repair            → 权限门 → probeInstall 幂等检查（R-t3）→ repairInstall → ensureBackup
 * - codearts_upgrade           → 权限门 → upgradeInstall（fetcher/extract 可注入）
 * - codearts_health            → collectHealth 快照（真实环境全量扫日志，实测约 14s/次，见 health.ts 头注）
 * - codearts_hygiene({apply?}) → planHygiene（只读）→ apply=true 时权限门 → applyHygiene
 * - codearts_run({prompt,...}) → runOnce（R-cr1 传输选择/R-cr2 超时/R-cr3 进度取消/R-cr4 审计；run 非管理动作，不设权限门）
 * - codearts_goal_start/status/list/logs/control → 守护 HTTP 薄代理（T3-06 R-g1/R-g2；
 *   领域实现在 goal-tools.ts——server.ts 行数纪律下的独立文件，归属裁决见其头注）
 * - codearts_daemon_status     → GET /health 透传；不可达显式 DAEMON_UNAVAILABLE + 启动指引
 * - 目标回呼轮询（T3-06 R-g3）：setup 注册 30s 轮询、unload 清理；目标终态/告警 →
 *   ctx.session.synthetic 尽力通知（非投递保证；失败仅审计）
 *
 * 主控裁定落点（SDD 2026-10-31，逐条）：
 * - R-t1（错误以 content 返回）：工具 execute 的业务错误不抛裸异常——统一经
 *   toErrorPayload 以 { error:{code,message,remediation?} } 结构化进 content；
 *   BridgeError 映射自身字段；未知异常 → code="INTERNAL" 并尽力写一条
 *   tool.internal-error 审计警告（审计失败不掩盖返回给调用方的结构化错误，
 *   与 upgrade.ts 失败审计同纪律）。宿主侧 schema 校验失败由宿主自行报错，
 *   不在本层伪造兜底。
 * - R-t2（权限门）：repair / upgrade / hygiene(apply=true) 必须先经
 *   permission.assert({sessionID, agent, action:"codearts.manage",
 *   resources, save, source:{type:"tool",messageID,id}})；resources/save：
 *   repair/upgrade→["install"]，hygiene→["state"]。被拒 → 捕获断言错误并
 *   以 PERMISSION_DENIED 结构化 content 返回、绝不执行（宿主文档建议 rethrow，
 *   本裁定显式选择结构化返回：AI 调用方可见拒绝原因并可引导用户授权，裁定优先）。
 *   permission 域缺失（非宿主调用）→ PERMISSION_GATE_UNAVAILABLE 显式报错，
 *   禁止任何"跳过权限"的静默旁路。
 * - R-t3（repair 幂等）：bin 健康（present ∧ 未漂移 ∧ 备份有效）时返回
 *   already-healthy 结构化结果（非错误）；显式 fixAutoupdate 请求在幂等路径
 *   同样生效（fixAutoupdateFlag 独立审计，透传不丢弃）；无备份场景的
 *   BIN_MISSING_NO_BACKUP 由 repairInstall 抛出、经 R-t1 以 content 返回。
 * - R-t6（文件组织）：M1 六工具 + M2 run 单文件实现（约 750 行）；T3-06 目标域
 *   六工具与回呼轮询独立成 goal-tools.ts（server.ts 行数纪律 ≤1000，裁决先例
 *   同 T1-05 upgrade.ts），本文件只做装配。
 *
 * 可注入依赖（ToolDeps，测试与宿主两种装配路径）：
 * - 生产：default 导出 buildPlugin()——config 取 loadConfig()（环境变量/默认值），
 *   permission 取宿主注入的 context.permission；
 * - 测试：buildPlugin(deps) 注入 configOverrides/exec/fetcher/extract/kernelDataDir，
 *   配合 fake ctx（捕获 editor + fake permission）直调 execute，绝不触碰真实 HOME、
 *   绝不联网、绝不真跑 codearts 二进制。
 *
 * 宿主契约（@opencode/plugin 2.2.3，实测 dist 类型）：
 * - Plugin.define({ id, setup })；setup(context) 内经 context.tool.transform 拿到
 *   ToolEditor，editor.add({ name, input, description, execute, options }) 注册工具；
 * - options.namespace = "codearts" + name ⇒ 对外有效名 codearts_<name>；
 * - execute 返回 Tool.Result：本插件统一返回 { content: [JSON 摘要, 人类可读文本] }
 *   （content[0]=机器可读 JSON，content[1]=中文简报），不用 output 字段。
 */
import { Plugin } from "@opencode/plugin";
import type { BridgeConfig } from "./core/config";
import { PLUGIN_ID, PLUGIN_VERSION, TOOL_NAMESPACE, loadConfig, readAksk } from "./core/config";
import { BridgeError } from "./core/errors";
import {
  collectHealth,
  applyHygiene,
  planHygiene,
} from "./core/health";
import {
  createNodeExec,
  ensureBackup,
  fixAutoupdateFlag,
  probeInstall,
  repairInstall,
} from "./core/install";
import type { Exec } from "./core/install";
import { appendInstallAudit } from "./core/install";
import { httpFetcher, upgradeInstall } from "./core/upgrade";
import type { Fetcher } from "./core/upgrade";
import {
  defaultBuildTransport,
  defaultRunClock,
  probeTmuxAvailable,
  runOnce,
} from "./core/run";
import type { RunClock, TransportSelection } from "./core/run";
import type { CodeartsTransport, SessionRef } from "./core/transport/types";
import {
  createGoalCallbackLoop,
  createGoalTools,
  daemonHttpFetcher,
  daemonRequest,
  defaultGoalPollLoop,
  GOAL_POLL_INTERVAL_MS,
} from "./goal-tools";
import type { DaemonFetcher, GoalNotifySnapshot, GoalPollLoop } from "./goal-tools";

/* ───── 工具层类型（最小结构；与宿主类型结构兼容） ───── */

/** 权限门所需的最小结构（@opencode/plugin 2.2.3 PermissionDomain.assert 子集）。 */
export interface PermissionGate {
  assert(input: {
    sessionID: string;
    agent?: string;
    action: string;
    resources: string[];
    save?: string[];
    metadata?: Record<string, unknown>;
    source?: { type: "tool"; messageID: string; id: string };
  }): Promise<void>;
}

/** 工具执行上下文的关心子集（宿主 ToolContext 的超集可结构赋值；goal-tools.ts 复用）。 */
export interface ToolCtxLike {
  readonly sessionID: string;
  readonly agent?: string;
  readonly messageID: string;
  readonly id: string;
  /**
   * 宿主进度通道（R-cr3；宿主 Tool.Context.progress）。缺省=无进度通道
   * （非宿主调用/测试），如实跳过——不是静默兜底，是通道缺失的显式语义。
   */
  readonly progress?: (update: Record<string, unknown>) => unknown;
  /**
   * 宿主取消信号（R-cr3）。缺省=不可取消（超时上限仍在——R-cr2 结构化超时结果）。
   */
  readonly signal?: AbortSignal;
}

/** 单个文本 content 项。 */
interface ToolTextContent {
  type: "text";
  text: string;
}

/** 本插件工具的统一定义形状（结构兼容宿主 Tool.Info；execute 返回 content）。 */
export interface BridgeToolDef {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options: { namespace: string };
  execute: (input: unknown, context: ToolCtxLike) => Promise<{ content: ToolTextContent[] }>;
}

/** M1 五管理工具 + M2 run + T3-06 目标域六工具名（注册顺序即此顺序；测试逐名精确断言）。 */
export const TOOL_NAMES = [
  "status",
  "repair",
  "upgrade",
  "health",
  "hygiene",
  "run",
  "goal_start",
  "goal_status",
  "goal_list",
  "goal_logs",
  "goal_control",
  "daemon_status",
] as const;

/** 权限动作名（R-t2 固定值；后续 M2/M3 若需细分再扩，不在 M1 拆分）。 */
export const MANAGE_ACTION = "codearts.manage";

/** buildPlugin / createTools 可注入依赖。 */
export interface ToolDeps {
  /** 显式配置覆盖（测试注入 fixture 路径；生产可由 opencode options 同名键覆盖）。 */
  configOverrides?: Partial<BridgeConfig>;
  /** 命令执行抽象（缺省 createNodeExec；测试注入 fake，绝不真跑二进制）。 */
  exec?: Exec;
  /** 升级物料获取（缺省 httpFetcher；测试注入 fake，绝不联网）。 */
  fetcher?: Fetcher;
  /** 解压注入（透传 upgradeInstall R-up8；测试注入避免真实 tar）。 */
  extract?: (packagePath: string, destDir: string) => Promise<void>;
  /** 内核数据目录（R-h3/R-hy5 传参口径；缺省 collectHealth 内部默认）。 */
  kernelDataDir?: string;
  /** 权限域（生产由宿主 context.permission 注入；缺省时管理工具显式报错，见 R-t2）。 */
  permission?: PermissionGate;
  /** 传输工厂（缺省 defaultBuildTransport；测试注入 FakeTransport，绝不 spawn）。 */
  buildTransport?: (sel: TransportSelection) => CodeartsTransport;
  /** tmux 可用性探测（缺省 probeTmuxAvailable；测试注入确定性结果）。 */
  tmuxProbe?: () => Promise<boolean>;
  /** run 时钟（缺省 defaultRunClock；测试注入 FakeClock 确定性驱动超时/节流）。 */
  clock?: RunClock;
  /**
   * 守护 HTTP 客户端（T3-06 R-g1；缺省 daemonHttpFetcher=全局 fetch；测试注入
   * fake 绝不联网）。目标域六工具与回呼轮询共用同一注入点。
   */
  daemonFetch?: DaemonFetcher;
  /**
   * goalId → 发起会话映射（T3-06 R-g3/R-g4；goal_start 写、回呼轮询读）。
   * 缺省内部新建 Map——buildPlugin 装配时显式传入同一实例给工具与轮询（测试
   * 注入共享 Map 以断言登记/通知目标）。
   */
  goalSessions?: Map<string, string>;
  /** 目标回呼轮询定时器宿主（缺省 defaultGoalPollLoop(30s, unref)；测试注入手动驱动）。 */
  goalPollLoop?: GoalPollLoop;
  /** 目标回呼轮询周期毫秒（缺省 GOAL_POLL_INTERVAL_MS=30000；仅注入 loop 时有意义）。 */
  goalPollIntervalMs?: number;
}

/* ───── content 装配（R-t1） ───── */

function textContent(text: string): ToolTextContent {
  return { type: "text", text };
}

/** 统一成功出口：content[0]=JSON 摘要（机器），content[1]=人类可读中文简报。 */
function toolOk(payload: unknown, human: string): { content: ToolTextContent[] } {
  return { content: [textContent(JSON.stringify(payload, null, 2)), textContent(human)] };
}

/** 未知异常 → INTERNAL 结构化（R-t1：message=String(e)）。 */
function toErrorPayload(e: unknown): { error: { code: string; message: string; remediation?: string } } {
  if (e instanceof BridgeError) {
    return {
      error: {
        code: e.code,
        message: e.message,
        ...(e.remediation !== undefined ? { remediation: e.remediation } : {}),
      },
    };
  }
  return { error: { code: "INTERNAL", message: String(e) } };
}

/** 未知异常的审计警告（R-t1：审计留痕；写失败由调用方 catch，不掩盖结构化错误）。 */
async function auditInternalWarning(cfg: BridgeConfig, tool: string, e: unknown): Promise<void> {
  await appendInstallAudit(cfg, {
    ts: new Date().toISOString(),
    kind: "tool.internal-error",
    tool,
    level: "warn",
    message: e instanceof Error ? (e.stack ?? e.message) : String(e),
  });
}

/**
 * 工具执行包装（R-t1 统一出口）：成功 → toolOk(载荷, 摘要器文本)；
 * 业务错误（含权限被拒）→ 结构化 error content；未知异常 → INTERNAL + 审计警告。
 */
function wrapTool(
  tool: string,
  summarize: (payload: Record<string, any>) => string,
  body: (input: Record<string, unknown> | undefined, ctx: ToolCtxLike) => Promise<unknown>,
  deps: { cfg: BridgeConfig },
): BridgeToolDef["execute"] {
  return async (rawInput, ctx) => {
    try {
      const payload = (await body(inputRecord(rawInput), ctx)) as Record<string, any>;
      return toolOk(payload, summarize(payload));
    } catch (e) {
      const payload = toErrorPayload(e);
      if (!(e instanceof BridgeError)) {
        // R-t1：未知异常审计警告（尽力而为；审计失败不得掩盖返回给调用方的错误）
        await auditInternalWarning(deps.cfg, tool, e).catch(() => undefined);
      }
      const remediation = payload.error.remediation !== undefined ? `；修复指引：${payload.error.remediation}` : "";
      return toolOk(payload, `codearts_${tool} 失败 [${payload.error.code}]：${payload.error.message}${remediation}`);
    }
  };
}

/* ───── 输入归一（显式报错，禁静默截断/钳位） ───── */

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

function optNonNegativeInt(input: Record<string, unknown> | undefined, key: string): number | undefined {
  const v = input?.[key];
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw new BridgeError("TOOL_INPUT_INVALID", `参数 ${key} 须为非负整数，实际为 ${JSON.stringify(v) ?? "undefined"}`);
  }
  return v;
}

/** 会话引用归一（run.session；非法形态显式报错，禁静默截断）。 */
function optSessionRef(input: Record<string, unknown> | undefined, key = "session"): SessionRef | undefined {
  const v = input?.[key];
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new BridgeError("TOOL_INPUT_INVALID", `参数 ${key} 须为对象 {kind,id}，实际为 ${typeof v}`);
  }
  const rec = v as Record<string, unknown>;
  const kind = rec.kind;
  const id = rec.id;
  if ((kind !== "structured" && kind !== "pty") || typeof id !== "string" || id.length === 0) {
    throw new BridgeError(
      "TOOL_INPUT_INVALID",
      `参数 ${key} 须为 {kind:"structured"|"pty", id:非空字符串}，实际为 ${JSON.stringify(v)}`,
    );
  }
  return { kind, id };
}

/* ───── 权限门（R-t2） ───── */

/**
 * 管理动作权限门：repair/upgrade 过 ["install"]，hygiene(apply=true) 过 ["state"]。
 * - permission 域缺失 → PERMISSION_GATE_UNAVAILABLE（显式，禁静默旁路）；
 * - 断言被拒 → PERMISSION_DENIED（由 wrapTool 以 content 返回，调用不执行）。
 */
async function assertManagePermission(
  permission: PermissionGate | undefined,
  ctx: ToolCtxLike,
  resources: readonly string[],
): Promise<void> {
  if (permission === undefined) {
    throw new BridgeError(
      "PERMISSION_GATE_UNAVAILABLE",
      "权限域未注入（permission.assert 不可用），拒绝执行管理动作",
      { remediation: "codearts_repair/upgrade/hygiene(apply=true) 必须经 opencode 宿主调用，由宿主注入权限域后重试" },
    );
  }
  try {
    await permission.assert({
      sessionID: ctx.sessionID,
      agent: ctx.agent,
      action: MANAGE_ACTION,
      resources: [...resources],
      save: [...resources],
      source: { type: "tool", messageID: ctx.messageID, id: ctx.id },
    });
  } catch (e) {
    // R-t2 裁定：被拒 → 结构化 PERMISSION_DENIED 返回且不执行（裁定优先于宿主 rethrow 建议，见头注）
    throw new BridgeError(
      "PERMISSION_DENIED",
      `权限校验未通过：${e instanceof Error ? e.message : String(e)}`,
      {
        remediation: "请在权限设置中允许 codearts.manage 动作，或在批准弹窗中确认后重试",
        cause: e,
      },
    );
  }
}

/* ───── 输入 schema（严格封闭：additionalProperties:false） ───── */

const EMPTY_INPUT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

const REPAIR_INPUT_SCHEMA = {
  type: "object",
  properties: {
    fixAutoupdate: {
      type: "boolean",
      description: "显式把 codearts_cli.json 的 autoupdate 修正为 false（默认不执行；幂等可重试）",
    },
  },
  additionalProperties: false,
} as const;

const UPGRADE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    version: {
      type: "string",
      description: "目标版本（须与官方 latest 渠道一致；缺省升级到 latest）",
    },
  },
  additionalProperties: false,
} as const;

const HYGIENE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    apply: {
      type: "boolean",
      description: "true=执行治理（走权限门并写审计）；缺省/false=只返回只读计划",
    },
    olderThanDays: {
      type: "integer",
      minimum: 0,
      description: "dump-*.heapsnapshot 保留天数（超过才清理；缺省 30）",
    },
    logsKeep: {
      type: "integer",
      minimum: 0,
      description: "kernel-*.log 保留个数（按 mtime 保留最近者；缺省 20）",
    },
  },
  additionalProperties: false,
} as const;

const RUN_INPUT_SCHEMA = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      minLength: 1,
      description: "注入目标会话的单轮 prompt 文本（非空）",
    },
    session: {
      type: "object",
      description: "续接的会话引用（上次 codearts_run 返回的 session；缺省新建会话）",
      properties: {
        kind: { type: "string", enum: ["structured", "pty"] },
        id: { type: "string", minLength: 1 },
      },
      required: ["kind", "id"],
      additionalProperties: false,
    },
    timeoutMs: {
      type: "integer",
      minimum: 1,
      description: "超时毫秒数（到时 stop 并返回结构化超时结果；缺省 120000）",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
} as const;

/* ───── 人类可读简报（content[1]） ───── */

function summarizeStatus(p: Record<string, any>): string {
  const i = p.install as Record<string, any>;
  return (
    `codearts_status：二进制在场=${i.present} 版本=${i.version ?? "未知"} 钉版=${i.pinState}` +
    ` 备份有效=${i.backupValid} autoupdate=${String(i.autoupdateFlag)}` +
    ` AK/SK=${(p.credentials as Record<string, any>).present ? "已配置" : "未配置"}` +
    ` 健康(db=${(p.health as Record<string, any>).dbBytes}B)`
  );
}

function summarizeRepair(p: Record<string, any>): string {
  if (p.status === "already-healthy") {
    return `codearts_repair：二进制健康，无需修复（幂等短路${p.fixAutoupdateApplied ? "；已按请求关停 autoupdate" : ""}）`;
  }
  return `codearts_repair：已从备份恢复 ${p.from} → ${p.to}（sha256=${p.sha256}，auditId=${p.auditId}）`;
}

function summarizeUpgrade(p: Record<string, any>): string {
  return `codearts_upgrade：${p.from} → ${p.to}（sha256=${p.sha256}，auditId=${p.auditId}）`;
}

function summarizeHealth(p: Record<string, any>): string {
  const h = p.health as Record<string, any>;
  return (
    `codearts_health：db=${h.dbBytes}B wal=${h.walBytes}B 转储=${h.dumps.files}个/${h.dumps.bytes}B` +
    ` 日志=${h.logsBytes}B 最近错误=${h.lastErrorsCount}条`
  );
}

function summarizeHygiene(p: Record<string, any>): string {
  const kinds = (p.plan as Array<{ kind: string }>).map((a) => a.kind).join("+") || "无动作";
  if (p.status === "planned") {
    return `codearts_hygiene：只读计划（未执行）[${kinds}]`;
  }
  return `codearts_hygiene：已执行 [${(p.applied as string[]).join("+")}]（auditId=${p.auditId}）`;
}

function summarizeRun(p: Record<string, any>): string {
  const summary = typeof p.summary === "string" && p.summary.length > 0 ? ` 摘要="${p.summary}"` : "（无捕获输出）";
  return `codearts_run：${p.status} mode=${p.mode} 信号=${p.signals} 错误=${p.errors}${summary}`;
}

/* ───── opencode options → 配置覆盖（生产可配置路径；合法性由 loadConfig 显式校验） ───── */

const OPTION_CONFIG_KEYS = ["installDir", "stateDir", "akskFile"] as const;

function configOverridesFromOptions(options: unknown): Partial<BridgeConfig> {
  const out: Partial<BridgeConfig> = {};
  if (typeof options !== "object" || options === null) return out;
  const rec = options as Record<string, unknown>;
  for (const key of OPTION_CONFIG_KEYS) {
    const v = rec[key];
    if (v !== undefined) {
      if (typeof v !== "string") {
        throw new BridgeError("TOOL_INPUT_INVALID", `插件 options.${key} 须为字符串路径，实际为 ${typeof v}`);
      }
      out[key] = v;
    }
  }
  return out;
}

/* ───── 工具集装配 ───── */

/**
 * 构造五个 M1 工具定义（deps 注入；setup 与测试共用同一装配路径）。
 * 业务编排说明：
 * - repair 顺序 = 任务书接口：权限门 → 幂等检查（R-t3）→ repairInstall → ensureBackup；
 *   ensureBackup 在修复成功后刷新备份（派生物幂等），失败如实报错（不掩盖已成功的修复，
 *   修复本身已留 repair 审计）。
 * - hygiene：先 planHygiene（纯只读），apply=true 才过权限门并 applyHygiene(同一条计划)
 *   （R-hy4 执行清单=计划清单由 applyHygiene 的清单执行语义保证）。
 */
export function createTools(deps: ToolDeps = {}): BridgeToolDef[] {
  const cfg = loadConfig(deps.configOverrides ?? {});
  const exec = deps.exec ?? createNodeExec();
  const fetcher = deps.fetcher ?? httpFetcher;
  const permission = deps.permission;
  const kernelDataDir = deps.kernelDataDir;
  // T3-06：目标域共享装配（会话表由 buildPlugin 显式传入；直调 createTools 的测试
  // 场景缺省内部新建——与回呼轮询隔离，仅工具自身登记仍可测）
  const goalSessions = deps.goalSessions ?? new Map<string, string>();
  const daemonFetcher = deps.daemonFetch ?? daemonHttpFetcher;
  // R-h3/R-hy5：kernelDataDir 传参口径——未注入时交由 core 层默认（真实 HOME 口径）
  const healthOpts = (): { kernelDataDir?: string } =>
    kernelDataDir !== undefined ? { kernelDataDir } : {};
  const wrap = (
    tool: string,
    summarize: (payload: Record<string, any>) => string,
    body: (input: Record<string, unknown> | undefined, ctx: ToolCtxLike) => Promise<unknown>,
  ): BridgeToolDef["execute"] => wrapTool(tool, summarize, body, { cfg });

  const statusTool: BridgeToolDef = {
    name: "status",
    description:
      "codearts CLI 安装管家状态总览：二进制在场/版本/钉版一致性/备份有效性/autoupdate 开关、" +
      "AK/SK 配置存在性（只报存在性，绝不回显凭据值）、内核健康摘要（db/WAL/转储/日志/最近错误数）、" +
      "传输与守护接入状态（M2 占位）。只读工具，不需要权限。",
    input: EMPTY_INPUT_SCHEMA,
    options: { namespace: TOOL_NAMESPACE },
    execute: wrap("status", summarizeStatus, async () => {
      const probe = await probeInstall(cfg, { exec });
      const aksk = await readAksk(cfg.akskFile);
      const health = await collectHealth(cfg, healthOpts());
      return {
        bridge: { version: PLUGIN_VERSION },
        install: {
          path: probe.path,
          present: probe.present,
          version: probe.version,
          pinState: probe.pinState,
          drift: probe.drift,
          pinnedVersion: probe.pinned?.version,
          backupPath: probe.backupPath,
          backupValid: probe.backupValid,
          autoupdateFlag: probe.autoupdateFlag,
        },
        credentials: { akskFile: cfg.akskFile, present: aksk !== undefined },
        health: {
          dbBytes: health.dbBytes,
          walBytes: health.walBytes,
          dumps: health.dumps,
          logsBytes: health.logs.bytes,
          lastErrorsCount: health.lastErrors.length,
          kernelRssFromLog: health.kernelRssFromLog,
          rssBytes: health.rssBytes,
        },
        transport: {
          configured: cfg.transport,
          ptyHost: cfg.ptyHost,
          daemonUrl: cfg.daemonUrl,
          connected: false,
          note: "run 工具按轮构建传输（R-cr1 选择）；目标域工具经守护 HTTP 薄代理（T3-06，daemonUrl）；daemon 常驻通道仍未接入（connected=false 为如实状态）",
        },
      };
    }),
  };

  const repairTool: BridgeToolDef = {
    name: "repair",
    description:
      "自愈修复 codearts CLI 安装：从有效备份原子恢复二进制（校验→部署→复验→审计），" +
      "可选 fixAutoupdate 显式关停自动升级。二进制健康时幂等返回 already-healthy（非错误）。" +
      "需要权限（codearts.manage / install）。",
    input: REPAIR_INPUT_SCHEMA,
    options: { namespace: TOOL_NAMESPACE },
    execute: wrap("repair", summarizeRepair, async (input, ctx) => {
      await assertManagePermission(permission, ctx, ["install"]);
      const fixAutoupdate = optBoolean(input, "fixAutoupdate") === true;
      const probe = await probeInstall(cfg, { exec });
      // R-t3 幂等口径：在场 ∧ 未漂移 ∧ 备份有效 = 健康（不触发任何修复动作）
      const healthy = probe.present && probe.pinState !== "drift" && probe.backupValid;
      if (healthy) {
        // 健康短路不丢弃显式 fixAutoupdate 请求（R-t3 透传；独立审计、幂等）
        let fixAutoupdateApplied = false;
        if (fixAutoupdate) {
          await fixAutoupdateFlag(cfg);
          fixAutoupdateApplied = true;
        }
        return {
          status: "already-healthy",
          fixAutoupdateRequested: fixAutoupdate,
          fixAutoupdateApplied,
          install: {
            path: probe.path,
            version: probe.version,
            pinState: probe.pinState,
            backupValid: probe.backupValid,
          },
        };
      }
      // 修复路径：fixAutoupdate 透传给 repairInstall（止血优先，其内部先关停再恢复）
      const repair = await repairInstall(cfg, exec, { fixAutoupdate });
      // 任务书接口顺序：repairInstall → ensureBackup（恢复后的二进制刷新备份，派生物幂等）
      await ensureBackup(cfg, exec);
      return {
        status: "repaired",
        fixAutoupdateRequested: fixAutoupdate,
        action: repair.action,
        from: repair.from,
        to: repair.to,
        sha256: repair.sha256,
        auditId: repair.auditId,
      };
    }),
  };

  const upgradeTool: BridgeToolDef = {
    name: "upgrade",
    description:
      "受控升级 codearts CLI 到官方最新版（或指定版本）：下载→哈希校验→解压→自检→" +
      "同数据集暂存→原子部署→复验→旧版转备份，任何失败零损坏。需要权限（codearts.manage / install）。",
    input: UPGRADE_INPUT_SCHEMA,
    options: { namespace: TOOL_NAMESPACE },
    execute: wrap("upgrade", summarizeUpgrade, async (input, ctx) => {
      await assertManagePermission(permission, ctx, ["install"]);
      const version = optString(input, "version");
      const result = await upgradeInstall(
        cfg,
        { exec, fetcher, ...(deps.extract !== undefined ? { extract: deps.extract } : {}) },
        version !== undefined ? { version } : {},
      );
      return { status: "upgraded", ...result };
    }),
  };

  const healthTool: BridgeToolDef = {
    name: "health",
    description:
      "codearts 内核健康体检（只读）：托管进程 RSS、db/WAL 字节、堆转储计数与字节、日志总量、" +
      "最近错误摘要（规范化去重 ≤20 条）、内核自报 RSS。注意：真实环境全量扫读内核日志，" +
      "单次采样可达约 14 秒。不需要权限。",
    input: EMPTY_INPUT_SCHEMA,
    options: { namespace: TOOL_NAMESPACE },
    execute: wrap("health", summarizeHealth, async () => {
      const snapshot = await collectHealth(cfg, healthOpts());
      return { status: "ok", health: snapshot };
    }),
  };

  const hygieneTool: BridgeToolDef = {
    name: "hygiene",
    description:
      "磁盘/状态治理：清理到期堆转储（dump-*.heapsnapshot）、WAL checkpoint 收缩、" +
      "轮转内核日志。默认只返回只读计划（apply=false/缺省）；apply=true 执行计划并写审计，" +
      "需要权限（codearts.manage / state）。",
    input: HYGIENE_INPUT_SCHEMA,
    options: { namespace: TOOL_NAMESPACE },
    execute: wrap("hygiene", summarizeHygiene, async (input, ctx) => {
      const apply = optBoolean(input, "apply") === true;
      const olderThanDays = optNonNegativeInt(input, "olderThanDays");
      const logsKeep = optNonNegativeInt(input, "logsKeep");
      const plan = await planHygiene(cfg, {
        ...(olderThanDays !== undefined ? { olderThanDays } : {}),
        ...(logsKeep !== undefined ? { logsKeep } : {}),
        ...healthOpts(),
      });
      if (!apply) {
        return { status: "planned", plan };
      }
      // R-t2：apply 是改状态动作，必须过权限门（resources/save=["state"]）
      await assertManagePermission(permission, ctx, ["state"]);
      const { applied, auditId } = await applyHygiene(cfg, plan, healthOpts());
      return { status: "applied", plan, applied, auditId };
    }),
  };

  const runTool: BridgeToolDef = {
    name: "run",
    description:
      "向目标 codearts 会话注入单轮 prompt 并观察响应（T2-05）：传输按配置选择（R-cr1 auto：" +
      "有 AK/SK→structured，否则→pty[tmux/script]，结果含 mode+reason 无静默切换）；timeoutMs 到或" +
      "取消信号触发 stop 并返回结构化结果（含已捕获输出摘要，超时非错误）；进度经 context.progress " +
      "上报（注入后至少一次，其后按 2s 节流）；审计 run.start/run.exit（prompt 只记长度与前 80 字符）。" +
      "返回 {status, session, summary, signals, mode, reason, auditId}；error 信号附 retryable 标记" +
      "（不静默重试）。run 非管理动作，无需权限。",
    input: RUN_INPUT_SCHEMA,
    options: { namespace: TOOL_NAMESPACE },
    execute: wrap("run", summarizeRun, async (input, ctx) => {
      // 参数归一：prompt 必填非空（空串在此报错，非宿主 schema 校验的替代——两道防线同码）
      const prompt = optString(input, "prompt");
      if (prompt === undefined || prompt.length === 0) {
        throw new BridgeError("TOOL_INPUT_INVALID", "参数 prompt 须为非空字符串");
      }
      const timeoutMs = optNonNegativeInt(input, "timeoutMs");
      const session = optSessionRef(input);
      // R-cr3：宿主 progress/signal 经上下文透传（缺省=无进度/不可取消，runOnce 显式文档）
      return await runOnce({
        cfg,
        prompt,
        ...(session !== undefined ? { session } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(ctx.progress !== undefined ? { progress: (u: { status: string }) => ctx.progress!(u) } : {}),
        ...(ctx.signal !== undefined ? { signal: ctx.signal } : {}),
        ...(deps.buildTransport !== undefined ? { buildTransport: deps.buildTransport } : {}),
        ...(deps.tmuxProbe !== undefined ? { tmuxProbe: deps.tmuxProbe } : {}),
        ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
        ...(kernelDataDir !== undefined ? { kernelDataDir } : {}), // R-p2 日志源传参口径
      });
    }),
  };

  // T3-06：目标域六工具（守护薄代理 R-g1/R-g2；领域校验在守护侧，本层只装配）
  const goalTools = createGoalTools({
    cfg,
    fetcher: daemonFetcher,
    sessions: goalSessions,
    wrap,
  });

  return [statusTool, repairTool, upgradeTool, healthTool, hygieneTool, runTool, ...goalTools];
}

/* ───── 插件装配 ───── */

/**
 * 构建插件定义（deps 注入点）。生产用 default 导出（无 deps）；
 * 测试注入 fake 依赖并配合 fake ctx（捕获 editor + fake permission）直调 execute。
 */
export function buildPlugin(deps: ToolDeps = {}): Plugin.Plugin {
  return Plugin.define({
    id: PLUGIN_ID,
    setup: async (context) => {
      /**
       * 运行时不兼容守卫（依 SDD 台账 Ruling（2026-10-31，修复环 I1），T1-08 保持）：
       * 若宿主注入的上下文不含 tool.transform（如旧版 opencode 的插件契约），
       * 显式 throw 拒绝加载——宿主会以 "failed to load plugin" 记录，可见性远优于
       * console.error 后静默跳过。仓库铁律：出错即显式报错，禁止任何形式的静默退化。
       */
      const transform = context.tool?.transform;
      if (typeof transform !== "function") {
        throw new Error(
          `[codearts-bridge] 插件上下文不兼容：缺少 context.tool.transform` +
            `（插件 id=${PLUGIN_ID}）。期望契约：opencode V2 插件 API` +
            `（@opencode/plugin 2.x）注入的 setup(context) 须提供 context.tool.transform；` +
            `当前宿主版本过旧或插件加载路径错误，拒绝注册工具。`,
        );
      }

      // 权限域来自宿主上下文（R-t2）；配置覆盖优先级：deps（测试）> opencode options > env > 默认值
      // R-g3/R-g4：会话表单实例共享——goal_start 写、回呼轮询读（deps 未注入时
      // 此处新建并下发，杜绝"工具与轮询各持一份"的分裂）
      const goalSessions = deps.goalSessions ?? new Map<string, string>();
      const tools = createTools({
        ...deps,
        configOverrides: {
          ...(deps.configOverrides ?? {}),
          ...configOverridesFromOptions(context.options),
        },
        goalSessions,
        permission: context.permission as PermissionGate | undefined,
      });

      const registration = await transform((editor) => {
        for (const tool of tools) {
          editor.add(tool as Parameters<typeof editor.add>[0]);
        }
      });

      // R-g3 目标回呼轮询：setup 注册、unload 清理（见 goal-tools.ts 头注）。
      // 宿主 session 域缺失（测试/非宿主上下文）→ 无通知通道，通知转 skipped 审计
      //（显式语义，非静默兜底）；配置与工具层同一覆盖口径（纯函数二次解析）。
      const pollCfg = loadConfig({
        ...(deps.configOverrides ?? {}),
        ...configOverridesFromOptions(context.options),
      });
      const pollFetcher = deps.daemonFetch ?? daemonHttpFetcher;
      const hostSynthetic = context.session?.synthetic;
      const callback = createGoalCallbackLoop({
        cfg: pollCfg,
        fetcher: pollFetcher,
        listGoals: async () =>
          (await daemonRequest({ cfg: pollCfg, fetcher: pollFetcher }, {
            method: "GET",
            path: "/goals",
          })) as GoalNotifySnapshot[],
        sessions: goalSessions,
        synthetic:
          hostSynthetic !== undefined
            ? (input: { sessionID: string; text: string }) => hostSynthetic(input)
            : undefined,
        audit: (entry: Record<string, unknown>) => appendInstallAudit(pollCfg, entry),
        loop: deps.goalPollLoop ?? defaultGoalPollLoop(deps.goalPollIntervalMs ?? GOAL_POLL_INTERVAL_MS),
      });

      // 宿主卸载：停轮询（R-g3 unload 清理）+ 释放注册句柄；恒返回清理函数
      //（即使 registration 缺席，轮询定时器也必须被摘除）
      return async () => {
        callback.stop();
        if (registration) {
          await registration.dispose();
        }
      };
    },
  });
}

/** 生产入口：配置取环境变量/默认值，权限域在 setup 时从宿主上下文接线。 */
export default buildPlugin();
