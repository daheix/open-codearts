/**
 * codearts-bridge 安装管家——安装状态探测（T1-03）与备份自愈修复（T1-04）。
 *
 * T1-03 职责：`probeInstall` 只读采集 codearts CLI 安装态：
 * 二进制存在性 / --version / sha256 / 备份有效性 / autoupdate 开关 / 钉版一致性。
 *
 * T1-04 职责（本任务）：
 * - `repairInstall`：备份发现（期望版本命名 → 扫描 codearts.bak-*）→ 校验
 *   （哈希 vs 钉版口径 + --version 可执行）→ copyDeploy 原子替换部署 → 复验
 *   （哈希+版本）→ 审计；可选 `fixAutoupdate` 显式关停自动升级。
 * - `ensureBackup`：备份是派生物可安全刷新——二进制有效且备份缺失/失效 →
 *   从二进制 copyDeploy 刷新 `codearts.bak-<版本>` + 审计；二进制无效 → 显式报错。
 * - 审计（R-fx6）：`<stateDir>/audit/install.jsonl` 追加写，auditId 形如
 *   `rep-<时间戳>-<随机短码>`。
 *
 * 背景事故（remediation 文案依据）：升级流程"先改名（codearts→codearts.delete）
 * 后部署"，部署失败会静默遗留 .delete 残局；备份命名实例 `codearts.bak-26.10.9`；
 * 官方接入/升级入口 https://codearts.huaweicloud.com/portal/settings/cli-auth。
 *
 * 主控裁定依据（SDD 2026-10-31，逐条落实）：
 * - R-a 钉版状态显式化：`pinState` 三态（unpinned/consistent/drift）——
 *   pinned.json 缺失时 drift=false 不得掩盖"未钉版"，调用方以 pinState 区分
 *   "未钉版"与"已钉且一致"，禁止静默假定。
 * - R-c autoupdate 读取：路径派生 `<installDir>/../codearts_cli.json`；
 *   文件缺失 → autoupdateFlag=undefined（显式"未知"）；JSON 解析失败或字段
 *   类型非法 → 抛出（显式，不静默 undefined）。
 * - R-d probeInstall 语义：只读状态采集——业务态（缺失/坏哈希/无法执行/版本不符）
 *   以状态字段如实表达、不抛业务错误；文件系统意外错误（非 ENOENT，如 EACCES）
 *   → 抛出（消息含路径与原因）。`--version` 解析取输出首个 `/^\d+\.\d+\.\d+/m`
 *   匹配；exec 失败 → version=undefined（状态可见）。
 * - R-e 隔离：Exec 注入接口 + 默认 node 实现；测试绝不真跑 codearts 二进制、
 *   绝不触碰真实 HOME。
 * - R-fx3 ensureBackup 语义：备份可安全刷新；源二进制无效 → 显式 BridgeError
 *   （无备份可做，不静默）。
 * - R-fx4 repair 备份发现顺序与恢复步骤：校验 → copyDeploy → 复验 → 审计；
 *   全无备份 → BIN_MISSING_NO_BACKUP（remediation 含 .delete 残留检查/官方重装/
 *   备份恢复指引/官方入口链接）；候选存在但均无效 → BACKUP_INVALID_HASH。
 * - R-fx5 fixAutoupdate：显式开关（默认不执行）；仅改 autoupdate 字段，
 *   保留其余字段（含未知字段）；解析失败 → AUTOUPDATE_INVALID 且不触碰文件。
 *
 * 漂移判定口径（哈希为内容身份，版本为可读复核）：
 * - 已钉时：二进制缺失、或 sha256 与钉版不符 → drift；
 *   版本仅在"可解析且不等"时参与判定（exec 失败导致版本未知不算版本漂移，
 *   版本未知本身已由 version=undefined 如实呈现）。
 * - 备份有效性 backupValid：备份存在且为非空常规文件；有钉版时还须哈希与钉版
 *   一致（修复源强校验），无钉版时仅要求存在且非空（无比对基准）。
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, readFile, readdir, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import * as path from "node:path";
import type { BridgeConfig } from "./config";
import { ensureStateDirs } from "./config";
import { BridgeError } from "./errors";
import { atomicWriteFile, copyDeploy, errnoOf, sha256File } from "./fsx";

/* ───── 路径派生（单一出口，T1-04/05 复用） ───── */

/** 二进制绝对路径：<installDir>/bin/codearts。 */
export function binPathOf(installDir: string): string {
  return path.join(installDir, "bin", "codearts");
}

/** 钉版记录路径：<stateDir>/pinned.json。 */
export function pinnedJsonPath(stateDir: string): string {
  return path.join(stateDir, "pinned.json");
}

