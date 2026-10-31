/**
 * codearts-bridge doctor 环境体检（T4-05）。
 *
 * 职责：对"开箱即用"所需的全套组件做只读体检，逐项输出 ✓/⚠/✗ 与中文修复指引，
 * 并给出聚合退出码（任何 ✗ → 1）。八项检查（任务书顺序）：
 *   ① opencode 在场与版本（≥2.1 支持 V2 插件）      id=opencode
 *   ② bun 在场（PATH → ~/.bun/bin/bun 两路探测）    id=bun
 *   ③ codearts CLI 安装状态（probeInstall 只读快照） id=codearts-cli
 *   ④ 登录态（<kernelDataDir>/auth.json）或 AK/SK   id=credential
 *   ⑤ systemd 三单元在场性与 is-active              id=systemd
 *   ⑥ 守护 /health 可达（3s 超时）                  id=daemon
 *   ⑦ 磁盘占用（db/wal/dumps/logs，阈值告警）        id=disk
 *   ⑧ 官方 release-info 端点 HEAD（5s 超时，失败=⚠） id=network
 *
 * 结构纪律（任务书"纯逻辑与 IO 分离"）：
 * - 判定函数 judgeXxx(obs) 为纯函数：观察值（普通对象）→ DoctorCheck，全部单测覆盖；
 * - 采集器 collectXxx 负责真实 IO（注入 exec/fetch/目录），把一切失败归一为观察值
 *   （present/reachable/error 字段），绝不向上抛业务错误——体检的职责是"如实报告"
 *   而非中途夭折；采集层的意外 FS 错误也归一为 error 观察值以 ✗ 呈现；
 * - doctorCommand 负责输出（人类可读 + 结构化 JSON 双输出）与退出码聚合。
 *
 * 等级语义：
 * - ok  = 开箱可用；
 * - warn= 有缺陷但不阻塞核心功能（修复指引必附）；
 * - fail= 状态损坏/关键依赖缺失（聚合退出码 1）。
 * 网络（⑧）与守护（⑥）按任务书固定为 ⚠ 不阻塞——检查器自身失败除外。
 *
 * 隔离纪律：exec/fetch/homeDir/kernelDataDir 全部可注入；测试绝不触碰真实 HOME、
 * 绝不真实联网、绝不调用真实 systemctl（单元缺失时不发起任何 systemctl 调用）。
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { loadConfig, readAksk } from "./config";
import type { Aksk, BridgeConfig } from "./config";
import { BridgeError } from "./errors";
import { errnoOf } from "./fsx";
import { collectHealth } from "./health";
import { createNodeExec, probeInstall } from "./install";
import type { Exec, InstallStatus } from "./install";
import { SERVICE_UNIT_NAMES } from "./service";

/* ───── 结果模型 ───── */

/** 检查等级：ok=可用 / warn=有缺陷不阻塞 / fail=损坏或关键缺失。 */
export type CheckLevel = "ok" | "warn" | "fail";

/** 单项体检结果（id 稳定，供结构化消费方编程化分支）。 */
export interface DoctorCheck {
  id: string;
  level: CheckLevel;
  /** 人类可读一句话结论（✓/⚠/✗ 前缀由输出层添加）。 */
  summary: string;
  /** ⚠/✗ 时的中文修复指引。 */
  remediation?: string;
  /** 结构化细节（版本/字节/状态等；不含凭据值）。 */
  detail?: Record<string, unknown>;
}

/** 八项检查的稳定 id 与顺序（任务书 ①..⑧）。 */
export const DOCTOR_CHECK_IDS = [
  "opencode",
  "bun",
  "codearts-cli",
  "credential",
  "systemd",
  "daemon",
  "disk",
  "network",
] as const;

/** 与 cli.ts FetchLike 同形（该类型在 cli 层，core 不反向依赖；M78 双份同码先例）。 */
export type FetchLike = (url: URL | string, init?: RequestInit) => Promise<Response>;

