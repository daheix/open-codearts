/**
 * 守护目标域宿主（T3-05）——把 T3-03 GoalRunner（纯 tick）与 T3-04 持久化/对账
 * 接进守护 HTTP API（spec §7.2 /goals* 端点的领域层）。
 *
 * 主控裁定落点（progress.md Task 18 派发记录，2026-10-31，逐条）：
 * - R-dg1（构造与循环）：POST /goals → 构造 GoalState（goalId 生成：
 *   `g<clock36>-<8hex>`，匹配 state.ts 白名单）→ saveGoal → 以落盘状态构造
 *   GoalRunner（同一字节落盘后 roster；对账/自举写入的 injected 指纹使 tick
 *   重锚不重复注入——R-st4 语义）→ 立即 loop.wake()（事件驱动首驱）。
 *   周期 sweep 循环为宿主级：生产缺省 setInterval 5s（defaultTickLoop），测试经
 *   TickLoop 注入手动驱动——runner 保持 R-rn1 纯 tick（零内嵌定时器），本模块是
 *   唯一的定时器宿主。
 * - R-dg2（控制语义）：pause=phase 翻转（此后 sweep 不再注入——runner.tick 对
 *   非 active 相位不驱动）；resume=注入继续指令；stop=终态并移出循环名册。
 *   即时生效：control 端点 await runner 动作 + 状态落盘 + 审计冲刷后才响应。
 * - R-dg3（日志分页）：GET /goals/:id/logs 顺序稳定分页——审计文件为追加流，
 *   seq=1 基行号（与 appendAudit 的 auditId 序号同源同序）；cursor=已读最大 seq
 *   （含），返回 seq>cursor 的升序事件页；nextCursor=本页最大 seq（空页=原
 *   cursor）——前进单调、不重复、不遗漏；轮询方以 nextCursor 续读即可。
 * - R-dg4（多目标隔离）：每目标独立 {runner, 审计队列}；sweep 逐目标串行 tick，
 *   单目标失败不中断其余目标（stderr + goal.error 审计留痕，可见非静默）。
 * - R-dg5（携带指针）：
 *   ① autoNudge 接线 runner：生效值 = GoalState.autoNudge（逐目标覆盖）??
 *     cfg.autoNudge（宿主默认），经 RunnerDeps.autoNudge 传入；false 时 runner
 *     停滞看门狗整体跳过。
 *   ② reconcile 墙钟 vs runner clock 混流（M72）：ReconcileDeps 增可选 clock，
 *     GoalHost.start 始终传入与 runner 同源的 clock——假时钟下时间线一致。
 *   ③ 单守护前提以 pidfile 固化（M69）：daemon.pid 在 daemon.ts 实现（HTTP 宿主
 *     生命周期层），本模块不涉。
 *
 * 显式决策登记（非兜底，逐条可审计）：
 * - 审计队列：RunnerDeps.audit 为同步签名（T3-03 接口），而 appendAudit 为异步
 *   ——宿主以 per-goal Promise 链排队，端点响应前 await 冲刷（测试确定性）。
 *   追加失败打 stderr 结构化日志、不掩盖已生效动作（对齐 run.ts R-cr4 "exit
 *   失败不掩盖结果"先例；状态本体已由 saveGoal 持久化）。
 * - sweep 逐目标 tick 异常：stderr + goal.error(kind=tick-failed) 审计各一条，
 *   目标保留待下轮重试（传输瞬断自愈语义，与 runner 进程死重建立即执行同风格）。
 * - 状态落盘节流：sweep 内 JSON 串比对，未变化不写盘（5s 周期的幂等优化，
 *   非"失败兜底"——写失败照常显式报错）。
 * - GET /goals/:id 优先返回在册 runner 的实时状态（比磁盘新）；不在册（终态/
 *   blocked/外部启动前）读磁盘。GET /goals 列表一律读磁盘（全生命周期视图）。
 * - blocked 目标的 control：GoalRunner 构造守卫拒绝 blocked 初值（T3-03），
 *   宿主侧归一为 paused 构造后立即执行动作——resume 的"注入继续并转 active"
 *   与 stop 的"终态"语义由 runner 原样达成，瞬态 paused 不落盘（动作后统一
 *   持久化）；pause 对 blocked 显式拒绝 409（已由策略暂停，重复暂停无意义）。
 * - workdir/maxRounds：任务书 API 契约字段，当前版本无消费者——持久化保留
 *   （禁静默丢弃用户输入），语义消费登记待后续任务；形状校验就地显式报错。
 */