/** autoupdate 开关载体（R-c）：<installDir>/../codearts_cli.json。 */
export function codeartsCliJsonPath(installDir: string): string {
  return path.join(installDir, "..", "codearts_cli.json");
}

/* ───── Exec 注入接口（R-e） ───── */

/** 子进程执行结果（code 为退出码；被信号杀死时为 -1）。 */
export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 命令执行抽象：测试注入 fake（绝不真跑二进制），生产用 createNodeExec。 */
export interface Exec {
  run(cmd: string[]): Promise<ExecResult>;
}

/** createNodeExec 可调项（超时与输出上限默认值面向 --version 探测量级）。 */
export interface NodeExecOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1 << 20; // 1 MiB：--version 输出远小于此

/**
 * 默认 Exec：node:child_process spawn。
 *
 * 显式失败（禁静默兜底）：
 * - 超时 → BridgeError("EXEC_TIMEOUT")，进程 SIGKILL；
 * - 输出超限 → BridgeError("EXEC_OUTPUT_OVERFLOW")，进程 SIGKILL（stdout+stderr 合并计数）；
 * - spawn 层失败（ENOENT/EACCES 等）→ 原样 reject（由 probeInstall 转为
 *   version=undefined 状态呈现——R-d：无法执行是业务态而非 FS 异常）。
 */
export function createNodeExec(opts: NodeExecOptions = {}): Exec {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  return {
    run(cmd: string[]): Promise<ExecResult> {
      return new Promise<ExecResult>((resolve, reject) => {
        const file = cmd[0];
        if (file === undefined) {
          reject(new BridgeError("EXEC_EMPTY_CMD", "exec 命令为空（cmd[0] 缺失）"));
          return;
        }
        const child = spawn(file, cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        let bytes = 0;
        let settled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const settleFail = (err: BridgeError) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          child.kill("SIGKILL");
          reject(err);
        };
        const settleResolve = (result: ExecResult) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          resolve(result);
        };

        timer = setTimeout(() => {
          settleFail(
            new BridgeError("EXEC_TIMEOUT", `命令超时（>${timeoutMs}ms）已强制终止：cmd=${cmd.join(" ")}`, {
              remediation: "检查目标二进制是否挂起；若持续超时请上报审计日志",
            }),
          );
        }, timeoutMs);

        // I1 修复（评审裁定）：两流同构——stdout 与 stderr 共用合并计数（头注契约
        // "stdout+stderr 合并计数"），任一时刻超限 → settleFail(EXEC_OUTPUT_OVERFLOW)
        // + SIGKILL，与 stdout 原路径完全一致（含单次 settle 守卫）。
        // 此前 stderr 溢出仅静默截断、从不报错，属禁止的静默兜底。
        const overflowFail = () =>
          settleFail(
            new BridgeError(
              "EXEC_OUTPUT_OVERFLOW",
              `命令输出超过上限（>${maxOutputBytes} 字节，stdout+stderr 合并计数）已强制终止：cmd=${cmd.join(" ")}`,
            ),
          );
        /** 合并计数并判定超限；返回 false 表示已溢出（该 chunk 及后续 chunk 一律不拼接）。 */
        const withinLimit = (chunk: unknown): boolean => {
          bytes += (chunk as Buffer).length;
          if (bytes > maxOutputBytes) {
            overflowFail();
            return false;
          }
          return true;
        };
        child.stdout?.on("data", (chunk: unknown) => {
          if (withinLimit(chunk)) stdout += (chunk as Buffer).toString("utf8");
        });
        child.stderr?.on("data", (chunk: unknown) => {
          if (withinLimit(chunk)) stderr += (chunk as Buffer).toString("utf8");
        });
        child.on("error", (e: Error) => {
          if (settled) return;
          settled = true;
          if (timer !== undefined) clearTimeout(timer);
          reject(e); // spawn 层失败原样上抛（调用方决定语义）
        });
        child.on("close", (code) => {
          settleResolve({ code: code ?? -1, stdout, stderr }); // null=被信号杀死 → -1（非零即可判定失败）
        });
      });
    },
  };
}

/* ───── 状态模型 ───── */

/** 钉版记录（pinned.json 内容；本仓库自有格式，写入方为 T1-04/05——
 *  T1-05 裁定 R-up9 收尾语义不含钉版回写，升级后以 probeInstall 的 drift 口径如实呈现）。 */
export interface PinnedRecord {
  version: string;
  sha256: string;
}

