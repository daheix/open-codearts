/**
 * codearts-bridge 健康采样与 hygiene 治理——对 codearts 内核 cli-data 的只读体检（T1-06）
 * 与显式治理动作（T1-07）。
 *
 * 目标（痛点②"内存一直增加"可观测化第一步）：一次 collectHealth 产出快照
 *   { rssBytes?, dbBytes, walBytes, dumps{files,bytes}, logs{bytes}, lastErrors[], kernelRssFromLog? }
 *
 * 字段口径：
 * - rssBytes：托管内核进程 RSS 字节（注入 PidProbe，R-h5）；本任务无托管进程 →
 *   undefined（M2 接入后由调用方注入真实探测）。
 * - dbBytes/walBytes：<kernelDataDir>/opencode.db 与 opencode.db-wal（SQLite WAL
 *   标准命名，已对真实安装双确证：内核二进制 strings 出现 "opencode.db-wal"，
 *   且本机存在 ~/.codeartsdoer/codearts-data/opencode.db-wal 实文件）。
 * - dumps：log 目录下 dump-*.heapsnapshot 的数量与字节（真实环境曾累计 1.3GB+，
 *   是磁盘增长的主嫌，故从目录总量中单列分解）。
 * - logs：<kernelDataDir>/log 目录递归总字节（任务书口径"logs=log 目录总字节"；
 *   dumps 就在该目录下，故 logs.bytes ⊇ dumps.bytes，二者是总量与最劣子集的关系）。
 * - lastErrors：内核日志（kernel-*.log）中最近错误摘要，采集规则见 R-h1；
 *   experience-*.log 等异构格式日志不参与解析（格式不符裁定样本），但计入 logs.bytes。
 * - kernelRssFromLog：`service=om "当前进程内存使用情况" rssMB=<n>` 最近一条换算字节
 *   （R-h2：按行序取最后匹配，MB×1024×1024 四舍五入）。
 *
 * 主控裁定（2026-10-31）落点：
 * - R-h1（采集口径，以真实日志格式为准）：kernel 日志逐行形如
 *   `SEV  <ISO时间戳> +<耗时> service=<name> <rest>`（严重度前缀 + 结构化字段）。
 *   采集 = ERROR 前缀行 或 含错误关键词（HEALTH_ERROR_KEYWORDS）的 INFO/WARN 行；
 *   产出规范化摘要：剥离易变字段（时间戳/耗时）→ 超长截断（显式"截断"标记，
 *   禁静默截断）→ 按剥离后文本去重（重复出现记 ×N，保留最后出现时间参与排序）→
 *   上限 HEALTH_MAX_LAST_ERRORS=20 → 按内嵌时间戳升序输出。
 * - R-h3：kernelDataDir 为函数参数（默认 ~/.codeartsdoer/cli-data），
 *   本任务不扩展 BridgeConfig 接口。
 * - R-h4（容忍探测≠掩盖）：目录/文件缺失（ENOENT）→ 对应字段零值/undefined、
 *   不抛错——这是"只读状态采集"语义而非掩盖错误：缺失本身就是健康状态的一部分，
 *   如实报告；IO 非 ENOENT 错误 → 显式抛 BridgeError，绝不静默。
 * - R-h5（PidProbe 注入）：opts.proc 返回"十进制整数字节"字符串（如 "52577"；
 *   显式约定仅此一种形态，前后空白容忍，其余形态一律 PID_PROBE_INVALID，
 *   禁止静默解析）；未注入 → rssBytes=undefined；proc 自身失败 → PID_PROBE_FAILED。
 *
 * 性能注记（真实环境实测 2026-10-31）：lastErrors/kernelRssFromLog 需流式扫读全部
 * kernel-*.log（本机 52 文件/325MB，readline 逐行流式、内存 O(1)），单次采样实测约
 * 14s。M2 接入托管进程后改增量扫描（按文件 offset 续扫，只读新增字节），本任务取
 * 全量扫描的最小正确实现——正确性优先，调用方（M2）据实测耗时决定采样频率。
 */
import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import type { Dirent } from "node:fs";
import { readdir, realpath, rm } from "node:fs/promises";
import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { BridgeError } from "./errors";
import { errnoOf } from "./fsx";
import { appendInstallAudit, statOrEnoent } from "./install";
import type { BridgeConfig } from "./config";

/* ───── 常量（R-h1/R-h2 口径，测试与未来调参共用） ───── */

/** lastErrors 上限（裁定 R-h1：最多 20 条）。 */
export const HEALTH_MAX_LAST_ERRORS = 20;

/** 单条错误摘要截断长度（裁定 R-h1：截断到合理长度；截断必须带显式标记）。 */
export const HEALTH_MAX_ERROR_SUMMARY_CHARS = 500;

/**
 * 错误关键词表（裁定 R-h1 给定的最小集合；INFO/WARN 行命中任一即采集）。
 * 大小写敏感、按内核日志实际写法收录；后续发现新错误形态在此增列并补测试。
 */
export const HEALTH_ERROR_KEYWORDS: readonly string[] = [
  "error fetch",
  "ECONNRESET",
  "timed out",
  "TimeoutError",
];