import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { BridgeConfig } from "./core/config";
import { BridgeError } from "./core/errors";
import { errnoOf } from "./core/fsx";
import { appendAudit, auditFilePath, loadGoals, reconcile, requireValidGoalId, saveGoal } from "./core/goal/state";
import type { ReconcileResult } from "./core/goal/state";
import { GoalRunner } from "./core/goal/runner";
import type { GoalPhase, GoalState, RunnerDeps } from "./core/goal/runner";
import type { CodeartsTransport } from "./core/transport/types";

/* ───── tick 循环宿主抽象（R-dg1：定时器唯一宿主） ───── */

/**
 * 生产 sweep 周期（任务书 R-dg1：宿主级 setInterval 5s）——事件驱动之外的
 * 周期兜底驱动（停滞看门狗/重试到期/验收核验的决策节拍）。T3-07 守护服务
 * 装配 defaultTickLoop(GOAL_SWEEP_INTERVAL_MS) 时消费同一常量。
 */
export const GOAL_SWEEP_INTERVAL_MS = 5000;

/** 宿主级 sweep 循环：start 装配、wake 事件驱动、stop 摘除。 */
export interface TickLoop {
  /** 装配周期 sweep（重复 start 须先摘除旧循环——实现自保证幂等）。 */
  start(sweep: () => Promise<void>): void;
  /** 请求立即执行一次 sweep（事件驱动触发；实现可合并并发触发）。 */
  wake(): void;
  /** 摘除循环（守护 stop 路径；幂等）。 */
  stop(): void;
}

/** 生产缺省循环：setInterval(intervalMs) + wake 立即触发（并发触发合并）。 */
export function defaultTickLoop(intervalMs: number): TickLoop {
  let timer: ReturnType<typeof setInterval> | undefined;
  let sweepFn: (() => Promise<void>) | undefined;
  let inFlight = false;
  const fire = (): void => {
    if (inFlight || sweepFn === undefined) return; // 未装配/上轮未结束：合并到下轮（sweep 自带 per-goal 容错）
    inFlight = true;
    void Promise.resolve()
      .then(sweepFn)
      .catch((e: unknown) => {
        // sweep 自身已 per-goal 容错；此处是框架级意外：可见非静默
        console.error(`[codearts-bridge] 目标 sweep 框架异常：${e instanceof Error ? e.message : String(e)}`);
      })
      .finally(() => {
        inFlight = false;
      });
  };
  return {
    start(sweep: () => Promise<void>): void {
      if (timer !== undefined) clearInterval(timer); // 重复 start：先摘旧（幂等）
      sweepFn = sweep;
      timer = setInterval(fire, intervalMs);
      // unref：定时器不独立维持事件循环（守护存活由 HTTP server 承载），
      // 防 bun test 等嵌入场景因在册定时器悬挂退出。
      (timer as unknown as { unref?: () => void }).unref?.();
    },
    wake(): void {
      fire();
    },
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      sweepFn = undefined;
    },
  };
}

/* ───── 守护目标域依赖与请求形状 ───── */

/** GoalHost 依赖注入（传输/时钟/循环/验收执行器）。 */
export interface GoalHostDeps {
  cfg: BridgeConfig;
  /** 目标会话传输（生产由守护装配层选型注入；测试注入 FakeTransport）。 */
  transport: CodeartsTransport;
  /** 时钟（与 runner 同源；R-rn1 纯 tick + M72 对账同源）。 */
  clock: { now(): number };
  /** sweep 循环宿主。 */
  loop: TickLoop;
  /** 独立验收执行器（透传 RunnerDeps.verifyRun；目标声明 verify 时必配）。 */
  verifyRun?(cmd: string[]): Promise<{ ok: boolean; out: string }>;
}

