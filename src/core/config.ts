/**
 * codearts-bridge 配置与状态根（T1-02）。
 *
 * 职责：
 * - `BridgeConfig` 类型与默认值（状态根 ~/.codearts-bridge、安装目录 ~/.codeartsdoer/installers）；
 * - `loadConfig`：三层优先级 显式 overrides > 环境变量 CODEARTS_BRIDGE_* > 默认值；
 * - `ensureStateDirs`：状态根及子目录（goals/audit/health/logs/tmp）创建并确保 mode 0700；
 * - `readAksk`：解析 AK/SK env 文件；缺失（ENOENT）→ undefined（"未配置"是显式状态），
 *   其他读取错误（EACCES/EISDIR 等）→ 显式抛出，绝不静默。
 *
 * 设计约束（依 SDD 主控裁定 2026-10-31 与仓库铁律）：
 * - 纯函数优先：`loadConfig` 不做任何 FS I/O；默认值经 `os.homedir()` 推导，
 *   测试与调用方一律通过 overrides/env 注入绝对路径控制 FS 落点（禁止触碰真实 HOME）。
 * - 禁静默兜底：非法枚举值/相对路径/空环境变量/非法阈值 → 就地显式抛错（消息含字段名）。
 * - `readAksk` 解析出的凭据值绝不进入日志或错误消息（错误消息只允许出现键名、
 *   路径与行号等存在性信息）。
 *
 * 环境变量映射表（前缀 `CODEARTS_BRIDGE_` + 字段名 SCREAMING_SNAKE）：
 *   CODEARTS_BRIDGE_INSTALL_DIR → installDir
 *   CODEARTS_BRIDGE_STATE_DIR   → stateDir
 *   CODEARTS_BRIDGE_TRANSPORT   → transport（auto/structured/pty）
 *   CODEARTS_BRIDGE_PTY_HOST    → ptyHost（auto/tmux/script）
 *   CODEARTS_BRIDGE_DAEMON_URL  → daemonUrl（http/https URL）
 *   CODEARTS_BRIDGE_AKSK_FILE   → akskFile
 *   CODEARTS_BRIDGE_AUTO_NUDGE  → autoNudge（仅接受 "true"/"false"）
 *   thresholds 无环境变量映射（嵌套对象，仅 overrides 可设，避免碎片化键名）。
 */

