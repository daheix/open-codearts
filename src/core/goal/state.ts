/**
 * 目标状态持久化与对账（T3-04）——守护崩溃/重启后的恢复真相源。
 *
 * 主控裁定落点（progress.md Task 17 派发记录，2026-10-31）：
 * - R-st1（持久化）：saveGoal 经 atomicWriteFile（同目录 tmp+rename，T1-04 原语）
 *   原子落盘；loadGoals 容错——损坏 JSON（解析失败或结构校验失败）→ 该目标就地
 *   标记 blocked 落盘 + 审计（fatal），**不崩守护**；加载器返回"有效目标 + blocked
 *   诊断列表"。任务书的简化签名 `Promise<GoalState[]>` 按裁定改为 `LoadedGoals`
 *   （报告登记；主控裁定原话："加载器返回有效目标+blocked 诊断列表"）。
 * - R-st2（审计）：appendAudit 追加写 `<stateDir>/audit/<goalId>.jsonl`，单文件
 *   串行锁（per-file Promise 链互斥，同 GoalRunner.enqueue 模式）防并发交错；
 *   auditId 形如 `<goalId>-<seq>`，seq 以"锁内读现有行数 +1"推导，严格单调无空洞。
 * - R-st3（对账幂等，Review-Focus-4）：reconcile 只驱动 active 目标——
 *     · 会话活：injected 空 → 重锚注入契约（R-st4）；指纹在场 → 不重发；
 *     · 会话死：重建会话（transport.start 复用旧 ref）+ 断点契约注入；
 *     · 连续两次 reconcile 同目标 → 第二次不注入（injected 指纹去重 +
 *       per-stateDir 互斥序列化，并发调用同样只注入一次）；
 *     · 重建失败 → 该目标 blocked + fatal 审计。
 * - R-st4（对账重锚分支，T3-03 报告登记项的复用）：会话在场但 injected 空 →
 *   重发契约；有 injected 指纹 → 不重发。契约选择判据与 runner.tickLocked 第 5 步
 *   同源：有进度（steps>0）发 buildResumeContract，否则发 buildContract。
 *
 * 与 runner 的分工边界（T3-03 携带指针的落实）：
 * - reconcile 不构造 GoalRunner、不做 tick 决策（本模块无时钟/阈值依赖）——只把
 *   持久化状态修复到"可被 T3-05 宿主 tick 驱动"的形态，必要时直接注入契约；
 *   对账期注入不设回显守卫（deafUntil 是 runner 运行态，回显剥离靠持久化的
 *   injected 指纹，协议层已保证）。
 * - sawStepMarker/pendingVerify/pendingRetry 不持久化（task-16-report 登记）：
 *   对账"有进度"判据退化为 steps.length>0。
 * - 重建全新会话时重置 injected 为本次契约（runner bootstrapLocked 注释登记的
 *   期待："对账若重建了全新会话，由对账层清空 injected 以触发重锚"）——新会话
 *   无旧回显上下文，旧指纹不再适用；同时 rounds+1（注入计一轮）、strikes+1
 *   （与 runner.restartLocked 同口径：重启计入循环保护；阈值告警属 runner 域，
 *   对账层只计数不告警）。
 * - 无会话的 active 目标跳过：首 tick 的 bootstrapLocked 自举即可，无需对账动作。
 * - paused/blocked 目标跳过：人工管辖态，恢复驱动只能经 runner.resume()
 *   （对账若自动复活 paused 目标即违背"人工暂停"语义）。
 *
 * 显式决策登记（非兜底，均有依据）：
 * - loadGoals 对缺失的 goals/ 目录返回空态（ENOENT=首启无目标，"缺失属正常态"
 *   的判官在本层——与 readAksk 同风格）；其他读错误显式上抛。
 * - 容错面 = 单个目标文件的内容损坏（解析/结构失败）；FS 级故障（标记 blocked
 *   时写失败等）显式上抛——盘都写不进时"带病继续"只会掩盖故障。
 * - 损坏标记采用"审计先行 → 覆写为 blocked 最小状态"：原损坏内容不保留（审计
 *   事件携带 reason 与截断 preview 供根因定位），复载幂等稳定（不再重复报损坏）。
 * - blocked 最小状态的 objective 为空串：不可从损坏文件伪造目标文本（禁编造）；
 *   驱动面由 GoalRunner 构造校验（objective 非空）天然拦截，持久层只保证结构。
 * - 结构校验容忍未知多余字段（前向兼容：新版本守护写的字段旧版本可读）；必需
 *   字段缺失/错型一律判损坏——静默丢字段才是兜底。
 * - goalId 白名单 `^[A-Za-z0-9][A-Za-z0-9._-]*$` 且 ≤128 字符：goalId 直接参与
 *   文件路径构造，白名单是路径穿越的显式拒绝面（非法 id 永不落盘/审计）。
 * - 重建路径 transport.start 透传 deps.cfg（可为 undefined）：与 RunnerDeps.cfg
 *   同款已裁定接口缺口（"缺省透传 undefined，由具体传输自行显式校验报错"），
 *   此处禁止伪造配置。
 */