/**
 * 钉版一致性三态（R-a：未钉版必须与"已钉一致"可区分，禁止静默假定）：
 * - "unpinned"：pinned.json 缺失（未钉版）；
 * - "consistent"：已钉且二进制与钉版一致（哈希相等，版本相等或未知）；
 * - "drift"：已钉但不一致——二进制缺失、哈希不符、或版本可解析且不等。
 */
export type PinState = "unpinned" | "consistent" | "drift";

/** 安装状态（status 工具与守护共用的只读快照）。 */
export interface InstallStatus {
  /** 二进制绝对路径 <installDir>/bin/codearts。 */
  path: string;
  /** 二进制存在（常规文件）。 */
  present: boolean;
  /** --version 解析值（形如 26.10.9）；缺失/无法执行/解析失败 → undefined（R-d 状态呈现）。 */
  version?: string;
  /** 二进制内容 sha256（present 时计算）。 */
  sha256?: string;
  /**
   * 规范备份路径 <installDir>/bin/codearts.bak-<version>（命名契约见背景）；
   * 版本名取 钉版版本 ?? 当前解析版本 ?? "unknown"（未钉且版本未知时的信息性占位，
   * 此时 backupValid 必为 false，真实状态由字段承载，占位名不参与任何行为）。
   */
  backupPath: string;
  /** 备份可作恢复源：存在且非空常规文件；有钉版时须哈希与钉版一致。 */
  backupValid: boolean;
  /** codearts_cli.json 的 autoupdate 字段；文件或键缺失 → undefined（显式未知，R-c）。 */
  autoupdateFlag?: boolean;
  /** 钉版一致性三态（R-a）。 */
  pinState: PinState;
  /** 便捷字段 = pinState === "drift"（未钉版时 false，靠 pinState 区分）。 */
  drift: boolean;
  /** 钉版记录；pinState === "unpinned" 时为 undefined。 */
  pinned?: PinnedRecord;
}

/* ───── 内部读取原语（ENOENT 容忍 + 其他错误显式抛） ───── */

/** stat；ENOENT → undefined（显式"不存在"状态）；其他错误 → BridgeError（R-d）。T1-05 升级复用。 */
export async function statOrEnoent(target: string): Promise<Stats | undefined> {
  try {
    return await stat(target);
  } catch (e) {
    if (errnoOf(e) === "ENOENT") return undefined;
    const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
    throw new BridgeError("FS_STAT_FAILED", `stat 失败：path=${target} reason=${reason}`, {
      cause: e,
    });
  }
}

/** 读文本；ENOENT → undefined；其他错误 → BridgeError（R-d）。 */
async function readTextOrEnoent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    if (errnoOf(e) === "ENOENT") return undefined;
    const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
    throw new BridgeError("FS_READ_FAILED", `读取文件失败：path=${file} reason=${reason}`, {
      cause: e,
    });
  }
}

/* ───── 钉版记录读取（自有格式：损坏显式报错） ───── */

const VERSION_FULL_RE = /^\d+\.\d+\.\d+$/;
const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;

/** 读取并校验 pinned.json；缺失 → undefined（未钉版）；损坏/非法 → BridgeError。 */
async function readPinned(stateDir: string): Promise<PinnedRecord | undefined> {
  const file = pinnedJsonPath(stateDir);
  const text = await readTextOrEnoent(file);
  if (text === undefined) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new BridgeError("PINNED_INVALID", `钉版记录 JSON 解析失败：path=${file}`, {
      remediation: "修正或删除 pinned.json（删除即视为未钉版状态）",
      cause: e,
    });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BridgeError("PINNED_INVALID", `钉版记录须为 JSON 对象：path=${file}`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "version" && key !== "sha256") {
      throw new BridgeError("PINNED_INVALID", `钉版记录含未知键 "${key}"（仅允许 version/sha256）：path=${file}`);
    }
  }
  const version = record.version;
  if (typeof version !== "string" || !VERSION_FULL_RE.test(version)) {
    throw new BridgeError("PINNED_INVALID", `钉版记录 version 须为 \\d+\\.\\d+\\.\\d+ 形态：path=${file}`);
  }
  const sha256 = record.sha256;
  if (typeof sha256 !== "string" || !SHA256_HEX_RE.test(sha256)) {
    throw new BridgeError("PINNED_INVALID", `钉版记录 sha256 须为 64 位十六进制：path=${file}`);
  }
  return { version, sha256: sha256.toLowerCase() };
}

/* ───── autoupdate 开关读取（R-c：外来用户文件，只检目标字段） ───── */

/**
 * 读取 codearts_cli.json 的 autoupdate 字段。
 * - 文件缺失 → undefined（显式未知）；
 * - JSON 解析失败 / 顶层非对象 / autoupdate 字段类型非法 → 抛出（R-c 显式）；
 * - 外来文件的其他键一律不校验（只检目标字段，非兜底）。
 */