/** 守护探活超时（与 cli.ts STATUS_TIMEOUT_MS 同口径 3s）。 */
export const DOCTOR_DAEMON_TIMEOUT_MS = 3_000;

/** 网络可达性 HEAD 超时（任务书固定 5s）。 */
export const DOCTOR_NETWORK_TIMEOUT_MS = 5_000;

/* ───── 磁盘阈值（⑦；字节） ───── */

export const DOCTOR_DISK_DUMPS_WARN_BYTES = 500 * 1024 * 1024; // 堆快照 500MB
export const DOCTOR_DISK_LOGS_WARN_BYTES = 1024 * 1024 * 1024; // 日志总量 1GB
export const DOCTOR_DISK_WAL_WARN_BYTES = 256 * 1024 * 1024; // WAL 256MB

/** opencode V2 插件契约的最低版本（任务书固定 ≥2.1）。 */
export const DOCTOR_OPENCODE_MIN = "2.1.0";

/** 内核数据目录缺省值（与 health.ts R-h3 缺省同口径；注入优先）。 */
const KERNEL_DATA_DIR_DEFAULT = ".codeartsdoer/cli-data";

/** 官方 release-info 端点（与 upgrade.ts RELEASE_INFO_URL 同源；HEAD 探活用）。 */
const NETWORK_PROBE_URL =
  "https://ide.cn-north-4.myhuaweicloud.com/v1/release-info/latest" +
  "?sub_product_name=cli-linux-x64&os_type=debian&arch=X86-64";

/* ───── 工具纯函数 ───── */

/** 字节的人类可读格式（体检文案用；非负整数，非法输入显式抛）。 */
export function humanBytes(bytes: number): string {
  if (!Number.isInteger(bytes) || bytes < 0) {
    throw new BridgeError("DOCTOR_INPUT_INVALID", `humanBytes 须为非负整数，实际为 ${String(bytes)}`);
  }
  if (bytes < 1024) return `${bytes}B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes;
  let unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)}${units[unit]}`;
}