import { chmod, mkdir, open as fsOpen, readFile, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as path from "node:path";
import type { BridgeConfig } from "../config";
import { BridgeError } from "../errors";
import { atomicWriteFile, errnoOf } from "../fsx";
import type { CodeartsTransport, SessionRef } from "../transport/types";
import { buildContract, buildResumeContract } from "./protocol";
import type { GoalPhase, GoalState } from "./runner";

/* ───── 常量与校验 ───── */

/** goalId 白名单（路径安全 + 语义约束；头注"显式决策"条目）。 */
const GOAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** goalId 长度上限（文件名卫生；合法 id 均为生成器产物，远短于此）。 */
const GOAL_ID_MAX = 128;
/** 损坏内容进审计证据的截断长度（防超大垃圾文件撑爆审计流）。 */
const CORRUPT_PREVIEW_CHARS = 200;

/**
 * 校验 goalId（路径安全白名单）；非法抛 GOAL_ID_INVALID。
 * 导出供 T3-05 守护宿主（daemon-goals）复用同一白名单——logs/control 端点以
 * goalId 构造审计文件路径，路径穿越拒绝面必须同源。
 */
export function requireValidGoalId(goalId: string): string {
  if (typeof goalId !== "string" || goalId.length === 0 || goalId.length > GOAL_ID_MAX || !GOAL_ID_RE.test(goalId)) {
    throw new BridgeError(
      "GOAL_ID_INVALID",
      `goalId 非法（须匹配 ${GOAL_ID_RE.source} 且 ≤${GOAL_ID_MAX} 字符）：${JSON.stringify(goalId)}`,
      { remediation: "goalId 由 /goal 创建方生成（<时间戳>-<随机串> 形态）；禁止含路径分隔符等字符。" },
    );
  }
  return goalId;
}

/** 合法阶段集合（与 runner.GoalPhase 同源；此处独立列出防 import 循环依赖值面）。 */
const PHASES: readonly GoalPhase[] = ["active", "paused", "blocked", "complete", "stopped"];

/** 结构校验失败统一出口（load 判损坏 / save 拒写入共用同一判据）。 */
function invalidState(detail: string): BridgeError {
  return new BridgeError("GOAL_STATE_INVALID", `目标状态结构非法：${detail}`, {
    remediation: "状态文件可能损坏或被外部改写；删除对应 goals/<goalId>.json 即放弃该目标进度。",
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isStepArray(v: unknown): v is number[] {
  return Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isInteger(x) && x >= 1);
}

function isNonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/**
 * 结构校验（写入与读入同构；只查形状不查语义——objective 非空等驱动语义由
 * GoalRunner 构造校验把关，blocked 标记态允许空 objective，见头注）。
 * 未知多余字段容忍（前向兼容，头注登记）。失败抛 GOAL_STATE_INVALID。
 */
function validateGoalState(v: unknown, expectedGoalId: string): GoalState {
  if (!isPlainObject(v)) throw invalidState("须为对象");
  const g = v as Record<string, unknown>;
  if (typeof g.goalId !== "string") throw invalidState(`goalId 须为字符串：${JSON.stringify(g.goalId)}`);
  requireValidGoalId(g.goalId);
  if (g.goalId !== expectedGoalId) {
    throw invalidState(`goalId 与文件名不一致：content=${JSON.stringify(g.goalId)} file=${JSON.stringify(expectedGoalId)}`);
  }
  if (typeof g.objective !== "string") throw invalidState("objective 须为字符串");
  if (!isStringArray(g.verify)) throw invalidState("verify 须为字符串数组");
  if (typeof g.phase !== "string" || !(PHASES as readonly string[]).includes(g.phase)) {
    throw invalidState(`phase 须为 ${PHASES.join("/")} 之一：${JSON.stringify(g.phase)}`);
  }
  if (!isNonNegInt(g.rounds)) throw invalidState("rounds 须为非负整数");
  if (!isStepArray(g.steps)) throw invalidState("steps 须为正整数数组");
  if (!isNonNegInt(g.strikes)) throw invalidState("strikes 须为非负整数");
  if (!isStringArray(g.injected)) throw invalidState("injected 须为字符串数组");
  if (typeof g.lastProgressAt !== "number" || !Number.isFinite(g.lastProgressAt)) {
    throw invalidState("lastProgressAt 须为有限数字");
  }
  if (g.session !== undefined) {
    if (!isPlainObject(g.session)) throw invalidState("session 须为对象");
    const s = g.session as Record<string, unknown>;
    if (s.kind !== "structured" && s.kind !== "pty") throw invalidState(`session.kind 须为 structured/pty：${JSON.stringify(s.kind)}`);
    if (typeof s.id !== "string" || s.id.length === 0) throw invalidState("session.id 须为非空字符串");
  }
  if (g.auditId !== undefined && typeof g.auditId !== "string") throw invalidState("auditId 须为字符串");
  // T3-05 新增可选字段（API 契约字段持久化；出现即校验形状，错型判损坏）：
  if (g.workdir !== undefined && (typeof g.workdir !== "string" || g.workdir.length === 0)) {
    throw invalidState("workdir 须为非空字符串");
  }
  if (g.maxRounds !== undefined && (!isNonNegInt(g.maxRounds) || g.maxRounds < 1)) {
    throw invalidState("maxRounds 须为正整数");
  }
  if (g.autoNudge !== undefined && typeof g.autoNudge !== "boolean") {
    throw invalidState("autoNudge 须为布尔值");
  }
  return v as unknown as GoalState;
}

/* ───── 路径布局（<stateDir>/goals、<stateDir>/audit） ───── */

function goalsDirOf(stateDir: string): string {
  return path.join(stateDir, "goals");
}

function auditDirOf(stateDir: string): string {
  return path.join(stateDir, "audit");
}

function goalFileOf(stateDir: string, goalId: string): string {
  return path.join(goalsDirOf(stateDir), `${requireValidGoalId(goalId)}.json`);
}

function auditFileOf(stateDir: string, goalId: string): string {
  return path.join(auditDirOf(stateDir), `${requireValidGoalId(goalId)}.jsonl`);
}

/** 审计流文件绝对路径（导出供 T3-05 守护宿主 logs 分页读取；内部校验 goalId）。 */
export function auditFilePath(stateDir: string, goalId: string): string {
  return auditFileOf(stateDir, goalId);
}

/** 确保子目录存在且 mode 0700（mkdir 的 mode 被 umask 掩蔽，故创建后显式 chmod；同 config.ensureStateDirs 纪律）。 */
async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

/* ───── saveGoal / loadGoals（R-st1） ───── */

/**
 * 原子持久化单个目标状态（R-st1）：同构结构校验 → atomicWriteFile（同目录
 * tmp+rename，崩溃/失败时旧文件原位，绝无半写）。并发写同一目标：最后一次
 * rename 获胜（随机临时件名互不冲突，无交错损坏面）。
 */
export async function saveGoal(stateDir: string, s: GoalState): Promise<void> {
  validateGoalState(s, s.goalId); // 写侧同构校验：拒绝持久化非法形状（禁静默截断/补缺）
  await ensureDir(goalsDirOf(stateDir));
  await atomicWriteFile(goalFileOf(stateDir, s.goalId), `${JSON.stringify(s, null, 2)}\n`);
}

/** 损坏目标诊断（loadGoals 返回的 blocked 列表元素）。 */
export interface CorruptedGoal {
  /** goalId（从文件名提取；文件名非法时为原始名，仅作诊断展示）。 */
  goalId: string;
  /** 状态文件绝对路径。 */
  file: string;
  /** 损坏原因（解析错误消息 / 结构校验详情 / 读错误 errno）。 */
  reason: string;
  /** 已落审计流的事件号；goalId 非法（无法安全构造路径）时缺省。 */
  auditId?: string;
}

/** loadGoals 返回：有效目标 + blocked 诊断列表（R-st1 裁定形状）。 */
export interface LoadedGoals {
  goals: GoalState[];
  corrupted: CorruptedGoal[];
}

/**
 * 载入全部目标状态（R-st1 容错）：逐文件 读→解析→结构校验；内容损坏者就地
 * 标记 blocked（审计先行 → 覆写落盘，头注"显式决策"条目），不中断其余目标、
 * 不崩守护。文件名非法者仅出诊断（无法安全落盘/审计）。复载幂等：blocked
 * 标记态本身合法，再次加载不再报损坏。
 */
export async function loadGoals(stateDir: string): Promise<LoadedGoals> {
  const dir = goalsDirOf(stateDir);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if (errnoOf(e) === "ENOENT") return { goals: [], corrupted: [] }; // 首启无目标：正常空态
    throw new BridgeError(
      "FS_READ_FAILED",
      `读取目标目录失败：path=${dir} reason=${errnoOf(e) ?? "UNKNOWN"}`,
      { cause: e },
    );
  }
  const goals: GoalState[] = [];
  const corrupted: CorruptedGoal[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue; // 非本层管辖文件（留痕/临时件等）视而不见
    const file = path.join(dir, name);
    const stem = name.slice(0, -".json".length);
    try {
      const raw = await readFile(file, "utf8");
      goals.push(validateGoalState(JSON.parse(raw), stem));
    } catch (e) {
      corrupted.push(await markCorrupt(stateDir, file, stem, e));
    }
  }
  return { goals, corrupted };
}

/** 单文件损坏处置：审计（可审计时）→ 覆写为 blocked 最小态；返回诊断。 */
async function markCorrupt(stateDir: string, file: string, stem: string, e: unknown): Promise<CorruptedGoal> {
  // 原因自定位：携带路径（存在性信息）+ 原错误消息，审计事件可独立溯源。
  const reason = `path=${file} ${e instanceof Error ? e.message : String(e)}`;
  if (!GOAL_ID_RE.test(stem) || stem.length > GOAL_ID_MAX) {
    // 非法 goalId：不能构造安全路径，禁止落盘/审计——仅诊断（头注显式决策）。
    return { goalId: stem, file, reason };
  }
  const preview =
    e instanceof SyntaxError || e instanceof BridgeError
      ? (await readFile(file, "utf8").catch(() => undefined))?.slice(0, CORRUPT_PREVIEW_CHARS)
      : undefined; // 读错误（EACCES 等）无内容可预览
  const auditId = await appendAudit(stateDir, stem, {
    type: "goal.error",
    goalId: stem,
    at: Date.now(),
    kind: "state-corrupt",
    fatal: true,
    reason,
    ...(preview !== undefined ? { preview } : {}),
  });
  await saveGoal(stateDir, {
    goalId: stem,
    objective: "", // 不可从损坏文件伪造目标文本（禁编造；驱动面由 runner 构造校验拦截）
    verify: [],
    phase: "blocked",
    rounds: 0,
    steps: [],
    strikes: 0,
    injected: [],
    lastProgressAt: Date.now(),
    auditId,
  });
  return { goalId: stem, file, reason, auditId };
}

/* ───── appendAudit（R-st2） ───── */

/**
 * 串行锁表（per 审计文件绝对路径 → Promise 链尾）：并发 append 同一文件在链上
 * 排队，消除"读行数→追加"的交错窗口。键数以目标数为上界（守护进程生命周期
 * 内单调但有限）；链尾 Promise 恒 resolve，单次失败不断链。
 */
const auditLocks = new Map<string, Promise<unknown>>();

/**
 * 追加一条审计事件（R-st2）：写入 `<stateDir>/audit/<goalId>.jsonl`，行内附
 * auditId（`<goalId>-<seq>`，seq=锁内现有行数+1，1 基）。事件对象浅展开合并，
 * 生成的 auditId 为权威（同名键以本函数产出为准）。写后 fh.sync() 落盘——
 * 审计是事后取证的唯一凭据，耐崩溃性与 fsx 原子写同纪律。
 *
 * @returns auditId（如 "g1-3"）
 */
export async function appendAudit(stateDir: string, goalId: string, e: object): Promise<string> {
  requireValidGoalId(goalId);
  if (!isPlainObject(e)) {
    throw new BridgeError(
      "AUDIT_EVENT_INVALID",
      `审计事件须为普通对象（实际 ${e === null ? "null" : Array.isArray(e) ? "数组" : typeof e}）：goalId=${goalId}`,
    );
  }
  const file = auditFileOf(stateDir, goalId);
  const key = path.resolve(file);
  const run = (auditLocks.get(key) ?? Promise.resolve()).then(
    () => appendAuditLocked(file, goalId, e),
    () => appendAuditLocked(file, goalId, e), // 前驱失败不连坐：本链只求互斥
  );
  auditLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** 锁内临界区：读现有行数 → 定 seq → 单次写入整行 → fsync。 */
async function appendAuditLocked(file: string, goalId: string, e: Record<string, unknown>): Promise<string> {
  await ensureDir(path.dirname(file));
  let lineCount = 0;
  try {
    const content = await readFile(file, "utf8");
    // 行数 = 已占用的 seq 数：换行数即完整行数；无换行结尾的残行（外部改写/
    // 极端撕裂残留）也占一号——本层写入恒带尾换行，此处只计数不解释其内容。
    const nl = (content.match(/\n/g) ?? []).length;
    lineCount = content.endsWith("\n") ? nl : nl + 1;
  } catch (e) {
    if (errnoOf(e) !== "ENOENT") {
      throw new BridgeError(
        "AUDIT_APPEND_FAILED",
        `读取审计文件失败：path=${file} reason=${errnoOf(e) ?? "UNKNOWN"}`,
        { cause: e },
      );
    }
  }
  const auditId = `${goalId}-${lineCount + 1}`;
  const line = `${JSON.stringify({ ...e, auditId })}\n`;
  let fh: FileHandle | undefined;
  try {
    fh = await fsOpen(file, "a");
    await fh.writeFile(line, "utf8");
    await fh.sync();
  } catch (err) {
    throw new BridgeError(
      "AUDIT_APPEND_FAILED",
      `追加审计失败：path=${file} reason=${errnoOf(err) ?? "UNKNOWN"}`,
      { cause: err },
    );
  } finally {
    await fh?.close().catch(() => undefined); // 关闭失败不掩盖主错误（仅资源回收）
  }
  return auditId;
}

/* ───── reconcile（R-st3 幂等 / R-st4 重锚） ───── */

/** reconcile 依赖注入（任务书接口 + 已裁定 cfg 缺口 + T3-05 时钟注入 M72）。 */
export interface ReconcileDeps {
  /** 目标会话传输。 */
  transport: CodeartsTransport;
  /** 传输配置（重建 transport.start 透传；缺省 undefined 由具体传输显式校验）。 */
  cfg?: BridgeConfig;
  /**
   * 时钟源（M72 裁定，T3-05 守护宿主接线）：对账期 lastProgressAt / 审计 at 的
   * 时刻唯一来源。缺省 = 系统墙钟（独立调用方的生产语义，与 loadConfig 缺省
   * process.env 同风格）；守护宿主（GoalHost）必须传入与 GoalRunner 同源的
   * clock——假时钟测试下"对账时刻"与"runner tick 时刻"保持同一条时间线，
   * 禁止墙钟与注入时钟混流。
   */
  clock?: { now(): number };
}

/** reconcile 结果（R-st3：供守护/测试断言）。resumed=已恢复可驱动；blocked=等人工。 */
export interface ReconcileResult {
  resumed: string[];
  blocked: string[];
}

/**
 * 对账互斥锁（per stateDir 绝对路径 → Promise 链尾）：并发/重入 reconcile
 * 序列化，与 injected 指纹去重共同保证"同目标不双注入"（Review-Focus-4）。
 */
const reconcileLocks = new Map<string, Promise<unknown>>();

/**
 * 对账恢复（守护启动时调用，T3-05 接线）：把持久化目标修复到可 tick 驱动的
 * 形态。只处理 active 目标（终态完成、paused/blocked 人工管辖态不触碰）；
 * 损坏目标经 loadGoals 已标 blocked，直接进 blocked 列表。
 *
 * 判定流（R-st3/R-st4）：
 * - 会话活 + injected 空 → 重锚：注入契约（有进度 resume / 无进度 contract），
 *   落盘指纹并审计 goal.inject(kind=reconcile-reanchor)；
 * - 会话活 + 指纹在场 → 不重发（本会话已收到过注入）；
 * - 会话死 → 重建会话（start 复用旧 ref）→ 注入断点契约 → 成功后审计
 *   goal.restart + goal.inject(kind=reconcile-rebuild)，injected 重置为该契约
 *   （新会话清旧指纹）、rounds+1、strikes+1；
 * - 重建失败 → 审计 goal.error(kind=reconcile-rebuild-failed, fatal) → blocked。
 *
 * 错误纪律：仅"重建失败"按裁定降级为 blocked；alive 分支注入失败 / 状态层
 * FS 故障一律显式上抛（守护启动失败可见，禁带病服务——watchdog 重启后下一轮
 * 对账会走重建路径自愈）。
 */
export function reconcile(stateDir: string, deps: ReconcileDeps): Promise<ReconcileResult> {
  const key = path.resolve(stateDir);
  const run = (reconcileLocks.get(key) ?? Promise.resolve()).then(
    () => reconcileLocked(stateDir, deps),
    () => reconcileLocked(stateDir, deps),
  );
  reconcileLocks.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** 锁内主体：逐目标判定与恢复。 */
async function reconcileLocked(stateDir: string, deps: ReconcileDeps): Promise<ReconcileResult> {
  const { goals, corrupted } = await loadGoals(stateDir);
  const resumed: string[] = [];
  const blocked = corrupted.map((c) => c.goalId);
  for (const g of goals) {
    if (g.phase !== "active") continue; // 终态/paused/blocked：不触碰（头注分工边界）
    if (g.session === undefined) continue; // 从未引导：首 tick bootstrap 自举，无需对账
    const alive = await deps.transport.alive(g.session);
    const nowOf = (): number => deps.clock?.now() ?? Date.now(); // M72：注入时钟优先，缺省墙钟
    if (alive) {
      if (g.injected.length === 0) {
        // R-st4 重锚分支：会话在场但从未注入 → 重发契约（判据同 runner.tick 第 5 步）
        const text = progressContractOf(g);
        await deps.transport.inject(g.session, text);
        g.injected = [text];
        g.rounds += 1;
        g.lastProgressAt = nowOf(); // 注入刷新进度时刻（runner.injectPrompt 同语义；时刻源见 ReconcileDeps.clock）
        g.auditId = await appendAudit(stateDir, g.goalId, {
          type: "goal.inject",
          goalId: g.goalId,
          at: nowOf(),
          kind: "reconcile-reanchor",
          rounds: g.rounds,
        });
        await saveGoal(stateDir, g);
      }
      // 指纹在场 → 不重发（R-st4 后半；连续两次 reconcile 的第二次走此路径）
      resumed.push(g.goalId);
      continue;
    }
    // 会话死：重建 + 断点契约（R-st3）。仅"传输阶段失败"按裁定降级 blocked；
    // 状态层 FS 故障（审计/落盘写失败）显式上抛——禁把 FS 故障伪装成目标 blocked。
    // 审计只记已完成动作：start+inject 成功后才落 restart/inject 两条事件；
    // 中途失败走 catch，仅落 rebuild-failed 一条（不预写"已重启"的假事实）。
    let ref: SessionRef;
    let text: string;
    try {
      ref = await deps.transport.start(deps.cfg as BridgeConfig, g.session);
      text = progressContractOf(g);
      await deps.transport.inject(ref, text);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      g.phase = "blocked";
      g.auditId = await appendAudit(stateDir, g.goalId, {
        type: "goal.error",
        goalId: g.goalId,
        at: Date.now(),
        kind: "reconcile-rebuild-failed",
        fatal: true,
        reason,
      });
      await saveGoal(stateDir, g);
      blocked.push(g.goalId);
      continue;
    }
    g.session = ref;
    g.injected = [text]; // 重建全新会话：旧指纹清空，仅留本次契约（runner 重锚期待）
    g.rounds += 1;
    g.strikes += 1; // 与 runner.restartLocked 同口径：重启计入循环保护
    g.lastProgressAt = nowOf();
    await appendAudit(stateDir, g.goalId, {
      type: "goal.restart",
      goalId: g.goalId,
      at: nowOf(),
      reason: "reconcile-session-died",
    });
    g.auditId = await appendAudit(stateDir, g.goalId, {
      type: "goal.inject",
      goalId: g.goalId,
      at: nowOf(),
      kind: "reconcile-rebuild",
      rounds: g.rounds,
    });
    await saveGoal(stateDir, g);
    resumed.push(g.goalId);
  }
  return { resumed, blocked };
}

/**
 * 对账契约选择（R-st3/R-st4）：有进度（持久化 steps 非空）→ 断点续跑契约；
 * 无进度 → 全文契约。与 runner.tickLocked 第 5 步 / restartLocked 同判据同文案
 * （sawStepMarker 为会话期瞬时态不持久化，task-16-report 登记口径）。
 */
function progressContractOf(g: GoalState): string {
  const hasProgress = g.steps.length > 0;
  return hasProgress
    ? buildResumeContract({
        objective: g.objective,
        doneSteps: [...new Set(g.steps)].sort((a, b) => a - b),
      })
    : buildContract(g.objective, g.verify);
}