async function readAutoupdateFlag(installDir: string): Promise<boolean | undefined> {
  const file = codeartsCliJsonPath(installDir);
  const text = await readTextOrEnoent(file);
  if (text === undefined) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new BridgeError("AUTOUPDATE_INVALID", `codearts_cli.json 解析失败：path=${file}`, {
      remediation: "修正该文件的 JSON 语法（该文件属 codearts CLI 用户配置）",
      cause: e,
    });
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BridgeError("AUTOUPDATE_INVALID", `codearts_cli.json 顶层须为 JSON 对象：path=${file}`);
  }
  if (!("autoupdate" in raw)) return undefined;
  const flag = (raw as Record<string, unknown>).autoupdate;
  if (typeof flag !== "boolean") {
    throw new BridgeError(
      "AUTOUPDATE_INVALID",
      `codearts_cli.json 的 autoupdate 字段类型非法（须为布尔）：path=${file}`,
    );
  }
  return flag;
}

/* ───── --version 探测与备份检查 ───── */

/** 版本解析（R-d）：取输出首个 `/^\d+\.\d+\.\d+/m` 匹配；stdout 优先、stderr 兜扫（版本串可能出现在任一流）。 */
const VERSION_PREFIX_RE = /^\d+\.\d+\.\d+/m;

/**
 * 执行 `<bin> --version` 并解析版本。
 * - 退出码非 0 → undefined（exec 失败，R-d）；
 * - exec 抛错（spawn 层 ENOENT/EACCES 等）→ undefined（无法执行是业务态，R-d）；
 * - 两流均无版本形串 → undefined（解析失败）。
 * T1-05 升级复用（新二进制自检/部署复验共用同一版本解析口径）。
 */
export async function detectVersion(exec: Exec, binPath: string): Promise<string | undefined> {
  let result: ExecResult;
  try {
    result = await exec.run([binPath, "--version"]);
  } catch {
    return undefined;
  }
  if (result.code !== 0) return undefined;
  const match = VERSION_PREFIX_RE.exec(result.stdout) ?? VERSION_PREFIX_RE.exec(result.stderr);
  return match?.[0];
}

/**
 * 备份有效性检查：存在且为非空常规文件；有钉版时哈希须与钉版一致。
 * - ENOENT → false（无备份是显式状态）；
 * - 存在但非常规文件 → 抛 BridgeError（异常态，禁止静默当 false）；
 * - 哈希读取失败（非 ENOENT FS 错误）→ 经 sha256File 显式抛出。
 */
async function checkBackup(backupPath: string, pin: PinnedRecord | undefined): Promise<boolean> {
  const st = await statOrEnoent(backupPath);
  if (st === undefined) return false;
  if (!st.isFile()) {
    throw new BridgeError("FS_PATH_NOT_FILE", `备份路径存在但不是常规文件：path=${backupPath}`, {
      remediation: "检查备份文件是否被外部改动；可执行 codearts_repair 重建备份",
    });
  }
  if (st.size === 0) return false; // 空备份无恢复价值：显式规则，非兜底
  if (pin === undefined) return true; // 无钉版：无比对基准，存在且非空即可（backupValid 语义见头注）
  return (await sha256File(backupPath)) === pin.sha256;
}

/* ───── probeInstall ───── */

/**
 * 只读探测安装状态（R-d）。绝不写任何文件、绝不删除残留（清理属 T1-04/T1-05）。
 *
 * @param cfg  全局配置（消费 installDir 与 stateDir）
 * @param deps 可注入依赖；exec 缺省用 createNodeExec（测试注入 fake）
 */