/** 内核日志文件名（log 目录顶层；真实命名 kernel-<host>-<session>-<ts>-<pid>-<seq>.log）。 */
const KERNEL_LOG_RE = /^kernel-.+\.log$/;

/** 堆转储文件名（log 目录下任意层）。 */
const DUMP_RE = /^dump-.*\.heapsnapshot$/;

/**
 * kernel 自报内存行（R-h2 真实样本）：
 * `INFO  2026-10-30T20:49:52.104 +1ms service=om "当前进程内存使用情况" rssMB=525.77 …`
 */
const RSS_LINE_RE = /service=om\s+"当前进程内存使用情况"\s+rssMB=(\d+(?:\.\d+)?)/;

/**
 * 内核日志行结构（R-h1）：`SEV  <ISO> +<耗时> <rest>`；不匹配者按原样行处理
 * （ERROR 前缀仍采集，仅摘要不做字段剥离——异常格式如实上报而非丢弃）。
 */
const LOG_LINE_RE = /^(DEBUG|INFO|WARN|ERROR)\s+(\S+)\s+\+\S+\s+(.*)$/;

/* ───── 类型 ───── */

/** 健康快照（只读采样结果；字段语义见文件头注）。 */
export interface HealthSnapshot {
  /** 托管进程 RSS 字节（PidProbe 注入）；未注入/无托管进程 → undefined。 */
  rssBytes?: number;
  /** opencode.db 字节；缺失 → 0（R-h4）。 */
  dbBytes: number;
  /** opencode.db-wal 字节；缺失 → 0（R-h4）。 */
  walBytes: number;
  /** dump-*.heapsnapshot 计数与字节；log 目录缺失 → 全零（R-h4）。 */
  dumps: { files: number; bytes: number };
  /** log 目录递归总字节（含 dumps）；目录缺失 → 0（R-h4）。 */
  logs: { bytes: number };
  /** 最近错误摘要（规范化、去重、≤20 条、时间升序；无日志 → 空数组）。 */
  lastErrors: string[];
  /** 内核自报 RSS（最近一条 rssMB 换算字节）；日志缺失/无自报行 → undefined。 */
  kernelRssFromLog?: number;
}

/** collectHealth 选项（R-h3/R-h5：kernelDataDir 传参 + PidProbe 注入）。 */
export interface CollectHealthOptions {
  /** 内核数据目录；缺省 ~/.codeartsdoer/cli-data（R-h3，不扩展 BridgeConfig）。 */
  kernelDataDir?: string;
  /**
   * PidProbe（R-h5）：返回托管进程 RSS 的"十进制整数字节"字符串（如 "52577"）。
   * 唯一合法形态（前后空白容忍）；非法输出显式抛 PID_PROBE_INVALID。
   */
  proc?: () => Promise<string>;
}

/* ───── PidProbe（R-h5） ───── */