/** 解析 x.y.z 三段版本号为数值元组；非法形态显式抛（禁静默钳位）。 */
function parseSemver(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (m === null) {
    throw new BridgeError("VERSION_PARSE_INVALID", `版本须为 x.y.z 形态，实际为 ${JSON.stringify(v)}`);
  }
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 语义化版本比较：a<b → -1；a==b → 0；a>b → 1。非法输入显式抛。 */
export function compareVersions(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** 从命令输出提取首个 x.y.z 版本串（stdout 优先、stderr 兜扫；与 install.ts R-d 同口径）。 */
function extractVersion(stdout: string, stderr: string): string | undefined {
  const re = /^\d+\.\d+\.\d+/m;
  return re.exec(stdout)?.[0] ?? re.exec(stderr)?.[0];
}

/* ───── 观察值类型（采集器输出 / 判定函数输入） ───── */

export interface OpencodeObservation {
  present: boolean;
  version?: string;
}

export interface BunObservation {
  present: boolean;
  version?: string;
}

export interface CodeartsObservation {
  status?: InstallStatus;
  error?: string;
}

export interface CredentialObservation {
  /** <kernelDataDir>/auth.json 存在且为常规文件（CLI 登录态）。 */
  authJsonExists: boolean;
  /** AK/SK 解析结果（readAksk；值仅用于判定，绝不进入 summary/detail）。 */
  aksk?: Aksk;
  error?: string;
}

export interface SystemdObservation {
  systemctlAvailable: boolean;
  units?: { daemon: boolean; watchdogService: boolean; watchdogTimer: boolean };
  active?: { daemon: boolean; watchdogTimer: boolean };
  error?: string;
}

export interface DaemonHealthObservation {
  ok: boolean;
  reason?: string;
}

export interface DiskObservation {
  dbBytes: number;
  walBytes: number;
  dumps: { files: number; bytes: number };
  logsBytes: number;
  error?: string;
}

export interface NetworkObservation {
  reachable: boolean;
  status?: number;
  reason?: string;
}

/* ───── 判定函数（纯逻辑） ───── */

/** ① opencode：未检出/版本<2.1/版本不可解析 → warn；≥2.1 → ok。 */
export function judgeOpencode(obs: OpencodeObservation): DoctorCheck {
  if (!obs.present) {
    return {
      id: "opencode",
      level: "warn",
      summary: "opencode 未检出（插件宿主缺失，codearts_* 工具无法自动加载）",
      remediation: "安装 opencode ≥2.1（https://opencode.ai）；安装后本插件经全局自动加载目录生效",
      detail: { present: false },
    };
  }
  if (obs.version === undefined) {
    return {
      id: "opencode",
      level: "warn",
      summary: "opencode 在场但版本无法解析（无法核验 V2 插件契约 ≥2.1）",
      remediation: "核查 opencode --version 输出；建议升级至 ≥2.1",
      detail: { present: true },
    };
  }
  let meetsMin = false;
  try {
    meetsMin = compareVersions(obs.version, DOCTOR_OPENCODE_MIN) >= 0;
  } catch {
    return {
      id: "opencode",
      level: "warn",
      summary: `opencode 版本 ${obs.version} 形态异常（无法核验 ≥${DOCTOR_OPENCODE_MIN}）`,
      detail: { present: true, version: obs.version },
    };
  }
  if (!meetsMin) {
    return {
      id: "opencode",
      level: "warn",
      summary: `opencode ${obs.version} 低于 V2 插件契约要求（≥${DOCTOR_OPENCODE_MIN}）`,
      remediation: `升级 opencode 至 ≥${DOCTOR_OPENCODE_MIN}（V2 插件 API 为本插件硬性依赖）`,
      detail: { present: true, version: obs.version },
    };
  }
  return {
    id: "opencode",
    level: "ok",
    summary: `opencode ${obs.version}（满足 V2 插件 ≥${DOCTOR_OPENCODE_MIN}）`,
    detail: { present: true, version: obs.version },
  };
}

/** ② bun：缺失 → fail（一切子命令的运行时）；在场 → ok。 */
export function judgeBun(obs: BunObservation): DoctorCheck {
  if (!obs.present) {
    return {
      id: "bun",
      level: "fail",
      summary: "bun 未检出（codearts-bridge 全部命令的运行时缺失）",
      remediation: "curl -fsSL https://bun.sh/install | bash（安装到 ~/.bun 后重开 shell 或将其加入 PATH）",
      detail: { present: false },
    };
  }
  return {
    id: "bun",
    level: "ok",
    summary: obs.version !== undefined ? `bun ${obs.version}` : "bun 在场（版本未解析）",
    detail: { present: true, version: obs.version ?? null },
  };
}

/** ③ codearts CLI：探测异常 → fail；未装 → warn；其余问题逐条汇总 → warn；健康 → ok。 */
export function judgeCodeartsCli(obs: CodeartsObservation): DoctorCheck {
  if (obs.error !== undefined) {
    return {
      id: "codearts-cli",
      level: "fail",
      summary: `codearts CLI 安装状态探测失败：${obs.error}`,
      remediation: "按错误码排障（codearts_repair 可自愈多数损坏）；状态不明时不假装健康",
      detail: { error: obs.error },
    };
  }
  const st = obs.status;
  if (st === undefined || !st.present) {
    return {
      id: "codearts-cli",
      level: "warn",
      summary: "codearts CLI 未安装（structured 传输与 codearts_* 安装管家不可用）",
      remediation: "执行 codearts-bridge upgrade-cli 从官方渠道安装",
      detail: { present: false },
    };
  }
  const issues: string[] = [];
  const fix: string[] = [];
  if (st.version === undefined) issues.push("版本无法解析");
  if (st.autoupdateFlag === true) {
    issues.push("官方 autoupdate 开启（自动升级可能破坏钉定或遗留 .delete 残局）");
    fix.push("以 codearts_repair（fixAutoupdate）关停自动升级");
  }
  if (st.pinState === "drift") {
    issues.push("二进制与钉版记录漂移");
    fix.push("codearts_repair 从备份恢复一致内容");
  }
  if (!st.backupValid) {
    issues.push("备份缺失或失效（自愈能力受限）");
    fix.push("codearts 管家可在二进制健康时刷新备份");
  }
  if (issues.length > 0) {
    return {
      id: "codearts-cli",
      level: "warn",
      summary: `codearts CLI ${st.version ?? "（版本未知）"}：${issues.join("；")}`,
      remediation: fix.join("；"),
      detail: {
        present: true,
        version: st.version ?? null,
        pinState: st.pinState,
        backupValid: st.backupValid,
        autoupdateFlag: st.autoupdateFlag ?? null,
      },
    };
  }
  return {
    id: "codearts-cli",
    level: "ok",
    summary: `codearts CLI ${st.version}（备份有效，钉定 ${st.pinState}）`,
    detail: { present: true, version: st.version, pinState: st.pinState, backupValid: st.backupValid },
  };
}

/** ④ 凭据：AK/SK 或 CLI 登录态任一在场 → ok；皆无 → warn；读取异常 → fail。 */
export function judgeCredential(obs: CredentialObservation): DoctorCheck {
  if (obs.error !== undefined) {
    return {
      id: "credential",
      level: "fail",
      summary: `凭据文件读取失败：${obs.error}`,
      remediation: "修正 AK/SK env 文件或登录态文件后重试（凭据值绝不回显）",
    };
  }
  const hasAksk = obs.aksk?.AK !== undefined && obs.aksk.AK !== "" && obs.aksk?.SK !== undefined && obs.aksk.SK !== "";
  if (hasAksk && obs.authJsonExists) {
    return { id: "credential", level: "ok", summary: "AK/SK 与 CLI 登录态均在场（structured 传输可用）", detail: { mode: "aksk+auth" } };
  }
  if (hasAksk) {
    return { id: "credential", level: "ok", summary: "AK/SK 已配置（structured 传输可用）", detail: { mode: "aksk" } };
  }
  if (obs.authJsonExists) {
    return { id: "credential", level: "ok", summary: "CLI 登录态在场（structured 传输可用）", detail: { mode: "auth" } };
  }
  return {
    id: "credential",
    level: "warn",
    summary: "未配置 AK/SK 且无 CLI 登录态（structured 传输不可用；run 将显式 AKSK_MISSING 或退 PTY 形态）",
    remediation: "codearts login 完成登录，或向 <stateDir>/config.env 写入 AK=/SK= 两行",
    detail: { mode: "none" },
  };
}

/** ⑤ systemd：非 systemd 环境/未安装/非 active → warn；三单元在场且 active → ok。 */
export function judgeSystemd(obs: SystemdObservation): DoctorCheck {
  if (obs.error !== undefined) {
    return {
      id: "systemd",
      level: "fail",
      summary: `systemd 单元状态核验失败：${obs.error}`,
      detail: { error: obs.error },
    };
  }
  if (!obs.systemctlAvailable) {
    const unitsPresent = obs.units?.daemon === true;
    return {
      id: "systemd",
      level: "warn",
      summary: unitsPresent
        ? "systemd 单元文件在场但 systemctl 不可用，无法核验运行状态"
        : "systemctl 不可用（非 systemd 环境），守护需手动管理",
      remediation: "前台启动：codearts-bridge daemon（SIGINT/SIGTERM 优雅停止）",
      detail: { systemctlAvailable: false, units: obs.units ?? null },
    };
  }
  const units = obs.units ?? { daemon: false, watchdogService: false, watchdogTimer: false };
  if (!units.daemon) {
    return {
      id: "systemd",
      level: "warn",
      summary: "systemd 守护单元未安装（开机自启/崩溃自愈缺位）",
      remediation: "执行 codearts-bridge service install（或重跑 install.sh）",
      detail: { units },
    };
  }
  const issues: string[] = [];
  const fix: string[] = [];
  if (!units.watchdogService || !units.watchdogTimer) {
    issues.push("watchdog 单元缺失（挂起自愈看门缺位）");
    fix.push("重跑 codearts-bridge service install 补齐");
  }
  if (obs.active !== undefined) {
    if (!obs.active.daemon) {
      issues.push(`守护单元非 active（${obs.active.daemon === false ? "inactive/failed" : "unknown"}）`);
      fix.push("journalctl --user -t codearts-bridge 排查后 systemctl --user restart codearts-bridge");
    }
    if (!obs.active.watchdogTimer && units.watchdogTimer) {
      issues.push("watchdog timer 非 active");
      fix.push("systemctl --user start codearts-bridge-watchdog.timer");
    }
  }
  if (issues.length > 0) {
    return {
      id: "systemd",
      level: "warn",
      summary: `systemd：${issues.join("；")}`,
      remediation: fix.join("；"),
      detail: { units, active: obs.active ?? null },
    };
  }
  return {
    id: "systemd",
    level: "ok",
    summary: "守护单元 active + watchdog timer active（崩溃/挂起双自愈在位）",
    detail: { units, active: obs.active ?? null },
  };
}

/** ⑥ 守护 /health：可达 → ok；不可达 → warn（不阻塞：守护按需启动）。 */
export function judgeDaemonHealth(obs: DaemonHealthObservation): DoctorCheck {
  if (obs.ok) {
    return { id: "daemon", level: "ok", summary: "守护 /health 可达" };
  }
  return {
    id: "daemon",
    level: "warn",
    summary: `守护不可达（${obs.reason ?? "unknown"}）`,
    remediation: "codearts-bridge service install 启用常驻守护，或前台运行 codearts-bridge daemon",
    detail: { reason: obs.reason ?? null },
  };
}

/** ⑦ 磁盘占用：任一超阈值 → warn（附 hygiene 指引）；采集异常 → fail；否则 ok。 */
export function judgeDisk(obs: DiskObservation): DoctorCheck {
  if (obs.error !== undefined) {
    return { id: "disk", level: "fail", summary: `磁盘占用采集失败：${obs.error}`, detail: { error: obs.error } };
  }
  const issues: string[] = [];
  const fix: string[] = [];
  if (obs.dumps.bytes > DOCTOR_DISK_DUMPS_WARN_BYTES) {
    issues.push(`dump 堆快照 ${humanBytes(obs.dumps.bytes)}（${obs.dumps.files} 个）超 ${humanBytes(DOCTOR_DISK_DUMPS_WARN_BYTES)}`);
    fix.push("codearts_hygiene purge-dumps 清理");
  }
  if (obs.walBytes > DOCTOR_DISK_WAL_WARN_BYTES) {
    issues.push(`WAL ${humanBytes(obs.walBytes)} 超 ${humanBytes(DOCTOR_DISK_WAL_WARN_BYTES)}`);
    fix.push("codearts_hygiene checkpoint-wal 收缩");
  }
  if (obs.logsBytes > DOCTOR_DISK_LOGS_WARN_BYTES) {
    issues.push(`日志总量 ${humanBytes(obs.logsBytes)} 超 ${humanBytes(DOCTOR_DISK_LOGS_WARN_BYTES)}`);
    fix.push("codearts_hygiene rotate-logs 轮转");
  }
  const detail: Record<string, unknown> = {
    dbBytes: obs.dbBytes,
    walBytes: obs.walBytes,
    dumps: obs.dumps,
    logsBytes: obs.logsBytes,
  };
  if (issues.length > 0) {
    return { id: "disk", level: "warn", summary: `磁盘占用：${issues.join("；")}`, remediation: fix.join("；"), detail };
  }
  return {
    id: "disk",
    level: "ok",
    summary: `磁盘占用正常（db ${humanBytes(obs.dbBytes)} / wal ${humanBytes(obs.walBytes)} / dumps ${humanBytes(obs.dumps.bytes)} / logs ${humanBytes(obs.logsBytes)}）`,
    detail,
  };
}

/** ⑧ 网络：任意 HTTP 应答即可达 → ok；不可达 → warn（仅升级/安装通道受影响）。 */
export function judgeNetwork(obs: NetworkObservation): DoctorCheck {
  if (obs.reachable) {
    return { id: "network", level: "ok", summary: `官方 release-info 端点可达（HTTP ${obs.status}）`, detail: { status: obs.status ?? null } };
  }
  return {
    id: "network",
    level: "warn",
    summary: `官方 release-info 端点不可达（${obs.reason ?? "unknown"}）——codearts CLI 升级/安装暂不可用（不影响既有功能）`,
    remediation: "检查网络/代理后重试；官方入口：https://codearts.huaweicloud.com/portal/settings/cli-auth",
    detail: { reason: obs.reason ?? null },
  };
}

/* ───── 聚合 ───── */

export interface DoctorSummary {
  ok: number;
  warn: number;
  fail: number;
  exitCode: 0 | 1;
}

/** 聚合：fail>0 → 退出码 1；warn 不影响退出码（任务书：网络等 ⚠ 不阻塞）。 */
export function aggregate(checks: readonly DoctorCheck[]): DoctorSummary {
  const ok = checks.filter((c) => c.level === "ok").length;
  const warn = checks.filter((c) => c.level === "warn").length;
  const fail = checks.filter((c) => c.level === "fail").length;
  return { ok, warn, fail, exitCode: fail > 0 ? 1 : 0 };
}

/* ───── 采集器（IO 层：一切失败归一为观察值） ───── */

/** ① opencode --version：spawn 失败 → 未检出；退出码非 0 → 在场但版本未知。 */
export async function collectOpencode(exec: Exec): Promise<OpencodeObservation> {
  let result;
  try {
    result = await exec.run(["opencode", "--version"]);
  } catch {
    return { present: false };
  }
  return { present: true, version: extractVersion(result.stdout, result.stderr) };
}

/**
 * ② bun 探测：先 PATH `bun --version`；spawn 失败回落 `<homeDir>/.bun/bin/bun --version`
 * （install.sh 的官方安装落点）；两路皆失败 → 未检出。
 */
export async function collectBun(homeDir: string, exec: Exec): Promise<BunObservation> {
  try {
    const r = await exec.run(["bun", "--version"]);
    if (r.code === 0) return { present: true, version: extractVersion(r.stdout, r.stderr) };
  } catch {
    // PATH 探测失败 → 回落 canonical 路径（非静默：失败路径仍有第二探测）
  }
  const canonical = path.join(homeDir, ".bun", "bin", "bun");
  try {
    const r = await exec.run([canonical, "--version"]);
    if (r.code === 0) return { present: true, version: extractVersion(r.stdout, r.stderr) };
  } catch {
    // 两路皆失败 → 未检出
  }
  return { present: false };
}

/** ③ probeInstall 只读快照；探测抛错（损坏态）归一为 error 观察。 */
export async function collectCodeartsCli(cfg: BridgeConfig, exec: Exec): Promise<CodeartsObservation> {
  try {
    return { status: await probeInstall(cfg, { exec }) };
  } catch (e) {
    return {
      error: e instanceof BridgeError ? `${e.code}: ${e.message}` : (e instanceof Error ? e.message : String(e)),
    };
  }
}

/** ④ 凭据观察：auth.json 存在性 + readAksk；损坏态归一为 error（值绝不回显）。 */
export async function collectCredential(
  cfg: BridgeConfig,
  opts: { kernelDataDir?: string } = {},
): Promise<CredentialObservation> {
  const kernelDataDir = opts.kernelDataDir ?? path.join(homedir(), KERNEL_DATA_DIR_DEFAULT);
  let authJsonExists = false;
  try {
    const st = await stat(path.join(kernelDataDir, "auth.json"));
    authJsonExists = st.isFile();
  } catch (e) {
    if (errnoOf(e) !== "ENOENT") {
      const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
      return { authJsonExists: false, error: `auth.json 不可读：path=${kernelDataDir} reason=${reason}` };
    }
  }
  try {
    return { authJsonExists, aksk: await readAksk(cfg.akskFile) };
  } catch (e) {
    return { authJsonExists, error: e instanceof Error ? e.message : String(e) };
  }
}

/** ⑤ systemd 观察：单元在场性（stat）→ 在场才发 is-active（缺失时零 systemctl 调用）。 */
export async function collectSystemd(unitDir: string, exec: Exec): Promise<SystemdObservation> {
  const present = async (name: string): Promise<boolean> => {
    try {
      return (await stat(path.join(unitDir, name))).isFile();
    } catch (e) {
      if (errnoOf(e) === "ENOENT") return false;
      throw e; // 非 ENOENT 的 stat 异常交由上层归一（不该被当"未安装"吞掉）
    }
  };
  let units: SystemdObservation["units"];
  try {
    units = {
      daemon: await present(SERVICE_UNIT_NAMES.daemon),
      watchdogService: await present(SERVICE_UNIT_NAMES.watchdogService),
      watchdogTimer: await present(SERVICE_UNIT_NAMES.watchdogTimer),
    };
  } catch (e) {
    return { systemctlAvailable: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (!units.daemon) {
    return { systemctlAvailable: true, units }; // 未安装：不发起任何 systemctl 调用
  }
  const isActive = async (unit: string): Promise<boolean | undefined> => {
    try {
      return (await exec.run(["systemctl", "--user", "is-active", unit])).code === 0;
    } catch {
      return undefined; // spawn 层失败 → systemctl 不可用
    }
  };
  const daemonActive = await isActive(SERVICE_UNIT_NAMES.daemon);
  if (daemonActive === undefined) {
    return { systemctlAvailable: false, units };
  }
  const timerActive = await isActive(SERVICE_UNIT_NAMES.watchdogTimer);
  return {
    systemctlAvailable: true,
    units,
    active: { daemon: daemonActive, watchdogTimer: timerActive === true },
  };
}

/** ⑥ 守护 /health 探测（GET，3s 超时；只认 ok:true；一切失败归一 ok=false+reason）。 */
export async function collectDaemonHealth(
  daemonUrl: string,
  fetchImpl: FetchLike,
): Promise<DaemonHealthObservation> {
  const url = new URL("/health", daemonUrl);
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(DOCTOR_DAEMON_TIMEOUT_MS) });
  } catch (e) {
    const code = errnoOf(e);
    const name = e instanceof Error ? e.name : "";
    return { ok: false, reason: code ?? (name || "unknown") };
  }
  if (!res.ok) return { ok: false, reason: `http-${res.status}` };
  try {
    const body = (await res.json()) as Record<string, unknown>;
    if (body["ok"] === true) return { ok: true };
    return { ok: false, reason: "ok-mismatch" };
  } catch {
    return { ok: false, reason: "non-json" };
  }
}

/** ⑦ 磁盘占用（复用 collectHealth 的 db/wal/dumps/logs 口径；异常归一为 error）。 */
export async function collectDisk(cfg: BridgeConfig, kernelDataDir?: string): Promise<DiskObservation> {
  try {
    const snap = await collectHealth(cfg, kernelDataDir !== undefined ? { kernelDataDir } : {});
    return {
      dbBytes: snap.dbBytes,
      walBytes: snap.walBytes,
      dumps: snap.dumps,
      logsBytes: snap.logs.bytes,
    };
  } catch (e) {
    return {
      dbBytes: 0,
      walBytes: 0,
      dumps: { files: 0, bytes: 0 },
      logsBytes: 0,
      error: e instanceof BridgeError ? `${e.code}: ${e.message}` : (e instanceof Error ? e.message : String(e)),
    };
  }
}

/** ⑧ 官方端点 HEAD 探活（5s 超时；任意 HTTP 应答即可达；失败归一 reachable=false）。 */
export async function collectNetwork(fetchImpl: FetchLike): Promise<NetworkObservation> {
  let res: Response;
  try {
    res = await fetchImpl(NETWORK_PROBE_URL, {
      method: "HEAD",
      signal: AbortSignal.timeout(DOCTOR_NETWORK_TIMEOUT_MS),
    });
  } catch (e) {
    const code = errnoOf(e);
    const name = e instanceof Error ? e.name : "";
    return { reachable: false, reason: code ?? (name || "unknown") };
  }
  return { reachable: true, status: res.status };
}

/* ───── 汇总与命令 ───── */

/** doctor 可注入依赖（缺省生产实现；测试全部注入）。 */
export interface DoctorDeps {
  /** 命令执行抽象（opencode/bun/systemctl 探测；缺省 createNodeExec）。 */
  exec?: Exec;
  /** HTTP 探测（守护 /health 与官方端点；缺省全局 fetch）。 */
  fetchImpl?: FetchLike;
  /** HOME 锚点（bun canonical 路径与 systemd user 单元目录派生；缺省 os.homedir()）。 */
  homeDir?: string;
  /** 内核数据目录（auth.json 与磁盘采样；缺省 ~/.codeartsdoer/cli-data）。 */
  kernelDataDir?: string;
}

/** 按任务书 ①..⑧ 固定顺序执行八项采集+判定（不含输出）。 */
export async function runDoctorChecks(cfg: BridgeConfig, deps: DoctorDeps = {}): Promise<DoctorCheck[]> {
  const homeDir = deps.homeDir ?? homedir();
  const exec = deps.exec ?? createNodeExec();
  const fetchImpl = deps.fetchImpl ?? fetch;

  const opencode = judgeOpencode(await collectOpencode(exec));
  const bun = judgeBun(await collectBun(homeDir, exec));
  const codeartsCli = judgeCodeartsCli(await collectCodeartsCli(cfg, exec));
  const credential = judgeCredential(await collectCredential(cfg, { kernelDataDir: deps.kernelDataDir }));
  const systemd = judgeSystemd(
    await collectSystemd(path.join(homeDir, ".config", "systemd", "user"), exec),
  );
  const daemon = judgeDaemonHealth(await collectDaemonHealth(cfg.daemonUrl, fetchImpl));
  const disk = judgeDisk(await collectDisk(cfg, deps.kernelDataDir));
  const network = judgeNetwork(await collectNetwork(fetchImpl));

  return [opencode, bun, codeartsCli, credential, systemd, daemon, disk, network];
}

const LEVEL_MARK: Record<CheckLevel, string> = { ok: "✓", warn: "⚠", fail: "✗" };

/**
 * doctor 命令：输出体检报告并返回聚合退出码。
 * 默认双输出——人类可读行（stdout）+ 尾部单行结构化 JSON（前缀可辨识，供脚本
 * 按行解析）；`--json` 时仅输出结构化 JSON（单行）。warn 不改变退出码。
 */
export async function doctorCommand(
  cfg: BridgeConfig = loadConfig(),
  deps: DoctorDeps = {},
  opts: { json?: boolean } = {},
): Promise<number> {
  const checks = await runDoctorChecks(cfg, deps);
  const summary = aggregate(checks);
  const payload = JSON.stringify({ checks, summary });
  if (opts.json === true) {
    console.log(payload);
    return summary.exitCode;
  }
  console.log("[codearts-bridge doctor] 环境体检报告");
  for (const c of checks) {
    const mark = LEVEL_MARK[c.level];
    console.log(`${mark} [${c.id}] ${c.summary}`);
    if (c.remediation !== undefined) console.log(`    ↳ 修复：${c.remediation}`);
  }
  console.log(
    `结论：${summary.ok} ✓ / ${summary.warn} ⚠ / ${summary.fail} ✗（退出码 ${summary.exitCode}）`,
  );
  console.log(payload);
  return summary.exitCode;
}