export async function probeInstall(
  cfg: BridgeConfig,
  deps: { exec?: Exec } = {},
): Promise<InstallStatus> {
  const exec = deps.exec ?? createNodeExec();
  const binPath = binPathOf(cfg.installDir);

  // 1) 二进制存在性与内容/版本（缺失是显式状态；存在但非常规文件是异常态 → 抛）
  let present = false;
  let sha256: string | undefined;
  let version: string | undefined;
  const binStat = await statOrEnoent(binPath);
  if (binStat !== undefined) {
    if (!binStat.isFile()) {
      throw new BridgeError("FS_PATH_NOT_FILE", `二进制路径存在但不是常规文件：path=${binPath}`, {
        remediation: "检查安装目录是否被外部改动；可执行 codearts_repair 重建",
      });
    }
    present = true;
    sha256 = await sha256File(binPath);
    version = await detectVersion(exec, binPath);
  }

  // 2) 钉版记录与 autoupdate 开关
  const pin = await readPinned(cfg.stateDir);
  const autoupdateFlag = await readAutoupdateFlag(cfg.installDir);

  // 3) 备份（命名契约 codearts.bak-<version>；版本名来源按头注优先级）
  const backupName = pin?.version ?? version ?? "unknown";
  const backupPath = path.join(cfg.installDir, "bin", `codearts.bak-${backupName}`);
  const backupValid = await checkBackup(backupPath, pin);

  // 4) 钉版一致性（R-a 三态；漂移口径见头注：版本未知不判版本漂移）
  let pinState: PinState;
  if (pin === undefined) {
    pinState = "unpinned";
  } else if (present && sha256 === pin.sha256 && (version === undefined || version === pin.version)) {
    pinState = "consistent";
  } else {
    pinState = "drift";
  }

  return {
    path: binPath,
    present,
    version,
    sha256,
    backupPath,
    backupValid,
    autoupdateFlag,
    pinState,
    drift: pinState === "drift",
    pinned: pin,
  };
}

/* ───── 审计（R-fx6：install.jsonl 追加写） ───── */

/** auditId 形如 rep-<epoch 毫秒>-<6 位随机十六进制>（R-fx6）。 */
function newRepairAuditId(): string {
  return `rep-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

/**
 * 追加一条审计到 <stateDir>/audit/install.jsonl（R-fx6）。
 * 先 ensureStateDirs（audit/ 目录 0700）；追加失败显式抛 FS_WRITE_FAILED（含路径）。
 * T1-05 升级审计复用同一出口（install 管理动作共用单一审计流，便于对账）。
 */
export async function appendInstallAudit(cfg: BridgeConfig, entry: Record<string, unknown>): Promise<void> {
  await ensureStateDirs(cfg);
  const file = path.join(cfg.stateDir, "audit", "install.jsonl");
  try {
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch (e) {
    const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
    throw new BridgeError("FS_WRITE_FAILED", `追加审计失败：path=${file} reason=${reason}`, {
      cause: e,
    });
  }
}

/* ───── 备份候选发现与校验（R-fx4） ───── */

/** 备份命名契约：bin 同目录下 codearts.bak-<任意后缀>（实例 codearts.bak-26.10.9）。 */
const BACKUP_NAME_RE = /^codearts\.bak-.+/;

/** 备份候选校验结果：ok 时携带内容哈希与可读版本；失败时携带机器可读原因。 */
type BackupValidation =
  | { ok: true; sha256: string; version: string }
  | { ok: false; reason: string };

/**
 * 校验单个备份候选（R-fx4 恢复步骤第 1 步）：
 * - 存在且为非空常规文件（与 T1-03 backupValid 口径一致）；
 * - 哈希校验："备份自身记录口径"= 有钉版时 sha256 须与钉版一致（内容身份），
 *   无钉版时无比对基准（仅要求非空常规文件）；
 * - `--version` 可执行且可解析（备份必须能跑起来才有恢复价值）。
 * 单个候选的 stat/读取失败按"该候选无效"记录原因并继续（候选枚举容错：
 * 扫描目录里可能有垃圾件，不应让单个坏候选中断整个发现过程；
 * 全部无效时由调用方汇总原因显式报错，无静默）。
 */
async function validateBackupCandidate(
  backupPath: string,
  pin: PinnedRecord | undefined,
  exec: Exec,
): Promise<BackupValidation> {
  let st: Stats | undefined;
  try {
    st = await statOrEnoent(backupPath);
  } catch (e) {
    return { ok: false, reason: `stat-failed(${e instanceof Error ? e.message : String(e)})` };
  }
  if (st === undefined) return { ok: false, reason: "missing" };
  if (!st.isFile()) return { ok: false, reason: "not-file" };
  if (st.size === 0) return { ok: false, reason: "empty" };

  let sha: string;
  try {
    sha = await sha256File(backupPath);
  } catch (e) {
    return { ok: false, reason: `read-failed(${e instanceof Error ? e.message : String(e)})` };
  }
  if (pin !== undefined && sha !== pin.sha256) return { ok: false, reason: "hash-mismatch" };

  const version = await detectVersion(exec, backupPath);
  if (version === undefined) return { ok: false, reason: "not-runnable" };
  return { ok: true, sha256: sha, version };
}

/** 列出 bin 目录文件名；目录不存在 → 空数组（无候选是显式状态）；其他错误显式抛。 */
async function listBinDirNames(binDir: string): Promise<string[]> {
  try {
    return await readdir(binDir);
  } catch (e) {
    if (errnoOf(e) === "ENOENT") return [];
    const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
    throw new BridgeError("FS_READ_FAILED", `读取目录失败：path=${binDir} reason=${reason}`, {
      cause: e,
    });
  }
}

/** 当前二进制的可读版本（仅 present 且为常规文件时探测；否则 undefined）。 */
async function currentBinVersion(exec: Exec, binPath: string): Promise<string | undefined> {
  const st = await statOrEnoent(binPath);
  if (st === undefined || !st.isFile()) return undefined;
  return detectVersion(exec, binPath);
}

/** BIN_MISSING_NO_BACKUP 的统一出口：remediation 含真实事故四要素（R-fx4）。 */
function noBackupError(binPath: string, binDir: string): BridgeError {
  return new BridgeError(
    "BIN_MISSING_NO_BACKUP",
    `二进制缺失且找不到任何可用备份：bin=${binPath} binDir=${binDir}`,
    {
      remediation:
        `1) 检查 ${binDir} 下是否存在 codearts.delete 等升级中断残留` +
        `（升级流程"先改名后部署"，部署失败会遗留 .delete 残局）；` +
        `2) 从官方安装包重装 codearts CLI；` +
        `3) 若其他位置留有 codearts.bak-* 备份，手工复制到 ${binDir}/codearts.bak-<版本> 后重试恢复；` +
        `4) 官方接入/升级入口：https://codearts.huaweicloud.com/portal/settings/cli-auth`,
    },
  );
}