import { chmod, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";

/* ───── 既有常量（T1-01 占位，保持不变；server.ts 与测试在用） ───── */

/** 插件唯一标识（opencode plugin id）。 */
export const PLUGIN_ID = "codearts-bridge";

/** 工具命名空间：全部 codearts_* 工具统一挂在 codearts 命名空间下。 */
export const TOOL_NAMESPACE = "codearts";

/** smoke 工具在命名空间内的名称；对外有效名为 `${TOOL_NAMESPACE}_${SMOKE_TOOL_NAME}`（即 codearts_status）。 */
export const SMOKE_TOOL_NAME = "status";

/** 插件版本（骨架阶段固定 "dev"；正式版本号由发布脚本在发版期接管，禁止在编译期注入）。 */
export const PLUGIN_VERSION = "dev";

/* ───── 类型与默认值 ───── */

/** 长任务看护阈值（秒/毫秒，均须为非负有限数字）。 */
export interface Thresholds {
  stallSeconds: number;
  retryCapSeconds: number;
  strikes: number;
  echoGuardMs: number;
}

/** AK/SK 凭据（readAksk 返回；字段仅在实际存在时出现）。 */
export interface Aksk {
  AK?: string;
  SK?: string;
}

/** 全局配置（状态根 + 传输 + 守护 + 凭据文件 + 看护阈值）。 */
export interface BridgeConfig {
  installDir: string; // 默认 ~/.codeartsdoer/installers
  stateDir: string; // 默认 ~/.codearts-bridge
  transport: "auto" | "structured" | "pty";
  ptyHost: "auto" | "tmux" | "script";
  daemonUrl: string; // 默认 http://127.0.0.1:4577
  akskFile: string; // 默认 <stateDir>/config.env
  thresholds: Thresholds;
  autoNudge: boolean; // 默认 true（主控裁决 2026-10-31：目标会话默认自动续跑；false 为显式退出的高级选项）
  /**
   * 2026-11-02 模型轮换（用户裁决：429 等模型类错误持续时切换模型而非盲重试）：
   * 轮换清单（provider/model 形态，经官方 CLI -m 旗标重启会话）。空数组 = 禁用
   * 轮换（维持无限重试原语义）。env: CODEARTS_BRIDGE_FAILOVER_MODELS（逗号分隔）。
   */
  failoverModels: string[];
  /** 连续模型类错误达此数 → 轮换下一模型。默认 6。env: CODEARTS_BRIDGE_FAILOVER_AFTER。 */
  failoverAfterConsecutive: number;
}

/** 环境变量注入源：键值对，undefined 视为未设置。 */
type Env = Record<string, string | undefined>;

const ENV_PREFIX = "CODEARTS_BRIDGE_";

const DEFAULT_DAEMON_URL = "http://127.0.0.1:4577";

/** 阈值默认值（裁定 5）：stall 240s / 重试上限 60s / 连击 3 次 / 回显守卫 45000ms。 */
const DEFAULT_THRESHOLDS: Thresholds = {
  // 运维热修（2026-11-01）：进度检测按协议行（[GOAL-STEP]）判定，编译/测试等
  // 长静默相位会被误判 stall 并反复注入打断（60s 一轮实证）。240s 给构建循环
  // 留出整周期；协议行一旦出现即重置计时，不影响真挂起的发现速度量级。
  stallSeconds: 240,
  retryCapSeconds: 60,
  strikes: 3,
  // 运维热修（2026-11-01）：TUI 冷启动含 403 重试/keyring 失败/自升级下载，30s+；
  // 原 3000ms 守卫窗口内回显尚未到达，注入文本被误认申报。45000ms 实证安全带。
  echoGuardMs: 45000,
};

/** 状态根子目录（裁定 4）。 */
const STATE_SUBDIRS = ["goals", "audit", "health", "logs", "tmp"] as const;

const TRANSPORT_VALUES = ["auto", "structured", "pty"] as const;
const PTY_HOST_VALUES = ["auto", "tmux", "script"] as const;

/* ───── 校验助手（全部显式报错，无默认值兜底） ───── */

/** 带 errno 的错误形态（仅取 code，避免依赖具体 Node 类型命名空间）。 */
interface ErrnoLike {
  code?: string;
}

/** 统一错误出口：所有配置错误的唯一抛出点，便于测试与审计。 */
function fail(message: string): never {
  throw new Error(`[codearts-bridge] ${message}`);
}

/** 值的简短表示（用于错误消息；配置字段均非敏感值）。 */
function repr(value: unknown): string {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function requireNonEmptyString(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${field} 必须为非空字符串，实际为 ${repr(value)}`);
  }
  return value;
}

function requireAbsolutePath(field: string, value: string): string {
  if (!path.isAbsolute(value)) {
    fail(`${field} 必须为绝对路径（FS 落点禁止依赖 cwd），实际为 ${repr(value)}`);
  }
  return value;
}

function requireEnum<T extends string>(field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(`${field} 必须为 ${allowed.join("/")} 之一，实际为 ${repr(value)}`);
  }
  return value as T;
}

function requireBoolean(field: string, value: unknown): boolean {
  if (typeof value !== "boolean") {
    fail(`${field} 必须为布尔值，实际为 ${repr(value)}`);
  }
  return value;
}

function requireNonNegativeNumber(field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    fail(`${field} 必须为非负有限数字，实际为 ${repr(value)}`);
  }
  return value;
}

function requireThresholds(value: unknown): Thresholds {
  if (typeof value !== "object" || value === null) {
    fail(`thresholds 必须为对象，实际为 ${repr(value)}`);
  }
  const t = value as Record<string, unknown>;
  // 逐一显式校验四个键；缺失/非法键立即报错（Partial 形态不被静默接受）
  return {
    stallSeconds: requireNonNegativeNumber("thresholds.stallSeconds", t.stallSeconds),
    retryCapSeconds: requireNonNegativeNumber("thresholds.retryCapSeconds", t.retryCapSeconds),
    strikes: requireNonNegativeNumber("thresholds.strikes", t.strikes),
    echoGuardMs: requireNonNegativeNumber("thresholds.echoGuardMs", t.echoGuardMs),
  };
}

function requireDaemonUrl(value: unknown): string {
  const v = requireNonEmptyString("daemonUrl", value);
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    fail(`daemonUrl 必须为合法 URL，实际为 ${repr(v)}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    fail(`daemonUrl 协议必须为 http/https，实际为 ${repr(v)}`);
  }
  return v;
}

/* ───── 环境变量读取 ───── */

/** 读取带前缀环境变量；未设置 → undefined；设置为空串 → 显式报错（不当作未设置）。 */
function envValue(env: Env, suffix: string): string | undefined {
  const key = ENV_PREFIX + suffix;
  const raw = env[key];
  if (raw === undefined) return undefined;
  if (raw.length === 0) {
    fail(`环境变量 ${key} 为空字符串（如未设置请删去该变量，而非留空）`);
  }
  return raw;
}

/** 读取布尔环境变量；仅接受字面量 "true"/"false"，其余显式报错。 */
function envBool(env: Env, suffix: string): boolean | undefined {
  const raw = envValue(env, suffix);
  if (raw === undefined) return undefined;
  if (raw === "true") return true;
  if (raw === "false") return false;
  fail(`环境变量 ${ENV_PREFIX + suffix} 仅接受 "true"/"false"，实际为 ${repr(raw)}`);
}

/* ───── loadConfig ───── */

/**
 * 解析全局配置。纯函数（无 FS I/O）；优先级：overrides > env > 默认值。
 *
 * @param overrides 显式覆盖（opencode options / 调用方传参），字段级生效
 * @param env       环境变量源；测试传 {} 与真实 process.env 隔离，缺省用 process.env
 */
export function loadConfig(
  overrides: Partial<BridgeConfig> = {},
  env: Env = process.env,
): BridgeConfig {
  // 状态根先解析（akskFile 默认值依赖它）
  const stateDir =
    overrides.stateDir !== undefined
      ? requireAbsolutePath("stateDir", requireNonEmptyString("stateDir", overrides.stateDir))
      : pickEnvPath(env, "STATE_DIR") ?? path.join(homedir(), ".codearts-bridge");

  const installDir =
    overrides.installDir !== undefined
      ? requireAbsolutePath("installDir", requireNonEmptyString("installDir", overrides.installDir))
      : pickEnvPath(env, "INSTALL_DIR") ?? path.join(homedir(), ".codeartsdoer", "installers");

  const akskFile =
    overrides.akskFile !== undefined
      ? requireAbsolutePath("akskFile", requireNonEmptyString("akskFile", overrides.akskFile))
      : pickEnvPath(env, "AKSK_FILE") ?? path.join(stateDir, "config.env");

  const transportEnv = envValue(env, "TRANSPORT");
  const transport =
    overrides.transport !== undefined
      ? requireEnum("transport", overrides.transport, TRANSPORT_VALUES)
      : transportEnv !== undefined
        ? requireEnum("transport", transportEnv, TRANSPORT_VALUES)
        : "auto";

  const ptyHostEnv = envValue(env, "PTY_HOST");
  const ptyHost =
    overrides.ptyHost !== undefined
      ? requireEnum("ptyHost", overrides.ptyHost, PTY_HOST_VALUES)
      : ptyHostEnv !== undefined
        ? requireEnum("ptyHost", ptyHostEnv, PTY_HOST_VALUES)
        : "auto";

  const daemonUrlEnv = envValue(env, "DAEMON_URL");
  const daemonUrl =
    overrides.daemonUrl !== undefined
      ? requireDaemonUrl(overrides.daemonUrl)
      : daemonUrlEnv !== undefined
        ? requireDaemonUrl(daemonUrlEnv)
        : DEFAULT_DAEMON_URL;

  // 主控裁决 2026-10-31：默认 true——目标会话的存在意义是"跑到底"，停滞 60s 既不自动续跑
  // 也不告警即为静默挂起，违背"目标永不挂起"承诺；false 保留为显式退出的高级选项
  // （逐目标覆盖由 T3-05 定义）。
  const autoNudge =
    overrides.autoNudge !== undefined
      ? requireBoolean("autoNudge", overrides.autoNudge)
      : (envBool(env, "AUTO_NUDGE") ?? true);

  // thresholds 仅 overrides 可设（见头部映射表）；每次返回新对象，防调用方改写污染默认值
  const thresholds =
    overrides.thresholds !== undefined ? requireThresholds(overrides.thresholds) : { ...DEFAULT_THRESHOLDS };

  // 模型轮换（2026-11-02）：清单逐项校验 provider/model 形态；空数组 = 禁用
  const failoverModelsEnv = envValue(env, "FAILOVER_MODELS");
  const failoverRaw =
    overrides.failoverModels !== undefined
      ? overrides.failoverModels
      : failoverModelsEnv !== undefined && failoverModelsEnv.trim() !== ""
        ? failoverModelsEnv.split(",")
        : [];
  const failoverModels = failoverRaw.map((m) => m.trim()).filter((m) => m.length > 0);
  for (const m of failoverModels) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+$/.test(m)) {
      fail(`failoverModels 项非法（须为 provider/model 形态）：${JSON.stringify(m)}`);
    }
  }
  const failoverAfterEnv = envValue(env, "FAILOVER_AFTER");
  const failoverAfterConsecutive =
    overrides.failoverAfterConsecutive !== undefined
      ? overrides.failoverAfterConsecutive
      : failoverAfterEnv !== undefined
        ? Number(failoverAfterEnv)
        : 6;
  if (!Number.isInteger(failoverAfterConsecutive) || failoverAfterConsecutive < 1) {
    fail(`failoverAfterConsecutive 须为正整数，实际 ${JSON.stringify(failoverAfterConsecutive)}`);
  }

  return { installDir, stateDir, transport, ptyHost, daemonUrl, akskFile, thresholds, autoNudge, failoverModels, failoverAfterConsecutive };
}