/** 解析 PidProbe 输出；唯一合法形态 = 十进制整数字节串（禁静默解析，见头注 R-h5）。 */
async function probeRss(proc: () => Promise<string>): Promise<number> {
  let raw: string;
  try {
    raw = await proc();
  } catch (e) {
    throw new BridgeError(
      "PID_PROBE_FAILED",
      `进程 RSS 探测失败：${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  const text = raw.trim();
  if (!/^\d+$/.test(text)) {
    throw new BridgeError(
      "PID_PROBE_INVALID",
      `进程 RSS 探测输出须为十进制整数字节串，实际为 ${JSON.stringify(raw.slice(0, 64))}`,
    );
  }
  const bytes = Number(text);
  if (!Number.isSafeInteger(bytes)) {
    throw new BridgeError("PID_PROBE_INVALID", `进程 RSS 探测输出超出安全整数范围：${text}`);
  }
  return bytes;
}

/* ───── FS 探测原语（R-h4：ENOENT 容忍 + 非 ENOENT 显式抛） ───── */

/** 单文件字节；缺失 → 0（显式"不存在"状态）；存在但非常规文件 → 显式抛（同 install.ts 纪律）。 */
async function fileSizeOrZero(p: string, label: string): Promise<number> {
  const st = await statOrEnoent(p);
  if (st === undefined) return 0;
  if (!st.isFile()) {
    throw new BridgeError("FS_PATH_NOT_FILE", `${label} 路径存在但不是常规文件：path=${p}`);
  }
  return st.size;
}

/** 目录字节聚合器：totalBytes=全部常规文件；dump* 单列分解。 */
interface DirBytesAgg {
  totalBytes: number;
  dumpFiles: number;
  dumpBytes: number;
}

/**
 * 递归统计目录字节（logs.bytes 口径：目录内全部常规文件之和，dumps 单列）。
 * - ENOENT → 直接返回（上层聚合保持零值，R-h4 状态语义）；
 * - 其他 readdir 错误 → FS_READ_FAILED 显式抛；
 * - 只计常规文件、只下探目录，其余类型（符号链接/FIFO 等）不计入——目录总量
 *   口径固定为"常规文件字节和"，不跟随符号链接（防外逃与环）；文件在 readdir 与
 *   stat 之间被删除（日志轮转竞态）→ 按不存在计（状态采集语义，非掩盖）。
 */
async function walkDirBytes(dir: string, agg: DirBytesAgg): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (errnoOf(e) === "ENOENT") return;
    const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
    throw new BridgeError("FS_READ_FAILED", `读取目录失败：path=${dir} reason=${reason}`, {
      cause: e,
    });
  }
  for (const d of entries) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      await walkDirBytes(p, agg);
    } else if (d.isFile()) {
      const st = await statOrEnoent(p);
      if (st === undefined) continue; // 竞态删除：按不存在计（见函数注释）
      agg.totalBytes += st.size;
      if (DUMP_RE.test(d.name)) {
        agg.dumpFiles += 1;
        agg.dumpBytes += st.size;
      }
    }
  }
}

/* ───── 内核日志扫描（R-h1 lastErrors + R-h2 kernelRssFromLog） ───── */

/** 单条错误的规范化中间态（排序键：最后出现的内嵌时间戳，无时间戳退化到扫描序）。 */
interface ErrorEntry {
  /** 规范化摘要（已剥离时间戳/耗时、已截断带标记）；去重键。 */
  summary: string;
  /** 重复出现次数（×N；首次出现后每次命中累加）。 */
  count: number;
  /** 最后一次出现的内嵌时间戳（epoch ms）；该行无合法时间戳 → undefined。 */
  lastTsMs?: number;
  /** 最后一次出现的全局扫描序号（时间戳缺失时的确定性排序退化键）。 */
  lastSeq: number;
}

/** 排序键：有内嵌时间戳按时间；无时间戳排在一切有时间戳之前（负大数），彼此按扫描序。 */
function orderKey(e: ErrorEntry): number {
  return e.lastTsMs ?? e.lastSeq - Number.MAX_SAFE_INTEGER;
}

/**
 * 规范化单行（R-h1）：剥离 `SEV  <ts> +<dur> ` 易变字段，保留 `SEV <rest>`；
 * 超长截断并附显式标记（禁静默截断）。行结构不符裁定时原样保留（异常格式如实上报）。
 */
function normalizeErrorLine(line: string): string {
  const m = LOG_LINE_RE.exec(line);
  let base = m ? `${m[1]} ${m[3]}` : line;
  if (base.length > HEALTH_MAX_ERROR_SUMMARY_CHARS) {
    base = `${base.slice(0, HEALTH_MAX_ERROR_SUMMARY_CHARS)} …[截断,原长=${base.length}字符]`;
  }
  return base;
}

/** 扫描状态（跨文件累计；seq 为全局行命中序号，供无时间戳行的确定性排序）。 */
interface ScanState {
  kernelRssBytes?: number;
  bySummary: Map<string, ErrorEntry>;
  seq: number;
}

/** 单行处理：R-h2 rssMB 取扫描序最后一条；R-h1 错误行采集/去重/计数。 */
function processLine(line: string, state: ScanState): void {
  const rss = RSS_LINE_RE.exec(line);
  if (rss !== null && rss[1] !== undefined) {
    state.kernelRssBytes = Math.round(Number.parseFloat(rss[1]) * 1024 * 1024);
  }

  const sp = line.indexOf(" ");
  const severity = sp === -1 ? line : line.slice(0, sp);
  const isErrorLine = severity === "ERROR";
  const isKeywordLine =
    (severity === "INFO" || severity === "WARN") &&
    HEALTH_ERROR_KEYWORDS.some((k) => line.includes(k));
  if (!isErrorLine && !isKeywordLine) return;

  const m = LOG_LINE_RE.exec(line);
  const tsMs = m !== null && m[2] !== undefined ? Date.parse(m[2]) : Number.NaN;
  const summary = normalizeErrorLine(line);
  state.seq += 1;
  const prev = state.bySummary.get(summary);
  if (prev !== undefined) {
    prev.count += 1;
    prev.lastSeq = state.seq;
    if (!Number.isNaN(tsMs)) prev.lastTsMs = tsMs;
  } else {
    state.bySummary.set(summary, {
      summary,
      count: 1,
      lastSeq: state.seq,
      lastTsMs: Number.isNaN(tsMs) ? undefined : tsMs,
    });
  }
}

/** 流式扫读单文件（readline 逐行，内存 O(1)）；读失败显式抛（禁静默跳过）。 */
async function scanLogFile(file: string, onLine: (line: string) => void): Promise<void> {
  const input = createReadStream(file, { encoding: "utf8" });
  // 显式捕获底层流错误：防运行时把错误折算成"提前 EOF"导致漏报（禁静默）
  let streamError: unknown;
  input.on("error", (e: unknown) => {
    streamError = e;
  });
  const rl = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      onLine(line);
    }
  } catch (e) {
    const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
    throw new BridgeError("HEALTH_LOG_READ_FAILED", `内核日志扫描失败：path=${file} reason=${reason}`, {
      cause: e,
    });
  } finally {
    rl.close();
  }
  if (streamError !== undefined) {
    const reason =
      errnoOf(streamError) ?? (streamError instanceof Error ? streamError.name : "UNKNOWN");
    throw new BridgeError("HEALTH_LOG_READ_FAILED", `内核日志扫描失败：path=${file} reason=${reason}`, {
      cause: streamError,
    });
  }
}

/**
 * 扫描 kernel-*.log（log 目录顶层）：文件按 mtime 升序（同名并列按文件名）、
 * 文件内按行序 → "按行序"的扫描序语义（R-h2"取最后匹配"依据此序）。
 * 无日志目录/无内核日志 → lastErrors=[] 且 rss 未定义（R-h4 状态语义）。
 */
async function scanKernelLogs(logDir: string): Promise<{
  lastErrors: string[];
  kernelRssBytes?: number;
}> {
  let entries: Dirent[];
  try {
    entries = await readdir(logDir, { withFileTypes: true });
  } catch (e) {
    if (errnoOf(e) === "ENOENT") return { lastErrors: [] };
    const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
    throw new BridgeError("FS_READ_FAILED", `读取目录失败：path=${logDir} reason=${reason}`, {
      cause: e,
    });
  }

  const files: Array<{ path: string; mtimeMs: number; name: string }> = [];
  for (const d of entries) {
    if (!d.isFile() || !KERNEL_LOG_RE.test(d.name)) continue;
    const p = path.join(logDir, d.name);
    const st = await statOrEnoent(p);
    if (st === undefined) continue; // 扫描间隙被轮转删除：跳过（状态采集语义）
    files.push({ path: p, mtimeMs: st.mtimeMs, name: d.name });
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const state: ScanState = { bySummary: new Map(), seq: 0 };
  for (const f of files) {
    await scanLogFile(f.path, (line) => processLine(line, state));
  }

  // 时间升序（稳定排序：同键保持扫描序）→ 取最近 20 条 → 输出保持时间顺序
  const ordered = [...state.bySummary.values()].sort((a, b) => orderKey(a) - orderKey(b));
  const kept = ordered.slice(-HEALTH_MAX_LAST_ERRORS);
  return {
    lastErrors: kept.map((e) => (e.count > 1 ? `${e.summary} ×${e.count}` : e.summary)),
    kernelRssBytes: state.kernelRssBytes,
  };
}

/* ───── collectHealth ───── */

/**
 * 只读采集内核健康快照（字段口径与错误语义见文件头注）。
 *
 * @param cfg  全局配置（本任务只读采样未用到；任务书接口固定携带，
 *             M2 健康快照落盘 <cfg.stateDir>/health 时启用——预留参数，勿删）
 * @param opts kernelDataDir 传参（R-h3）与 PidProbe 注入（R-h5）
 */
export async function collectHealth(
  cfg: BridgeConfig,
  opts: CollectHealthOptions = {},
): Promise<HealthSnapshot> {
  const kernelDataDir = opts.kernelDataDir ?? path.join(homedir(), ".codeartsdoer", "cli-data");
  const logDir = path.join(kernelDataDir, "log");

  // 1) 托管进程 RSS（R-h5）：本任务无托管进程，opts.proc 缺省 → undefined
  const rssBytes = opts.proc !== undefined ? await probeRss(opts.proc) : undefined;

  // 2) db/wal 字节（R-h4：缺失→0；存在但非常规文件→显式抛）
  const dbBytes = await fileSizeOrZero(path.join(kernelDataDir, "opencode.db"), "opencode.db");
  const walBytes = await fileSizeOrZero(
    path.join(kernelDataDir, "opencode.db-wal"),
    "opencode.db-wal",
  );

  // 3) log 目录递归总量 + dumps 子集（R-h4：目录缺失→全零）
  const agg: DirBytesAgg = { totalBytes: 0, dumpFiles: 0, dumpBytes: 0 };
  await walkDirBytes(logDir, agg);

  // 4) 内核日志扫描（lastErrors + kernelRssFromLog）
  const scan = await scanKernelLogs(logDir);

  return {
    rssBytes,
    dbBytes,
    walBytes,
    dumps: { files: agg.dumpFiles, bytes: agg.dumpBytes },
    logs: { bytes: agg.totalBytes },
    lastErrors: scan.lastErrors,
    kernelRssFromLog: scan.kernelRssBytes,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * hygiene 治理（T1-07）——把"内存/磁盘增长"变成显式可执行的治理动作。
 *
 * 主控裁定（2026-10-31）落点：
 * - R-hy1（WAL checkpoint）：bun:sqlite 打开 <kernelDataDir>/opencode.db →
 *   `PRAGMA wal_checkpoint(TRUNCATE)`；打开或 PRAGMA 失败 → 显式抛 BridgeError，
 *   禁止任何静默降级。前置守卫：db 缺失/非常规文件 → 显式报错（new Database 会
 *   静默创建空库，绝不能让"对缺失库做 checkpoint"变成"凭空造库"的静默副作用）。
 * - R-hy2（默认参数）：olderThanDays=30、logsKeep=20；rotate 范围=仅 kernel-*.log
 *   （log 目录顶层，与 scanKernelLogs 同口径；按 mtime 保留最近 keep 个，其余删除）。
 * - R-hy3（purge 边界守卫）：仅匹配 dump-*.heapsnapshot，且候选必须位于
 *   <kernelDataDir>/log 内——realpath（解符号链接）+ 前缀（path.relative）双重校验；
 *   越界 → 拒绝并显式报错（HYGIENE_PATH_ESCAPE），绝不删除。
 * - R-hy4（清单一致性）：planHygiene（纯只读、不写审计）返回的 purge 清单与
 *   applyHygiene 实际删除的清单逐条一致（dry-run 语义）；apply 写入审计（同一
 *   audit/install.jsonl 流，kind=hygiene.apply，含删除清单/checkpoint 结果/轮转数）。
 * - R-hy5（kernelDataDir 传参）：沿用 R-h3 风格，plan/apply 均经 opts 接受
 *   kernelDataDir（默认 ~/.codeartsdoer/cli-data），不扩展 BridgeConfig。
 *
 * 一致性语义与竞态纪律：
 * - purge-dumps 按"清单执行"：plan 给出的每个文件在 apply 时必须仍然在场，
 *   失踪（plan→apply 竞态或外部改动）→ HYGIENE_TARGET_MISSING 显式报错，不静默跳过
 *   （清单一致性优先于尽力而为，失败即重跑一次 plan+apply）。
 * - rotate-logs 按"重枚举执行"（动作只携带 keep 不携带清单）：apply 时重新枚举
 *   kernel-*.log，扫描间隙被外部删除的文件按不存在计（与 scanKernelLogs 同语义）。
 * - 失败审计（T1-05 评审教训）：apply 中途失败 → 记 hygiene.apply(result=failed)
 *   后原样上抛；失败路径的审计写入尽力而为、不掩盖主错误（同 fsx cleanupTmp 纪律）；
 *   成功路径的审计写入失败则显式抛（appendInstallAudit → FS_WRITE_FAILED）。
 * ───────────────────────────────────────────────────────────────────────── */

/** 一天毫秒数（olderThanDays 换算口径）。 */
const DAY_MS = 24 * 60 * 60 * 1000;

/** 默认参数（裁定 R-hy2）：转储保留 30 天。 */
export const HYGIENE_DEFAULT_OLDER_THAN_DAYS = 30;

/** 默认参数（裁定 R-hy2）：内核日志保留最近 20 个。 */
export const HYGIENE_DEFAULT_LOGS_KEEP = 20;

/** 治理动作（任务书接口）：purge-dumps 携带显式清单；rotate-logs 只携带 keep。 */
export type HygieneAction =
  | { kind: "purge-dumps"; files: string[] }
  | { kind: "wal-checkpoint" }
  | { kind: "rotate-logs"; keep: number };

/** planHygiene 选项（R-hy2 默认参数 + R-hy5 kernelDataDir 传参）。 */
export interface HygienePlanOptions {
  /** dump-*.heapsnapshot 的保留天数（超过才入选清理）；默认 30。 */
  olderThanDays?: number;
  /** kernel-*.log 保留个数（按 mtime 保留最近者）；默认 20。 */
  logsKeep?: number;
  /** 内核数据目录；缺省 ~/.codeartsdoer/cli-data（R-hy5，不扩展 BridgeConfig）。 */
  kernelDataDir?: string;
}

/** applyHygiene 选项（R-hy5 kernelDataDir 传参；轮转/清理边界都以它为根）。 */
export interface HygieneApplyOptions {
  /** 内核数据目录；缺省 ~/.codeartsdoer/cli-data（R-hy5，不扩展 BridgeConfig）。 */
  kernelDataDir?: string;
}

/** WAL checkpoint 结果（进审计；页数来自 PRAGMA 返回行）。 */
interface WalCheckpointResult {
  dbPath: string;
  /** PRAGMA 返回的 busy 值（0=成功；非 0 在执行处即已显式抛出，进审计必为 0）。 */
  busy: number;
  /** WAL 中的页数（checkpoint 前）。 */
  logPages: number;
  /** 成功搬入主库的页数。 */
  checkpointedPages: number;
  /** checkpoint 前 WAL 字节。 */
  walBytesBefore: number;
  /** checkpoint 后 WAL 字节（TRUNCATE 成功时趋零）。 */
  walBytesAfter: number;
}

/** 非负整数校验（禁静默截断/钳位：非法值就地显式报错，错误消息含参数名）。 */
function requireNonNegativeInt(name: string, value: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new BridgeError(
      "HYGIENE_OPT_INVALID",
      `hygiene 参数 ${name} 须为非负整数，实际为 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** purge-dumps 候选中间态（递归收集结果）。 */
interface DumpCandidate {
  path: string;
  mtimeMs: number;
}

/**
 * 递归收集 log 目录内全部 dump-*.heapsnapshot（含子目录，与 collectHealth 的 dumps
 * 统计同口径）。ENOENT（log 目录缺失）→ 空收集（无可清理是显式状态，R-h4 同语义）；
 * 其他 readdir 错误 → FS_READ_FAILED 显式抛。stat 竞态消失 → 跳过（扫描语义）。
 */
async function collectDumpCandidates(dir: string, out: DumpCandidate[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (errnoOf(e) === "ENOENT") return;
    const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
    throw new BridgeError("FS_READ_FAILED", `读取目录失败：path=${dir} reason=${reason}`, {
      cause: e,
    });
  }
  for (const d of entries) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      await collectDumpCandidates(p, out);
    } else if (d.isFile() && DUMP_RE.test(d.name)) {
      const st = await statOrEnoent(p);
      if (st === undefined) continue; // 扫描间隙被删除：按不存在计（见函数注释）
      out.push({ path: p, mtimeMs: st.mtimeMs });
    }
  }
}

/**
 * 列出 log 目录顶层的 kernel-*.log（与 scanKernelLogs 同口径：仅常规文件、仅顶层；
 * ENOENT → 空数组；其他 readdir 错误 → FS_READ_FAILED；stat 竞态消失 → 跳过）。
 */
async function listKernelLogs(logDir: string): Promise<Array<{ path: string; mtimeMs: number; name: string }>> {
  let entries: Dirent[];
  try {
    entries = await readdir(logDir, { withFileTypes: true });
  } catch (e) {
    if (errnoOf(e) === "ENOENT") return [];
    const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
    throw new BridgeError("FS_READ_FAILED", `读取目录失败：path=${logDir} reason=${reason}`, {
      cause: e,
    });
  }
  const files: Array<{ path: string; mtimeMs: number; name: string }> = [];
  for (const d of entries) {
    if (!d.isFile() || !KERNEL_LOG_RE.test(d.name)) continue;
    const p = path.join(logDir, d.name);
    const st = await statOrEnoent(p);
    if (st === undefined) continue; // 扫描间隙被轮转删除：跳过（扫描语义）
    files.push({ path: p, mtimeMs: st.mtimeMs, name: d.name });
  }
  return files;
}

/**
 * 只读生成治理计划（dry-run，R-hy4：纯只读、绝不写审计、绝不改动任何文件）。
 *
 * 计划规则（只列"有活可干"的动作，空计划 = 无需治理）：
 * 1. purge-dumps：log 目录内（递归）mtime 早于 now-olderThanDays 的 dump-*.heapsnapshot，
 *    清单按路径升序（确定性，便于 dry-run 对账）；无到期转储 → 不产生动作。
 * 2. wal-checkpoint：opencode.db-wal 存在且非零 → 产生动作（零/缺失无可 checkpoint）；
 *    "WAL 在场但 db 缺失"的异常态照常产生动作，由 apply 显式报错暴露（禁静默跳过）。
 * 3. rotate-logs：kernel-*.log 数量超过 logsKeep → 产生动作（keep 原样回传，供 apply 执行）。
 *
 * @param cfg  全局配置（本函数只读未用到；任务书接口固定携带，M2 计划落盘
 *             <cfg.stateDir>/health 时启用——预留参数，勿删）
 */
export async function planHygiene(
  cfg: BridgeConfig,
  opts: HygienePlanOptions = {},
): Promise<HygieneAction[]> {
  void cfg; // 预留参数（同 collectHealth 注记）
  const olderThanDays = requireNonNegativeInt(
    "olderThanDays",
    opts.olderThanDays ?? HYGIENE_DEFAULT_OLDER_THAN_DAYS,
  );
  const logsKeep = requireNonNegativeInt("logsKeep", opts.logsKeep ?? HYGIENE_DEFAULT_LOGS_KEEP);
  const kernelDataDir = opts.kernelDataDir ?? path.join(homedir(), ".codeartsdoer", "cli-data");
  const logDir = path.join(kernelDataDir, "log");

  const actions: HygieneAction[] = [];

  // 1) purge-dumps：到期转储清单（路径升序，确定性）
  const cutoffMs = Date.now() - olderThanDays * DAY_MS;
  const dumps: DumpCandidate[] = [];
  await collectDumpCandidates(logDir, dumps);
  const stale = dumps
    .filter((d) => d.mtimeMs < cutoffMs)
    .map((d) => d.path)
    .sort();
  if (stale.length > 0) actions.push({ kind: "purge-dumps", files: stale });

  // 2) wal-checkpoint：WAL 在场且非零
  const walStat = await statOrEnoent(path.join(kernelDataDir, "opencode.db-wal"));
  if (walStat !== undefined && walStat.isFile() && walStat.size > 0) {
    actions.push({ kind: "wal-checkpoint" });
  }

  // 3) rotate-logs：超出保留数的部分才产生动作
  const logs = await listKernelLogs(logDir);
  if (logs.length > logsKeep) actions.push({ kind: "rotate-logs", keep: logsKeep });

  return actions;
}

/** hygiene 审计 ID：形如 hy-<epoch 毫秒>-<6 位随机十六进制>（与 rep- 前缀区分动作族）。 */
function newHygieneAuditId(): string {
  return `hy-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

/**
 * 执行单个 purge-dumps 动作（R-hy3 边界守卫 + R-hy4 清单执行）。
 * 逐文件：① 名单校验（必须 dump-*.heapsnapshot）；② realpath 解析（失踪 →
 * HYGIENE_TARGET_MISSING）；③ 前缀校验（realpath 后必须严格位于 log 目录内，
 * 符号链接外逃在此被拦截 → HYGIENE_PATH_ESCAPE）；④ 删除（竞态失踪 →
 * HYGIENE_TARGET_MISSING）。任一校验不过立即显式抛出，绝不删除越界目标。
 * 实际删除的路径追加到 purged（供审计与调用方对账）。
 */
async function applyPurgeDumps(logDir: string, files: string[], purged: string[]): Promise<void> {
  // log 目录必须可解析为真实路径，否则边界无从校验（显式报错，不假定）
  let logReal: string;
  try {
    logReal = await realpath(logDir);
  } catch (e) {
    throw new BridgeError(
      "HYGIENE_PATH_ESCAPE",
      `log 目录不存在或不可解析，无法校验清理边界：path=${logDir}`,
      { cause: e },
    );
  }
  for (const file of files) {
    // ① 名单校验（防伪造动作夹带任意路径）
    if (!DUMP_RE.test(path.basename(file))) {
      throw new BridgeError(
        "HYGIENE_TARGET_INVALID",
        `purge 清单含非 dump-*.heapsnapshot 路径，拒绝执行：path=${file}`,
      );
    }
    // ② realpath（解符号链接；失踪显式报错——清单执行语义，禁静默跳过）
    let fileReal: string;
    try {
      fileReal = await realpath(file);
    } catch (e) {
      if (errnoOf(e) === "ENOENT") {
        throw new BridgeError(
          "HYGIENE_TARGET_MISSING",
          `purge 清单目标已失踪（plan→apply 竞态或外部改动）：path=${file}`,
        );
      }
      const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
      throw new BridgeError("FS_STAT_FAILED", `realpath 失败：path=${file} reason=${reason}`, {
        cause: e,
      });
    }
    // ③ 前缀校验：fileReal 必须严格位于 logReal 内（path.relative 出 ".." 或绝对路径即越界）
    const rel = path.relative(logReal, fileReal);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new BridgeError(
        "HYGIENE_PATH_ESCAPE",
        `purge 目标越界（须位于 log 目录内，realpath 后判定）：path=${file} real=${fileReal} logReal=${logReal}`,
      );
    }
    // ④ 删除（校验全过才动手）
    try {
      await rm(file);
    } catch (e) {
      if (errnoOf(e) === "ENOENT") {
        throw new BridgeError(
          "HYGIENE_TARGET_MISSING",
          `purge 清单目标已失踪（删除竞态）：path=${file}`,
        );
      }
      const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
      throw new BridgeError("FS_WRITE_FAILED", `删除文件失败：path=${file} reason=${reason}`, {
        cause: e,
      });
    }
    purged.push(file);
  }
}

/**
 * 执行 WAL checkpoint（R-hy1）：bun:sqlite 打开 db → `PRAGMA wal_checkpoint(TRUNCATE)`。
 * 前置守卫：db 缺失 → WAL_DB_MISSING（绝不借 new Database 的静默建库副作用造库）；
 * db 非常规文件 → FS_PATH_NOT_FILE；打开/PRAGMA 失败 → WAL_CHECKPOINT_FAILED；
 * PRAGMA 返回 busy≠0（并发读者阻塞，TRUNCATE 未达成）→ WAL_CHECKPOINT_BUSY。
 */
async function applyWalCheckpoint(kernelDataDir: string): Promise<WalCheckpointResult> {
  const dbPath = path.join(kernelDataDir, "opencode.db");
  const walPath = `${dbPath}-wal`;

  const dbStat = await statOrEnoent(dbPath);
  if (dbStat === undefined) {
    throw new BridgeError(
      "WAL_DB_MISSING",
      `SQLite 数据库缺失，无法执行 WAL checkpoint：path=${dbPath}`,
      { remediation: "确认内核数据目录是否正确；缺失的 opencode.db 不应被本动作凭空创建" },
    );
  }
  if (!dbStat.isFile()) {
    throw new BridgeError("FS_PATH_NOT_FILE", `数据库路径存在但不是常规文件：path=${dbPath}`);
  }
  const walBytesBefore = (await statOrEnoent(walPath))?.size ?? 0;

  let db: Database;
  try {
    db = new Database(dbPath);
  } catch (e) {
    throw new BridgeError("WAL_CHECKPOINT_FAILED", `打开 SQLite 数据库失败：path=${dbPath}`, {
      remediation: "检查数据库文件是否损坏或被其他进程以排他方式占用",
      cause: e,
    });
  }
  try {
    let row: { busy?: unknown; log?: unknown; checkpointed?: unknown } | undefined;
    try {
      row = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as typeof row;
    } catch (e) {
      throw new BridgeError(
        "WAL_CHECKPOINT_FAILED",
        `PRAGMA wal_checkpoint(TRUNCATE) 执行失败：path=${dbPath}`,
        { cause: e },
      );
    }
    if (
      row === undefined ||
      typeof row.busy !== "number" ||
      typeof row.log !== "number" ||
      typeof row.checkpointed !== "number"
    ) {
      throw new BridgeError(
        "WAL_CHECKPOINT_FAILED",
        `PRAGMA wal_checkpoint(TRUNCATE) 返回行缺失或形态非法：path=${dbPath} row=${JSON.stringify(row)}`,
      );
    }
    if (row.busy !== 0) {
      throw new BridgeError(
        "WAL_CHECKPOINT_BUSY",
        `WAL checkpoint 因并发读者无法完成（busy=${row.busy}，TRUNCATE 未达成）：path=${dbPath}`,
        { remediation: "待内核空闲后重试；持续 busy 说明有长事务持有 WAL" },
      );
    }
    const walBytesAfter = (await statOrEnoent(walPath))?.size ?? 0;
    return {
      dbPath,
      busy: row.busy,
      logPages: row.log,
      checkpointedPages: row.checkpointed,
      walBytesBefore,
      walBytesAfter,
    };
  } finally {
    try {
      db.close();
    } catch {
      // 关闭失败不掩盖主错误（仅资源回收；同 fsx.fsyncDir 纪律）
    }
  }
}

/**
 * 执行 rotate-logs（R-hy2）：kernel-*.log（log 目录顶层）按 mtime 降序保留最近 keep 个，
 * 其余删除。重枚举语义：扫描间隙被外部删除的目标按不存在计（非清单执行，见头注）。
 * 返回实际删除数；被删路径追加到 rotated（供审计与调用方对账）。
 */
async function applyRotateLogs(logDir: string, keep: number, rotated: string[]): Promise<number> {
  const logs = await listKernelLogs(logDir);
  // 新→旧排序（mtime 降序；并列按文件名升序，确定性），前 keep 个为保留集
  logs.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const victims = logs.slice(keep);
  let removed = 0;
  for (const v of victims) {
    try {
      await rm(v.path);
    } catch (e) {
      if (errnoOf(e) === "ENOENT") continue; // 扫描间隙被删除：按不存在计（重枚举语义）
      const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
      throw new BridgeError("FS_WRITE_FAILED", `删除日志失败：path=${v.path} reason=${reason}`, {
        cause: e,
      });
    }
    rotated.push(v.path);
    removed += 1;
  }
  return removed;
}

/** 审计条目的 walCheckpoint 字段（null=本批动作不含 wal-checkpoint）。 */
type AuditWalField = WalCheckpointResult | null;

/**
 * 执行治理动作（R-hy4：apply 写入审计；动作序列按给定顺序逐个执行）。
 *
 * 成功 → 一条 hygiene.apply(result=ok) 审计（含删除清单 purged/rotated、轮转数
 * rotatedCount、checkpoint 结果 walCheckpoint）并返回 { applied, auditId }；
 * 中途失败 → 先尽力写一条 result=failed 审计（含已执行的部分清单与错误码，不掩盖
 * 主错误）再原样上抛（T1-05 评审教训：失败也要留痕）。
 *
 * @param cfg     全局配置（审计写入 <cfg.stateDir>/audit/install.jsonl）
 * @param actions planHygiene 产出的动作序列（也可手工构造，守卫逐条把关）
 * @param opts    kernelDataDir 传参（R-hy5）
 */
export async function applyHygiene(
  cfg: BridgeConfig,
  actions: HygieneAction[],
  opts: HygieneApplyOptions = {},
): Promise<{ applied: string[]; auditId: string }> {
  const kernelDataDir = opts.kernelDataDir ?? path.join(homedir(), ".codeartsdoer", "cli-data");
  const logDir = path.join(kernelDataDir, "log");
  const auditId = newHygieneAuditId();

  const applied: string[] = [];
  const purged: string[] = [];
  const rotated: string[] = [];
  let walResult: AuditWalField = null;

  const auditBase = {
    ts: new Date().toISOString(),
    auditId,
    kind: "hygiene.apply" as const,
    actions: actions.map((a) => a.kind),
  };

  try {
    for (const action of actions) {
      switch (action.kind) {
        case "purge-dumps":
          await applyPurgeDumps(logDir, action.files, purged);
          applied.push("purge-dumps");
          break;
        case "wal-checkpoint":
          walResult = await applyWalCheckpoint(kernelDataDir);
          applied.push("wal-checkpoint");
          break;
        case "rotate-logs":
          requireNonNegativeInt("keep", action.keep);
          await applyRotateLogs(logDir, action.keep, rotated);
          applied.push("rotate-logs");
          break;
        default:
          // 防静默跳过：未支持的 kind 显式报错（新增动作时在此增列分支并补测试）
          throw new BridgeError(
            "HYGIENE_ACTION_UNKNOWN",
            `未支持的 hygiene 动作 kind：${JSON.stringify((action as { kind?: unknown }).kind)}`,
          );
      }
    }
  } catch (e) {
    // 失败审计尽力而为：审计写失败不得掩盖主错误（同 fsx.cleanupTmp 纪律）
    await appendInstallAudit(cfg, {
      ...auditBase,
      result: "failed",
      error: e instanceof BridgeError ? `${e.code}: ${e.message}` : String(e),
      purged,
      rotated,
      rotatedCount: rotated.length,
      walCheckpoint: walResult,
    }).catch(() => undefined);
    throw e;
  }

  await appendInstallAudit(cfg, {
    ...auditBase,
    result: "ok",
    purged,
    rotated,
    rotatedCount: rotated.length,
    walCheckpoint: walResult,
  });
  return { applied, auditId };
}