/* ───── repairInstall（T1-04 核心：备份恢复自愈） ───── */

/** 修复结果（任务书接口）：action 固定 restore-from-backup，from 显式记录所用备份文件名。 */
export interface RepairResult {
  action: "restore-from-backup";
  from: string;
  to: string;
  sha256: string;
  auditId: string;
}

/**
 * 自愈修复（R-fx4）：从备份恢复二进制，可选显式关停 autoupdate。
 *
 * 执行顺序：
 * 1. fixAutoupdate=true 时先关停自动升级（止血优先：即便恢复失败，
 *    也不再被自动升级破坏；该动作独立审计，幂等可重试）；
 * 2. 备份发现（R-fx4 顺序）：① `<bin>.bak-<期望版本>`（期望版本=钉版版本，
 *    未钉版取当前二进制 probe 版本）→ ② 扫描 `codearts.bak-*` 取任一有效备份；
 * 3. 逐候选校验（哈希 vs 钉版口径 + --version 可执行），取首个有效者；
 * 4. copyDeploy 原子替换部署（R-fx1：目标要么旧内容要么新内容）；
 * 5. 复验（哈希 vs 钉版/备份基线 + --version 可执行）；
 * 6. 审计（kind=repair，含 auditId）并返回 RepairResult。
 *
 * 失败分支（显式，无静默）：
 * - 无任何候选 → BIN_MISSING_NO_BACKUP（remediation 四要素，见 noBackupError）；
 * - 候选存在但全部无效（含哈希不符）→ BACKUP_INVALID_HASH；
 * - 部署后复验不过 → REPAIR_VERIFY_FAILED（不谎报成功）；
 * - FS/权限失败 → FS_WRITE_FAILED（含路径与 errno，见 copyDeploy）。
 */