/** POST /goals 请求体（任务书 API 契约 + autoNudge 逐目标覆盖）。 */
export interface GoalCreateInput {
  objective: string;
  verify: string[];
  workdir?: string;
  maxRounds?: number;
  autoNudge?: boolean;
}

/** control 动作（R-dg2）。 */
export type GoalControlAction = "pause" | "resume" | "stop";

/** GET /goals/:id/logs 响应页（R-dg3）。 */
export interface GoalLogsPage {
  goalId: string;
  /** 审计事件（追加序升序；seq=1 基行号与 auditId 序号同源）。 */
  events: Array<Record<string, unknown>>;
  /** 续读游标：本页最大 seq（空页=请求 cursor）；轮询方原样回传。 */
  nextCursor: number;
}

/* ───── 输入校验（显式报错，禁静默截断/补缺） ───── */

/** GET /goals/:id/logs 的 limit 缺省/上限（分页守卫生；防单响应拖垮守护）。 */
export const LOGS_DEFAULT_LIMIT = 200;
export const LOGS_MAX_LIMIT = 1000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function inputError(detail: string): BridgeError {
  return new BridgeError("GOAL_INPUT_INVALID", `POST /goals 请求体非法：${detail}`, {
    remediation: "形如 { objective: string, verify?: string[], workdir?: 绝对路径, maxRounds?: 正整数, autoNudge?: boolean }。",
  });
}

/** blocked 目标的 pause 统一拒绝（在册/非在册同裁决；头注 blocked 条目）。 */
function blockedPauseError(goalId: string): BridgeError {
  return new BridgeError(
    "GOAL_PHASE_INVALID",
    `目标处于 blocked（等人工），pause 无意义：goalId=${goalId}`,
    { remediation: "如需恢复驱动请 resume；如需终止请 stop。" },
  );
}

/** 解析并校验创建请求体（全字段显式校验；未知字段忽略——前向兼容口径）。 */
export function parseCreateInput(raw: unknown): GoalCreateInput {
  if (!isPlainObject(raw)) throw inputError(`须为 JSON 对象（实际 ${raw === null ? "null" : typeof raw}）`);
  const objective = raw["objective"];
  if (typeof objective !== "string" || objective.trim().length === 0) {
    throw inputError(`objective 须为非空字符串（实际 ${JSON.stringify(objective ?? null)}）`);
  }
  let verify: string[] = [];
  if (raw["verify"] !== undefined) {
    if (!Array.isArray(raw["verify"]) || !(raw["verify"] as unknown[]).every((x) => typeof x === "string")) {
      throw inputError("verify 须为字符串数组");
    }
    verify = (raw["verify"] as string[]).map((v) => v.trim()).filter((v) => v !== "");
  }
  let workdir: string | undefined;
  if (raw["workdir"] !== undefined) {
    if (typeof raw["workdir"] !== "string" || (raw["workdir"] as string).length === 0) {
      throw inputError("workdir 须为非空字符串");
    }
    workdir = raw["workdir"] as string;
    if (!path.isAbsolute(workdir)) {
      throw inputError(`workdir 必须为绝对路径（FS 落点禁止依赖 cwd，与配置层同纪律）：${JSON.stringify(workdir)}`);
    }
  }
  let maxRounds: number | undefined;
  if (raw["maxRounds"] !== undefined) {
    const v = raw["maxRounds"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      throw inputError(`maxRounds 须为正整数（实际 ${JSON.stringify(v ?? null)}）`);
    }
    maxRounds = v;
  }
  let autoNudge: boolean | undefined;
  if (raw["autoNudge"] !== undefined) {
    if (typeof raw["autoNudge"] !== "boolean") throw inputError("autoNudge 须为布尔值");
    autoNudge = raw["autoNudge"] as boolean;
  }
  return { objective: objective.trim(), verify, workdir, maxRounds, autoNudge };
}

/* ───── 审计队列（RunnerDeps.audit 同步签名 → 异步追加的宿主桥） ───── */

interface AuditSink {
  push(e: object): void;
  /** 等待已入队事件全部落盘（端点响应前调用，测试确定性）。 */
  flush(): Promise<void>;
}