/** 从 env 读取路径类字段并校验绝对路径；未设置返回 undefined。 */
function pickEnvPath(env: Env, suffix: string): string | undefined {
  const raw = envValue(env, suffix);
  if (raw === undefined) return undefined;
  return requireAbsolutePath(ENV_PREFIX + suffix, raw);
}

/* ───── ensureStateDirs ───── */

/**
 * 创建状态根及子目录 goals/audit/health/logs/tmp（裁定 4）：
 * - 目录 mode 一律 0700：mkdir 的 mode 会被 umask 掩蔽，故创建后再显式 chmod，
 *   确保与 umask 无关；
 * - 已存在目录不改动属主（mkdir/chmod 均不改 owner），仅确保 mode。
 */
export async function ensureStateDirs(cfg: BridgeConfig): Promise<void> {
  await mkdir(cfg.stateDir, { recursive: true, mode: 0o700 });
  await chmod(cfg.stateDir, 0o700);
  for (const sub of STATE_SUBDIRS) {
    const dir = path.join(cfg.stateDir, sub);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
}

/* ───── readAksk ───── */

/**
 * 读取 AK/SK env 文件（KEY=VALUE 行式格式，容忍 # 注释与空行）。
 *
 * 错误语义（裁定 2）：
 * - 文件不存在（ENOENT）→ undefined（"未配置"是显式状态）；
 * - 其他读取错误（EACCES/EISDIR 等）→ 抛出，消息含路径与原因码；
 * - 解析出的值绝不写入日志/错误消息（只允许键名、路径、行号）。
 *
 * 解析纪律（禁静默兜底）：
 * - 非 KEY=VALUE 形态的行、未知键（防拼写错误静默丢凭据）、重复键 → 显式抛出；
 * - 空值保留为空串（调用方自行决定如何处理，此处不做静默取舍）。
 */
export async function readAksk(file: string): Promise<Aksk | undefined> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (e) {
    const code = (e as ErrnoLike).code;
    if (code === "ENOENT") return undefined;
    const reason = code ?? (e instanceof Error ? e.name : "UNKNOWN");
    throw new Error(
      `[codearts-bridge] 读取 AK/SK 配置文件失败：path=${file} reason=${reason}`,
      { cause: e },
    );
  }
  return parseAksk(file, content);
}

/** env 文件解析（错误消息只含路径/行号/键名，绝不回显行内容）。 */
function parseAksk(file: string, content: string): Aksk {
  const result: Aksk = {};
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      fail(`AK/SK 配置文件格式错误（须为 KEY=VALUE 行）：path=${file} line=${i + 1}`);
    }
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();
    if (key === "AK" || key === "SK") {
      if (key in result) {
        fail(`AK/SK 配置文件键 "${key}" 重复定义：path=${file} line=${i + 1}`);
      }
      result[key] = value;
    } else {
      fail(`AK/SK 配置文件含未知键 "${key}"（仅允许 AK/SK）：path=${file} line=${i + 1}`);
    }
  }
  return result;
}