export async function repairInstall(
  cfg: BridgeConfig,
  exec: Exec,
  opts: { fixAutoupdate?: boolean } = {},
): Promise<RepairResult> {
  // 1) 显式开关（R-fx5）：默认不执行；开启才修正 autoupdate
  if (opts.fixAutoupdate === true) {
    await fixAutoupdateFlag(cfg);
  }

  const binPath = binPathOf(cfg.installDir);
  const binDir = path.dirname(binPath);
  const pin = await readPinned(cfg.stateDir);

  // 2) 候选发现：期望版本命名优先，其次扫描 codearts.bak-*
  const candidates: string[] = [];
  const expectedVersion = pin?.version ?? (await currentBinVersion(exec, binPath));
  if (expectedVersion !== undefined) {
    candidates.push(path.join(binDir, `codearts.bak-${expectedVersion}`));
  }
  const seen = new Set(candidates);
  for (const name of (await listBinDirNames(binDir)).sort()) {
    if (!BACKUP_NAME_RE.test(name)) continue;
    const full = path.join(binDir, name);
    if (!seen.has(full)) {
      seen.add(full);
      candidates.push(full);
    }
  }

  // 3) 逐候选校验，取首个有效备份；全无效则按是否含哈希不符细分错误码。
  //    "候选名不存在"是正常态（期望版本名没有对应备份），不计入失败候选——
  //    只有真实存在的候选文件全部无效才算"有备份但都坏"（否则 only-delete
  //    残局会误报 BACKUP_INVALID 而非 BIN_MISSING_NO_BACKUP）。
  const failures: string[] = [];
  let sawHashMismatch = false;
  let existingCount = 0;
  let chosen: { path: string; sha256: string; version: string } | undefined;
  for (const candidate of candidates) {
    const verdict = await validateBackupCandidate(candidate, pin, exec);
    if (verdict.ok) {
      chosen = { path: candidate, sha256: verdict.sha256, version: verdict.version };
      break;
    }
    if (verdict.reason === "missing") continue;
    existingCount++;
    if (verdict.reason === "hash-mismatch") sawHashMismatch = true;
    failures.push(`${candidate}: ${verdict.reason}`);
  }
  if (chosen === undefined) {
    if (existingCount === 0) throw noBackupError(binPath, binDir);
    if (sawHashMismatch) {
      throw new BridgeError(
        "BACKUP_INVALID_HASH",
        `所有候选备份均无效（含哈希与钉版不符）：${failures.join("; ")}`,
        { remediation: "备份文件已损坏：从官方安装包重装，或提供与钉版记录一致的备份后重试" },
      );
    }
    throw new BridgeError(
      "BACKUP_INVALID",
      `所有候选备份均无效（非常规文件/为空/不可执行）：${failures.join("; ")}`,
      { remediation: "备份不可执行无恢复价值：从官方安装包重装后重试" },
    );
  }

  // 4) 原子替换部署（R-fx1；mode 默认 0755）
  await copyDeploy(chosen.path, binPath, 0o755);

  // 5) 复验（哈希+版本）：哈希基线=钉版 ?? 所用备份内容；版本须可解析（可读复核）
  const expectedSha = pin?.sha256 ?? chosen.sha256;
  const deployedSha = await sha256File(binPath);
  const deployedVersion = await detectVersion(exec, binPath);
  if (deployedSha !== expectedSha || deployedVersion === undefined) {
    throw new BridgeError(
      "REPAIR_VERIFY_FAILED",
      `恢复后复验失败：bin=${binPath} sha256 一致=${deployedSha === expectedSha} 版本可解析=${deployedVersion !== undefined}`,
      { remediation: "恢复部署未通过复验：检查备份文件与磁盘状态后重试，或从官方安装包重装" },
    );
  }

  // 6) 审计 + 返回（auditId 显式回传调用方，可跨系统对账）
  const auditId = newRepairAuditId();
  await appendInstallAudit(cfg, {
    ts: new Date().toISOString(),
    auditId,
    kind: "repair",
    from: chosen.path,
    to: binPath,
    sha256: deployedSha,
    result: "restored",
  });
  return { action: "restore-from-backup", from: chosen.path, to: binPath, sha256: deployedSha, auditId };
}

/* ───── fixAutoupdate（R-fx5：显式开关修正） ───── */

/**
 * 把 codearts_cli.json 的 autoupdate 修正为 false（R-fx5）：
 * - 解析失败 / 顶层非对象 → BridgeError(AUTOUPDATE_INVALID)，不触碰文件；
 * - 文件缺失 → 视为空对象，写入仅含 autoupdate:false 的新文件（显式动作，
 *   审计 before=null 记录"原本缺失"）；
 * - 仅改 autoupdate 字段，其余字段（含未知字段）原样保留；
 * - 写回格式：JSON.stringify(obj, null, 2) + 末尾换行（R-fx5 指定）；
 * - 已存在文件保留原 mode（外来用户文件不越权改权限），新建用 0644；
 * - 已是 false → 幂等不重写，审计记录 already-off。
 *
 * T1-08 共享导出说明：工具层（server.ts）的 already-healthy 幂等路径需要在
 * 不走 repairInstall 的前提下响应显式 fixAutoupdate 请求（R-t3：fixAutoupdate
 * 透传，健康短路不得丢弃用户显式动作），故本函数自 T1-08 起对外导出；
 * 语义不变：显式开关、幂等、独立审计。
 */