function makeAuditSink(stateDir: string, goalId: string): AuditSink {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    push(e: object): void {
      const run = tail.then(() => appendAudit(stateDir, goalId, e));
      tail = run.then(
        () => undefined,
        (err: unknown) => {
          // 显式可见、不掩盖已生效动作（头注"显式决策"条目）
          console.error(
            `[codearts-bridge] 目标审计追加失败（动作已生效，审计留痕缺失）：goalId=${goalId} reason=${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
    },
    flush: () => tail.then(() => undefined, () => undefined),
  };
}

/* ───── GoalHost ───── */

/** 循环名册条目：runner + 审计队列 + 上次落盘快照（变化检测）。 */
interface RosterEntry {
  runner: GoalRunner;
  sink: AuditSink;
  lastSaved: string;
}

/**
 * 目标域宿主：GoalRunner 的循环宿主与 /goals* 端点的领域实现（R-dg1~R-dg5）。
 * 守护（daemon.ts）经 createDaemon 第三参挂载；HTTP 形态与鉴权归守护层。
 */
export class GoalHost {
  private readonly deps: GoalHostDeps;
  private readonly stateDir: string;
  private readonly roster = new Map<string, RosterEntry>();
  private sweeping = false;

  constructor(deps: GoalHostDeps) {
    this.deps = deps;
    this.stateDir = deps.cfg.stateDir;
  }

  /**
   * 守护启动装配：对账（M72 时钟同源注入）→ 以落盘状态 roster active/paused
   * 目标（R-dg1"以落盘状态构造 GoalRunner"）→ 启动 sweep 循环。
   * reconcileOverride：daemon 钩子缝（T3-04 DaemonHooks.reconcileOnStart）透传，
   * 测试可替换对账实现；缺省用本模块的真实 reconcile。
   */
  async start(reconcileOverride?: (stateDir: string) => Promise<ReconcileResult>): Promise<ReconcileResult> {
    const result =
      reconcileOverride !== undefined
        ? await reconcileOverride(this.stateDir)
        : await reconcile(this.stateDir, {
            transport: this.deps.transport,
            cfg: this.deps.cfg,
            clock: this.deps.clock, // M72：对账与 runner 同一条时间线
          });
    const { goals } = await loadGoals(this.stateDir);
    for (const g of goals) {
      if (this.roster.has(g.goalId)) continue; // 启动重试路径防双 roster（双 pump 会 OBSERVER_ACTIVE）
      if (g.phase === "active" || g.phase === "paused") this.rosterGoal(g);
    }
    this.deps.loop.start(() => this.sweep());
    return result;
  }

  /** 守护停止：摘除循环。会话与目标状态不销毁（重启后 reconcile 重连续跑）。 */
  stop(): void {
    this.deps.loop.stop();
  }

  /** 健康端点 actives：在册且相位 active 的目标数。 */
  activeCount(): number {
    let n = 0;
    for (const entry of this.roster.values()) {
      if (entry.runner.state().phase === "active") n += 1;
    }
    return n;
  }

  /** 创建目标（R-dg1）：校验 → 落盘 → 以落盘状态 roster → 事件驱动唤醒。 */
  async createGoal(raw: unknown): Promise<{ goalId: string }> {
    const input = parseCreateInput(raw);
    const now = this.deps.clock.now();
    const goalId = `g${now.toString(36)}-${randomBytes(4).toString("hex")}`;
    const state: GoalState = {
      goalId,
      objective: input.objective,
      verify: input.verify,
      phase: "active",
      rounds: 0,
      steps: [],
      strikes: 0,
      injected: [],
      lastProgressAt: now,
      ...(input.workdir !== undefined ? { workdir: input.workdir } : {}),
      ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
      ...(input.autoNudge !== undefined ? { autoNudge: input.autoNudge } : {}),
    };
    await saveGoal(this.stateDir, state);
    this.rosterGoal(state);
    this.deps.loop.wake(); // 事件驱动首驱（生产缺省循环立即 sweep；测试手动驱动不受影响）
    return { goalId };
  }

  /** 全量目标列表（磁盘真相；spec §7.2 摘要形态，objective 截断 ≤120 字）。 */
  async listGoals(): Promise<Array<{ goalId: string; state: GoalPhase; rounds: number; strikes: number; objective: string }>> {
    const { goals } = await loadGoals(this.stateDir);
    return goals.map((g) => ({
      goalId: g.goalId,
      state: g.phase,
      rounds: g.rounds,
      strikes: g.strikes,
      objective: g.objective.slice(0, 120),
    }));
  }

  /** 单目标完整状态（在册优先实时，否则读磁盘）。 */
  async getGoal(goalId: string): Promise<GoalState> {
    requireValidGoalId(goalId);
    const entry = this.roster.get(goalId);
    if (entry !== undefined) return entry.runner.state();
    return this.loadFromDisk(goalId);
  }

  /** control 端点（R-dg2）：pause/resume/stop 即时生效并持久化。 */
  async control(goalId: string, action: unknown): Promise<GoalState> {
    requireValidGoalId(goalId);
    if (action !== "pause" && action !== "resume" && action !== "stop") {
      throw new BridgeError("GOAL_ACTION_INVALID", `control action 非法（须为 pause/resume/stop）：${JSON.stringify(action)}`);
    }
    const entry = await this.resolveEntry(goalId, action);
    if (action === "pause" && entry.runner.state().phase === "blocked") {
      // 在册 blocked 目标的 pause 同样显式拒绝（与 resolveEntry 非在册路径同一裁决）
      throw blockedPauseError(goalId);
    }
    let st: GoalState;
    if (action === "pause") {
      entry.runner.pause(); // 同步原子翻转（R-rn2）；终态已在 resolveEntry 拦截
      st = entry.runner.state();
    } else if (action === "resume") {
      st = await entry.runner.resume();
    } else {
      st = await entry.runner.stop();
    }
    await saveGoal(this.stateDir, st);
    entry.lastSaved = JSON.stringify(st);
    await entry.sink.flush(); // R-dg2 即时生效：响应前审计已落盘
    if (st.phase === "complete" || st.phase === "stopped") this.roster.delete(goalId);
    return st;
  }

  /** logs 分页（R-dg3）：磁盘审计流的顺序稳定分页。 */
  async getLogs(goalId: string, cursor?: number, limit?: number): Promise<GoalLogsPage> {
    requireValidGoalId(goalId);
    await this.loadFromDisk(goalId); // 存在性守卫（终态/blocked 目标的审计同样可读）
    const cur = cursor ?? 0;
    const limRaw = limit ?? LOGS_DEFAULT_LIMIT;
    if (limRaw > LOGS_MAX_LIMIT) {
      // 上限显式拒绝（禁静默钳位——超限是调用方错误，就地上报）
      throw new BridgeError("GOAL_LIMIT_INVALID", `limit 超过上限 ${LOGS_MAX_LIMIT}：${limRaw}`);
    }
    const lim = limRaw;
    const file = auditFilePath(this.stateDir, goalId);
    let content: string | undefined;
    try {
      content = await readFile(file, "utf8");
    } catch (e) {
      if (errnoOf(e) !== "ENOENT") {
        throw new BridgeError(
          "AUDIT_READ_FAILED",
          `读取审计流失败：path=${file} reason=${errnoOf(e) ?? "UNKNOWN"}`,
          { cause: e },
        );
      }
      // ENOENT：目标尚无审计事件（创建后未驱动）——合法空页，与 loadGoals 首启口径一致
    }
    const matched: Array<{ seq: number; event: Record<string, unknown> }> = [];
    if (content !== undefined) {
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string;
        if (line.trim().length === 0) continue; // 尾换行产生的空段
        const seq = i + 1;
        if (seq <= cur) continue;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch (cause) {
          // 审计流损坏（外部改写/撕裂）：显式报错，禁静默跳行（取证凭据不容猜）
          throw new BridgeError(
            "AUDIT_LOG_CORRUPT",
            `审计行解析失败：path=${file} line=${seq}（seq 基于行号，损坏即停止分页）`,
            { cause },
          );
        }
        matched.push({ seq, event: { ...(event as Record<string, unknown>), seq } });
      }
    }
    const page = matched.slice(0, lim);
    const nextCursor = page.length > 0 ? (page[page.length - 1] as { seq: number }).seq : cur;
    return { goalId, events: page.map((p) => p.event), nextCursor };
  }

  /* ───── 内部：roster / sweep / 解析 ───── */

  /** 以（落盘）状态构造 runner 并入册（R-dg1）。 */
  private rosterGoal(g: GoalState): RosterEntry {
    const sink = makeAuditSink(this.stateDir, g.goalId);
    const deps: RunnerDeps = {
      clock: this.deps.clock,
      transport: this.deps.transport,
      audit: (e: object) => sink.push(e),
      log: (e: object) => {
        // 决策日志（非审计流）：stderr 结构化可见（守护暂无文件日志器，与既有
        // server 启动摘要同通道）
        console.error(`[codearts-bridge] ${JSON.stringify(e)}`);
      },
      thresholds: this.deps.cfg.thresholds,
      verifyRun: this.deps.verifyRun,
      cfg: this.deps.cfg,
      autoNudge: g.autoNudge ?? this.deps.cfg.autoNudge, // R-dg5-① 生效值解析
    };
    const runner = new GoalRunner(g, deps);
    const entry: RosterEntry = { runner, sink, lastSaved: JSON.stringify(g) };
    this.roster.set(g.goalId, entry);
    return entry;
  }

  /**
   * 一轮 sweep：逐目标 tick → 变化落盘 → 终态出册（R-dg4 隔离：单目标失败
   * 留痕继续）。并发触发合并（上轮未结束直接跳过，下轮周期追平）。
   */
  private async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const [goalId, entry] of [...this.roster]) {
        const before = entry.runner.state().phase;
        if (before === "complete" || before === "stopped") {
          this.roster.delete(goalId); // control 路径已落盘；此处仅清名册
          continue;
        }
        try {
          const after = await entry.runner.tick();
          const json = JSON.stringify(after);
          if (json !== entry.lastSaved) {
            await saveGoal(this.stateDir, after);
            entry.lastSaved = json;
          }
          if (after.phase === "complete" || after.phase === "stopped") this.roster.delete(goalId);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[codearts-bridge] 目标 tick 失败（保留待下轮重试）：goalId=${goalId} ${msg}`);
          entry.sink.push({
            type: "goal.error",
            goalId,
            at: this.deps.clock.now(),
            kind: "tick-failed",
            fatal: false,
            message: msg,
          });
          await entry.sink.flush();
        }
      }
    } finally {
      this.sweeping = false;
    }
  }

  /** control 目标解析：在册直取；否则读盘并按需归一入册（头注 blocked 条目）。 */
  private async resolveEntry(goalId: string, action: GoalControlAction): Promise<RosterEntry> {
    const existing = this.roster.get(goalId);
    if (existing !== undefined) return existing;
    const g = await this.loadFromDisk(goalId);
    if (g.phase === "complete" || g.phase === "stopped") {
      throw new BridgeError(
        "GOAL_TERMINAL_STATE",
        `目标已终态（${g.phase}），control 不可用：goalId=${goalId}`,
        { remediation: "终态目标只读；如需重跑请新建目标。" },
      );
    }
    if (g.phase === "blocked" && action === "pause") {
      throw blockedPauseError(goalId);
    }
    if (g.phase === "blocked") {
      // 宿主归一（头注"显式决策"条目）：paused 构造后由动作语义落实
      // （resume=注入继续并转 active / stop=终态），瞬态不落盘。
      g.phase = "paused";
    }
    return this.rosterGoal(g);
  }

  /** 从磁盘载入单个目标；不存在 → GOAL_NOT_FOUND（显式 404）。 */
  private async loadFromDisk(goalId: string): Promise<GoalState> {
    const { goals } = await loadGoals(this.stateDir);
    const g = goals.find((x) => x.goalId === goalId);
    if (g === undefined) {
      throw new BridgeError("GOAL_NOT_FOUND", `目标不存在：goalId=${goalId}`, {
        remediation: "GET /goals 查看全部目标。",
      });
    }
    return g;
  }
}