export async function fixAutoupdateFlag(cfg: BridgeConfig): Promise<void> {
  const file = codeartsCliJsonPath(cfg.installDir);

  let text: string | undefined;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (errnoOf(e) !== "ENOENT") {
      const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
      throw new BridgeError("FS_READ_FAILED", `读取文件失败：path=${file} reason=${reason}`, {
        cause: e,
      });
    }
    text = undefined; // 缺失是显式状态（与 probe 的 autoupdateFlag=undefined 同口径）
  }

  let raw: Record<string, unknown>;
  if (text === undefined) {
    raw = {};
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new BridgeError("AUTOUPDATE_INVALID", `codearts_cli.json 解析失败：path=${file}`, {
        remediation: "修正该文件的 JSON 语法（该文件属 codearts CLI 用户配置）",
        cause: e,
      });
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new BridgeError("AUTOUPDATE_INVALID", `codearts_cli.json 顶层须为 JSON 对象：path=${file}`);
    }
    raw = parsed as Record<string, unknown>;
  }

  const before = raw["autoupdate"]; // 可能缺失/布尔/其他类型；repair 一律规整为 false
  const auditId = newRepairAuditId();

  if (text !== undefined && before === false) {
    // 幂等：已是 false 无需写；审计照记（审计是"动作发生过"的台账，非"值变化"的台账）
    await appendInstallAudit(cfg, {
      ts: new Date().toISOString(),
      auditId,
      kind: "fix-autoupdate",
      file,
      before: false,
      after: false,
      changed: false,
      result: "already-off",
    });
    return;
  }

  raw["autoupdate"] = false;
  const mode =
    text !== undefined ? (await stat(file)).mode & 0o777 : 0o644; // 保留原权限；新建 0644
  await atomicWriteFile(file, `${JSON.stringify(raw, null, 2)}\n`, mode);
  await appendInstallAudit(cfg, {
    ts: new Date().toISOString(),
    auditId,
    kind: "fix-autoupdate",
    file,
    before: before === undefined ? null : before,
    after: false,
    changed: true,
    result: "fixed",
  });
}

/* ───── ensureBackup（R-fx3：备份是派生物，可安全刷新） ───── */

/**
 * 确保备份在场且新鲜（R-fx3）：
 * - 备份源有效性显式校验（禁静默）：存在 + 非空常规文件 + `--version` 可执行；
 *   有钉版时哈希须与钉版一致——拒绝把漂移内容固化为备份；
 * - 目标 `codearts.bak-<版本>`（版本名=钉版版本 ?? 当前解析版本；
 *   源有效性校验已保证版本可解析，"unknown" 占位名在此路径不可能出现）；
 * - 备份已与当前二进制一致（哈希相等）→ 不重写（派生物幂等），审计 up-to-date；
 * - 缺失/失效 → copyDeploy 刷新（原子替换），审计 refreshed。
 *
 * 审计字段（R-fx6）：{ ts, auditId, kind:"ensure-backup", from, to, sha256, result }。
 */
export async function ensureBackup(cfg: BridgeConfig, exec: Exec): Promise<void> {
  const binPath = binPathOf(cfg.installDir);
  const pin = await readPinned(cfg.stateDir);

  // 源有效性：缺失/非常规文件/空文件 → 显式报错（无备份可做，不静默）
  const st = await statOrEnoent(binPath);
  if (st === undefined || !st.isFile() || st.size === 0) {
    throw new BridgeError("BACKUP_SOURCE_INVALID", `备份源无效（缺失/非常规文件/空文件）：path=${binPath}`, {
      remediation: "先执行 codearts_repair 从备份恢复二进制，或从官方安装包重装后再试",
    });
  }
  const version = await detectVersion(exec, binPath);
  if (version === undefined) {
    throw new BridgeError("BACKUP_SOURCE_INVALID", `备份源不可执行（--version 无有效输出）：path=${binPath}`, {
      remediation: "不可执行的二进制无备份价值：先执行 codearts_repair 修复，或从官方安装包重装",
    });
  }
  const sha = await sha256File(binPath);
  if (pin !== undefined && sha !== pin.sha256) {
    throw new BridgeError(
      "BACKUP_SOURCE_INVALID",
      `备份源 sha256 与钉版记录不符，拒绝把漂移内容固化为备份：path=${binPath}`,
      { remediation: "先执行 codearts_repair 恢复与钉版一致的内容，再刷新备份" },
    );
  }

  const backupPath = path.join(path.dirname(binPath), `codearts.bak-${pin?.version ?? version}`);
  const auditId = newRepairAuditId();

  // 已在场且与当前二进制一致 → 不重写（mtime 不变）
  const existing = await statOrEnoent(backupPath);
  if (existing !== undefined && existing.isFile() && existing.size > 0 && (await sha256File(backupPath)) === sha) {
    await appendInstallAudit(cfg, {
      ts: new Date().toISOString(),
      auditId,
      kind: "ensure-backup",
      from: binPath,
      to: backupPath,
      sha256: sha,
      result: "up-to-date",
    });
    return;
  }

  await copyDeploy(binPath, backupPath, 0o755);
  await appendInstallAudit(cfg, {
    ts: new Date().toISOString(),
    auditId,
    kind: "ensure-backup",
    from: binPath,
    to: backupPath,
    sha256: sha,
    result: "refreshed",
  });
}
