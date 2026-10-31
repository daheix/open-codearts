/**
 * 目标监督状态机（T3-03）——自 codeartsGUI `src/goalrunner.cpp` + `src/retryengine.cpp`
 * （v0.2.6 语义源）逐条移植，驱动 /goal 目标从契约下发到双过验收完成的全生命周期。
 *
 * 主控裁定落点（progress.md Task 16 派发记录，2026-10-31）：
 * - R-rn1（纯 tick 设计）：一切时间推进由外部时钟 `deps.clock` 与调用方 `tick()`
 *   驱动；本文件禁止内嵌 setTimeout/定时器（生产循环宿主在 T3-05 守护）。信号
 *   消费经 transport.observe 事件泵（纯事件驱动，无定时器）；tick 入口先 quiesce
 *   信号泵再决策，保证"已到达的信号先于时间决策被消费"。
 * - R-rn2（并发串行化）：tick/resume/stop 经互斥队列串行；pause() 为同步原子相位
 *   翻转，且每个 await 点之后复查相位——"pause 后并发 tick 不产生注入"有专测钉死。
 * - R-rn3（策略默认对齐 spec §6.3.2）：停滞 stallSeconds（默认 60s：无增量且无
 *   步骤推进）；错误重试无上限（首次立即、retryCapSeconds 封顶、连续 ≥10 告警
 *   不停止）；strikes≥thresholds.strikes 告警不终止；done+verifyRun 双过 →
 *   complete；verify fail → 注入失败原因继续。
 * - R-rn4（判停滞的增量口径）：TUI 动画帧占 output 大头——"增量"= 文本变化指纹
 *   （stripAnsi 后非空且与上次不同）或信号批次密度（3s 窗口 ≥12 块），双口径
 *   并行（v0.2.6 双教训：静态重绘欺骗 / 转轮高频误判），各有测试覆盖。
 * - R-rn5（携带指针）：classifyModelError/normalizeReceived 随本任务移植（C++
 *   正则字面 `\\b` 即 TS 正则 `\b`，逐条对照 goalprotocol.cpp）；protocol.ts
 *   头注 feed 顺序契约（规范化 → 剥离注入回显 → 解析 → 守卫作废 done）严格遵守。
 *
 * 与 C++ 语义源的有意分歧（逐一登记，task-16-report.md 同步）：
 * 1) C++ 把停滞 nudge/强制重启计入 RetryEngine 连续失败（黄条 ≥10）；本实现按
 *    spec §6.3.2 参数表拆分：错误重试计数（RetryEngine，≥10 告警）与 strikes
 *    循环保护（重启/续跑无进展，≥thresholds.strikes 告警）相互独立。
 * 2) C++ normalizeReceived 做 Latin1→UTF-8 还原（Qt receivedData 通道特性）；
 *    TS 传输已按 UTF-8 解码（StringDecoder），改为仅清理未配对代理，防下游
 *    正则/切片错位（task-15 分歧登记的延续）。
 * 3) fatal（blocked）只由 transport 显式 error 信号 + refusal 分类触发；output
 *    正文中的错误词样（含 refusal）沿 C++ 一律重试（防方案描述误判中断）。
 * 4) 进程死重建立即执行（C++ 等 60s 是等 UI 重建就绪；桥接传输 start 即就绪，
 *    TUI 就绪门若实测需要属传输宿主层职责——T13 真机发现已留档）。
 * 5) 错误/进度的计时刻统一取消费时刻（deps.clock）；FakeTransport.at 为调用序
 *    刻度（types.ts 注），不携带毫秒语义。
 *
 * 接口缺口补注（报告登记）：RunnerDeps 增可选 `cfg?: BridgeConfig`——进程死
 * 重建需 transport.start(cfg, ref)。生产宿主（T3-05）必注入 cfg 或注入闭包
 * 配置的 transport 适配层；缺省透传 undefined，由具体传输自行显式校验报错
 * （此处禁止兜底伪造配置——错误在真正的消费点暴露）。
 *
 * T3-05 接线落点（progress.md Task 18 派发记录 R-dg5-①）：RunnerDeps 增可选
 * `autoNudge`——宿主解析生效值（逐目标 GoalState.autoNudge 覆盖 ?? cfg.autoNudge）
 * 后传入；false = 停滞看门狗（tickLocked 第 6 步）整体跳过，不注入不累计
 * strikes。缺省 undefined 视为 true（config 裁决默认，与既有测试兼容）。
 */

import type { BridgeConfig } from "../config";
import { BridgeError } from "../errors";
import type { CodeartsTransport, SessionRef, Signal } from "../transport/types";
import {
  CONTINUE_PROMPT,
  buildContract,
  buildResumeContract,
  parseProgress,
  stripAnsi,
  stripInjectionEcho,
  type ParsedProgress,
} from "./protocol";

/* ───── 公开类型（任务书接口） ───── */

/** 目标阶段：active 驱动中 / paused 人工暂停 / blocked 策略阻塞（等人工）/
 *  complete 双过完成 / stopped 终止（终态）。 */
export type GoalPhase = "active" | "paused" | "blocked" | "complete" | "stopped";

/** 目标状态（持久化形状，T3-04 saveGoal/loadGoals 消费同一形状）。 */
export interface GoalState {
  goalId: string;
  objective: string;
  /** 独立验收命令清单（每条必须独立执行并通过——双过的"独立验收"半）。 */
  verify: string[];
  phase: GoalPhase;
  /** 已注入驱动指令轮次（契约/继续/续跑/重试/验收失败重注均计一次）。 */
  rounds: number;
  /** 已确认完成步骤号清单（长度 = 已完成步数；与 ResumeState.doneSteps 同口径）。 */
  steps: number[];
  /** 连续无进展恢复次数（nudge/重启累计；步进即复位；仅告警不终止）。 */
  strikes: number;
  /** 最近注入文本（回显剥离指纹源；上限 6 条，对齐 C++ noteInjection）。 */
  injected: string[];
  /** 上次真实进度时刻（步进/完成标记/注入均刷新；clock 刻度）。 */
  lastProgressAt: number;
  /** 当前会话引用（传输层不透明值）。 */
  session?: SessionRef;
  /** 审计流标识（由 T3-04 状态层维护；runner 不改写）。 */
  auditId?: string;
  /**
   * 创建请求携带的工作目录（T3-05 API 契约字段；持久化保留、当前版本无消费者
   * ——禁静默丢弃用户输入，语义消费登记待后续任务）。
   */
  workdir?: string;
  /** 创建请求携带的轮次上限（T3-05 API 契约字段；同 workdir，持久化保留）。 */
  maxRounds?: number;
  /**
   * 逐目标自动续跑覆盖（T3-05 R-dg5-①）：缺省随宿主 cfg.autoNudge（config 裁决
   * "默认 true；false=显式退出自动续跑的高级选项"）；生效值经 RunnerDeps.autoNudge
   * 传入 runner。
   */
  autoNudge?: boolean;
}

/** runner 依赖注入（时钟/传输/审计/日志/阈值/验收执行器）。 */
export interface RunnerDeps {
  /** 外部时钟（R-rn1 纯 tick：时间唯一来源）。 */
  clock: { now(): number };
  /** 目标会话传输。 */
  transport: CodeartsTransport;
  /** 结构化审计（spec §6.3.3 事件面：start/inject/retry/restart/resume/pause/
   *  stop/complete/verify/error + warning）。 */
  audit(e: object): void;
  /** 结构化日志（决策过程，非审计流）。 */
  log(e: object): void;
  /** 阈值（config T1-02 校验面：stallSeconds/retryCapSeconds/strikes/echoGuardMs）。 */
  thresholds: BridgeConfig["thresholds"];
  /** 独立验收执行器（verify 非空时必注入——构造期显式校验）。 */
  verifyRun?(cmd: string[]): Promise<{ ok: boolean; out: string }>;
  /**
   * 传输配置（进程死重建 transport.start 透传；接口缺口补注见头注）。
   * 生产宿主必传；缺省透传 undefined 由具体传输显式报错。
   */
  cfg?: BridgeConfig;
  /**
   * 自动续跑开关（T3-05 R-dg5-① 接线）：宿主解析生效值（逐目标覆盖 ?? cfg.autoNudge）
   * 后传入；缺省/undefined → 视为 true（config 裁决默认：停滞 60s 自动续跑，
   * "目标永不挂起"承诺）。false = 停滞看门狗不注入（显式退出的高级选项）。
   */
  autoNudge?: boolean;
}

/* ───── 模型错误分类（源：GoalProtocol::classifyModelError 逐条搬运，R-rn5） ───── */

/** 模型错误类别（与 C++ kPatterns 表一一对应；kind 字符串逐字保留）。 */
export type ModelErrorKind = "timeout" | "rate_limit" | "server" | "network" | "empty" | "refusal";

/**
 * 模式表（写死，FR-9；C++ `\\b` 在 TS 正则字面即 `\b`，语义一致）。
 * 顺序即 C++ 表序：首匹配优先（ECONNREFUSED 因此命中 network 而非 refusal）。
 * 注：`429`、`\b5\d{2}\b` 沿 C++ 原样（"1429" 含 "429" 会命中 rate_limit——
 * 子串语义与源一致，不"修复"）。
 */
const MODEL_ERROR_PATTERNS: ReadonlyArray<readonly [ModelErrorKind, RegExp]> = [
  ["timeout", /\btimed?\s+out\b|\binfo\s+timeout\b|\btimeout\b(?!\s*[=:])|ETIMEDOUT|超时|请求?已?超时/i],
  ["rate_limit", /429|rate\s*limit|too\s+many\s+requests|限流|速度限制/i],
  ["server", /\b5\d{2}\b\s*(internal|server|error)?|internal\s+server\s+error|服务端错误|服务器错误/i],
  ["network", /ECONNRESET|ECONNREFUSED|EPIPE|ENOTFOUND|network\s+error|fetch\s+failed|网络中断|网络错误/i],
  ["empty", /no\s+response|empty\s+response|无返回|没有返回|无响应/i],
  ["refusal", /content\s+(filter|policy)|refused|被拒绝|内容拒绝/i],
];

/**
 * 从一段（可能混有转义序列的）模型输出中分类模型/网络错误（C++ 同名函数移植）。
 * 命中返回类别；未命中返回 null。调用方保证先做注入回显剥离（与 C++ feed 同序）。
 *
 * 匹配前内部先 stripAnsi——对齐 C++ 原语义（goalprotocol.cpp:118-120："同 parse：
 * 只剥离转义序列，不做编码规范化"）：真实 TUI 输出的转义序列可能落在错误词
 * 中间/交错（如 `请求已超\x1b[0m时`），裸文本匹配漏检而 C++ 能检；也与本模块
 * parseProgress 的内剥 ANSI 约定一致。
 */
export function classifyModelError(text: string): ModelErrorKind | null {
  const clean = stripAnsi(text);
  for (const [kind, re] of MODEL_ERROR_PATTERNS) {
    if (re.test(clean)) return kind;
  }
  return null;
}

/**
 * 接收文本规范化（源：GoalProtocol::normalizeReceived 的 TS 适配，分歧 2）：
 * C++ 因 Qt receivedData 的 Latin1 通道做 toLatin1→fromUtf8 还原；TS 传输层
 * 已按 UTF-8 解码，无需重编——仅将未配对代理项替换为 U+FFFD，防止下游
 * 正则/码点切片错位。合法文本（含 CJK 与合法代理对）逐字原样保留。
 */
export function normalizeReceived(raw: string): string {
  if (!/[\uD800-\uDFFF]/.test(raw)) return raw; // 快路径：无代理项
  let out = "";
  for (const ch of raw) {
    // for..of 按码点迭代：合法代理对成对出现（ch.length===2），未配对代理
    // 是单码元（ch.length===1）——据此区分。
    if (ch.length === 1 && ch >= "\uD800" && ch <= "\uDFFF") out += "\uFFFD";
    else out += ch;
  }
  return out;
}

/* ───── 重试引擎（源：retryengine.cpp 逐条移植，纯逻辑、时钟注入） ───── */

/** 写死参数（FR-9，C++ RetryEngine 常量移植）：连续失败 ≥10 次告警。 */
const RETRY_WARN_THRESHOLD = 10;

/**
 * 模型错误永久重试引擎（C++ RetryEngine 同构）：第 1 次失败立即重试，连续失败
 * 间隔封顶（retryCapSeconds，默认 60s——桥接侧经 thresholds 可配，C++ 为写死
 * kRetryIntervalMs=60000），次数无上限、永不放弃；连续 ≥RETRY_WARN_THRESHOLD
 * 次由调用方发告警事件（继续重试不打断）。
 */
class RetryEngine {
  consecutive = 0;
  total = 0;
  nextRetryAtMs = -1;
  lastKind = "";

  /** 错误发生：计数并排程；返回是否已到期（立即重试）。 */
  notifyError(nowMs: number, kind: string, retryIntervalMs: number): boolean {
    this.consecutive += 1;
    this.total += 1;
    this.lastKind = kind;
    this.nextRetryAtMs = this.consecutive === 1 ? nowMs : nowMs + retryIntervalMs;
    return this.shouldRetry(nowMs);
  }

  /** 成功恢复（收到有效输出/步进）：清零活跃计数（审计留痕由调用方维护）。 */
  notifySuccess(): void {
    this.consecutive = 0;
    this.nextRetryAtMs = -1;
    this.lastKind = "";
  }

  shouldRetry(nowMs: number): boolean {
    return this.nextRetryAtMs >= 0 && nowMs >= this.nextRetryAtMs;
  }
}

/* ───── 写死活动窗口参数（C++ goalrunner.cpp 匿名空间常量移植，不进 thresholds） ───── */

/** 活动密度统计窗口（C++ kActivityWindowMs=3000）。 */
const ACTIVITY_WINDOW_MS = 3000;
/** 窗口内 ≥N 块 = 转轮动画在跑（C++ kActivityMinChunks=12）。 */
const ACTIVITY_MIN_CHUNKS = 12;
/** 最近注入保留上限（C++ noteInjection 的 6 条）。 */
const RECENT_INJECTION_CAP = 6;
/** 审计中验收输出截断长度（完整 out 只进注入文案；审计保证据摘要）。 */
const AUDIT_OUT_CHARS = 500;

/**
 * quiesce 排空判据的稳定窗口微任务轮数（quiescePump 注释：async generator 唤醒
 * 管线深度 2~3 轮 + 余量；T3-05 守护集成同块连推多信号用例实证取值）。
 */
const QUIESCE_STABLE_TURNS = 4;

/** 注入种类（审计 goal.inject.kind）。 */
type InjectKind = "contract" | "continue" | "resume" | "verify-fail";

/** 截断审计证据文本（保完整 out 于注入文案，审计留摘要）。 */
function truncateForAudit(s: string): string {
  return s.length > AUDIT_OUT_CHARS ? `${s.slice(0, AUDIT_OUT_CHARS)}…(+${s.length - AUDIT_OUT_CHARS} 字符)` : s;
}

/**
 * 目标监督状态机（spec §6.3.2）。
 *
 * 用法：构造（或由 T3-04 对账恢复 init.state）→ 调用方循环 `tick()`（纯 tick，
 * 生产宿主 T3-05 提供循环）→ `pause()/resume()/stop()` 人工控制；终态
 * complete/stopped 后 tick 为无操作。
 */
export class GoalRunner {
  private readonly deps: RunnerDeps;
  /** 内部可变状态（state()/返回值均走快照拷贝）。 */
  private readonly st: GoalState;

  /* 时间基线（clock 刻度；lastProgressAt 同步进 st 供持久化） */
  private lastActiveAt: number;
  private lastFeedAt: number;
  private lastProgressAt: number;
  private deafUntilMs = -1;
  /** 活动指纹：上次非空屏幕文本（stripAnsi 后，R-rn4 文本变化口径）。 */
  private lastScreenText = "";
  /** 活动密度窗口样本（R-rn4 批次口径）。 */
  private readonly chunks: number[] = [];

  /* 引擎与未决动作（feed 只置位，tick 统一执行——纯 tick 驱动） */
  private readonly retry = new RetryEngine();
  private pendingRetry: { kind: string } | null = null;
  private pendingVerify = false;

  /* 信号泵（transport.observe 事件驱动；无定时器，R-rn1） */
  private pumpAbort: AbortController = new AbortController();
  private pumpLoop = false;
  private pumpParked = false;
  /** 已消费信号计数（quiesce 排空判据：挂起态下一整轮微任务无新消费 → 已排空）。 */
  private feedCount = 0;

  /* 互斥队列（R-rn2：tick/resume/stop 串行） */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(init: GoalState, deps: RunnerDeps) {
    if (init.goalId.trim().length === 0) {
      throw new BridgeError("GOAL_STATE_INVALID", "goalId 不得为空", {
        remediation: "检查 GoalState.goalId 是否已赋值。",
      });
    }
    if (init.objective.trim().length === 0) {
      throw new BridgeError("GOAL_STATE_INVALID", `objective 不得为空：goalId=${init.goalId}`, {
        remediation: "检查 GoalState.objective 是否已赋值。",
      });
    }
    if (init.phase !== "active" && init.phase !== "paused") {
      throw new BridgeError(
        "GOAL_STATE_INVALID",
        `终态 ${init.phase} 不可作为运行态构造 runner：goalId=${init.goalId}`,
        { remediation: "终态目标只读；如需重跑请新建目标。" },
      );
    }
    const verify = init.verify.map((v) => v.trim()).filter((v) => v !== "");
    if (verify.length > 0 && deps.verifyRun === undefined) {
      throw new BridgeError(
        "GOAL_VERIFY_RUN_MISSING",
        `目标声明了 ${verify.length} 条验收命令但未注入 verifyRun：goalId=${init.goalId}`,
        { remediation: "注入 RunnerDeps.verifyRun，或清空 GoalState.verify 清单。" },
      );
    }
    this.deps = deps;
    // 防御性拷贝入参数组（init 可能来自外部持久化对象）
    this.st = { ...init, verify, steps: [...init.steps], injected: [...init.injected] };
    this.lastProgressAt = init.lastProgressAt;
    this.lastActiveAt = init.lastProgressAt; // 无独立活动基线：以进度时刻起步
    this.lastFeedAt = init.lastProgressAt;
    if (init.session !== undefined) this.startPump(init.session);
  }

  /* ───── 公开 API（任务书接口） ───── */

  /**
   * 纯 tick（R-rn1）：按当前时刻消费信号并执行到期的驱动动作（验收/重试/
   * 引导/进程死重建/停滞续跑）。paused/blocked/终态不注入。返回 tick 后状态。
   */
  tick(): Promise<GoalState> {
    return this.enqueue(() => this.tickLocked());
  }

  /** 人工暂停（同步原子相位翻转；终态显式报错；已 paused 幂等）。 */
  pause(): void {
    if (this.st.phase === "complete" || this.st.phase === "stopped") {
      throw new BridgeError(
        "GOAL_TERMINAL_STATE",
        `目标已终态（${this.st.phase}），不可暂停：goalId=${this.st.goalId}`,
        { remediation: "终态目标不可恢复驱动；如需重跑请新建目标。" },
      );
    }
    if (this.st.phase === "paused") return; // 幂等
    this.st.phase = "paused";
    const now = this.now();
    this.deps.audit({ type: "goal.pause", goalId: this.st.goalId, at: now });
    this.deps.log({ type: "goal.log", goalId: this.st.goalId, at: now, msg: "paused" });
  }

  /** 人工恢复：paused/blocked → active 并注入继续指令；终态显式报错。 */
  resume(): Promise<GoalState> {
    return this.enqueue(() => this.resumeLocked());
  }

  /** 终止（终态；complete 已完成不重复审计；幂等）。 */
  stop(): Promise<GoalState> {
    return this.enqueue(() => this.stopLocked());
  }

  /** 状态快照（深拷贝数组字段，调用方改写不渗入）。 */
  state(): Readonly<GoalState> {
    return this.snap();
  }

  /* ───── 互斥队列（R-rn2） ───── */

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined, // 保持链活着：单次失败不断队列
    );
    return run;
  }

  /* ───── tick 决策主体 ───── */

  private async tickLocked(): Promise<GoalState> {
    const now = this.now();
    await this.quiescePump(); // 已到达信号先消费（含同步置位的未决动作）

    if (this.st.phase !== "active") return this.snap(); // paused/blocked/终态不驱动

    // 1) 验收双过（done 申报的处理优先于重试/看门狗——C++ handleMarkers 语义）
    if (this.pendingVerify) {
      await this.runVerifyLocked();
      return this.snap();
    }
    // 2) 错误重试到期（C++ tick 第 1 步：到期重试优先，看门狗让路）
    if (this.pendingRetry !== null && this.retry.shouldRetry(now)) {
      this.pendingRetry = null;
      await this.pumpRetryLocked();
      return this.snap();
    }
    // 3) 引导：无会话 → 建会话 + 下发契约（C++ start() 语义并入首 tick）
    if (this.st.session === undefined) {
      await this.bootstrapLocked();
      return this.snap();
    }
    // 4) 进程死检查（桥接语义：死即重建，不等 60s——头注分歧 4）
    const alive = await this.deps.transport.alive(this.st.session);
    if (this.st.phase !== "active") return this.snap(); // await 间被 pause
    if (!alive) {
      await this.restartLocked(now);
      return this.snap();
    }
    // 5) 对账重锚（T3-04 接口）：会话在场但从未注入过任何契约 → 重发契约锚定
    //    （有进度则发断点续跑契约；T3-04 重建全新会话时应清空 injected）。
    if (this.st.injected.length === 0) {
      const hasProgress = this.hasProgress();
      await this.injectPrompt(
        hasProgress
          ? buildResumeContract({
              objective: this.st.objective,
              doneSteps: [...new Set(this.st.steps)].sort((a, b) => a - b),
            })
          : buildContract(this.st.objective, this.st.verify),
        hasProgress ? "resume" : "contract",
      );
      return this.snap();
    }
    // 6) 停滞看门狗：无增量且无步骤推进 ≥stallMs（双条件，C++ noProg && chatStopped）。
    //    autoNudge=false（R-dg5-①，宿主经 RunnerDeps.autoNudge 传入生效值）= 显式
    //    退出自动续跑：本分支整体跳过（不注入、不累计 strikes），停滞可见性由
    //    lastProgressAt 时间戳承载，恢复驱动只能经 control resume（人工）。
    if (this.deps.autoNudge !== false) {
      const stallMs = this.deps.thresholds.stallSeconds * 1000;
      if (now - this.lastProgressAt >= stallMs && now - this.lastActiveAt >= stallMs) {
        await this.nudgeLocked(now);
      }
    }
    return this.snap();
  }

  /* ───── 引导 / 重试 / 停滞 / 重建 ───── */

  /** 首次驱动：建会话 + 起信号泵 +（未注入过时）下发契约并审计 goal.start。 */
  private async bootstrapLocked(): Promise<void> {
    const now = this.now();
    const ref = await this.deps.transport.start(this.deps.cfg as BridgeConfig);
    this.st.session = ref;
    this.startPump(ref);
    if (this.st.injected.length === 0) {
      // 全新目标：先审计 start（先落盘后下发的 C++ start 语义），再注入契约。
      this.deps.audit({ type: "goal.start", goalId: this.st.goalId, at: now });
      await this.injectPrompt(buildContract(this.st.objective, this.st.verify), "contract");
    }
    // injected 非空 = 持久化恢复（T3-04 对账）：契约已在会话中，不重复注入。
    // （对账若重建了全新会话，由对账层清空 injected 以触发重锚。）
  }

  /** 错误重试注入（C++ pumpRetry）：有进度发轻量继续，无进度重发全文契约。 */
  private async pumpRetryLocked(): Promise<void> {
    if (this.st.phase !== "active") return; // await 间被 pause/blocked
    const hasProgress = this.hasProgress();
    await this.injectPrompt(
      hasProgress ? this.continueText() : buildContract(this.st.objective, this.st.verify),
      hasProgress ? "continue" : "contract",
    );
  }

  /** 停滞续跑（C++ nudgeContinue）：会话活着 → 轻量"继续完成剩余任务"。 */
  private async nudgeLocked(now: number): Promise<void> {
    this.st.strikes += 1;
    this.warnStrikesIfNeeded(now);
    this.deps.log({
      type: "goal.log",
      goalId: this.st.goalId,
      at: now,
      msg: "stall-nudge",
      strikes: this.st.strikes,
    });
    await this.injectPrompt(this.continueText(), "continue");
  }

  /** 进程死重建（plan：stop+start 重建 + 断点契约注入）。 */
  private async restartLocked(now: number): Promise<void> {
    const ref = this.st.session as SessionRef;
    this.deps.audit({
      type: "goal.restart",
      goalId: this.st.goalId,
      at: now,
      reason: "session-died",
    });
    this.st.strikes += 1; // 重启计入循环保护（spec strikes 行）
    this.warnStrikesIfNeeded(now);
    this.pendingRetry = null; // 会话重建后旧重试未决作废
    this.pumpAbort.abort(); // 旧观察流随会话死亡终止（abort → 正常结束，R-tr2）
    await this.awaitPumpDead();
    await this.deps.transport.stop(ref); // 幂等清理（stop+start 重建）
    if (this.st.phase !== "active") return; // await 间被 pause/stop
    const ref2 = await this.deps.transport.start(this.deps.cfg as BridgeConfig, ref);
    this.st.session = ref2;
    this.startPump(ref2);
    // C++ forceRestart 判据：有进度发断点续跑契约，否则重发全文契约。
    const hasProgress = this.hasProgress();
    await this.injectPrompt(
      hasProgress
        ? buildResumeContract({
            objective: this.st.objective,
            // totalSteps 缺省 → 以已知最大完成步号近似（protocol.ts ResumeState
            // 注释口径；parseProgress 不外露 N——task-15 M61 消费侧复述）。
            doneSteps: [...new Set(this.st.steps)].sort((a, b) => a - b),
          })
        : buildContract(this.st.objective, this.st.verify),
      hasProgress ? "resume" : "contract",
    );
  }

  /** strikes 达阈值告警（每次无进展恢复时检查；仅告警不终止）。 */
  private warnStrikesIfNeeded(now: number): void {
    if (this.st.strikes >= this.deps.thresholds.strikes) {
      this.deps.audit({
        type: "goal.warning",
        goalId: this.st.goalId,
        at: now,
        reason: "no-progress",
        strikes: this.st.strikes,
      });
    }
  }

  /** 是否已有可续跑的进度（C++ doneSteps>0||totalSteps>0 的 TS 口径）。 */
  private hasProgress(): boolean {
    return this.st.steps.length > 0 || this.sawStepMarker;
  }
  /** 会话期是否见过步骤标记（含 1/1 这类不产生完成步的标记；不持久化）。 */
  private sawStepMarker = false;

  /* ───── 验收双过（done + verifyRun） ───── */

  private async runVerifyLocked(): Promise<void> {
    this.pendingVerify = false;
    const now = this.now();
    const cmds = this.st.verify;
    let failure: { cmd: string; out: string } | null = null;
    if (cmds.length === 0) {
      // 无验收命令：自报即完成（与 buildContract 空验收省略验收块对称）。
      this.deps.log({
        type: "goal.log",
        goalId: this.st.goalId,
        at: now,
        msg: "verify-skipped-empty",
      });
    } else {
      const run = this.deps.verifyRun as (cmd: string[]) => Promise<{ ok: boolean; out: string }>;
      for (const cmd of cmds) {
        // 简单空白切分为 argv（验收命令不支持引号参数——登记为已知边界，
        // 复杂命令由 T3-05 宿主侧执行器扩展）。
        const argv = cmd.split(/\s+/).filter((p) => p !== "");
        const r = await run(argv);
        this.deps.audit({
          type: "goal.verify",
          goalId: this.st.goalId,
          at: this.now(),
          cmd,
          ok: r.ok,
          out: truncateForAudit(r.out),
        });
        if (!r.ok) {
          failure = { cmd, out: r.out };
          break; // 首败即停（后续命令不执行）
        }
      }
    }
    if (failure === null) {
      // AI 自报 [GOAL-DONE] + 验收通过 → 双过 → complete（C++ onVerifyFinished pass）。
      this.st.phase = "complete";
      this.deps.audit({
        type: "goal.complete",
        goalId: this.st.goalId,
        at: this.now(),
        detail: cmds.length === 0 ? "self-reported-no-verify" : "verify-pass",
      });
      this.deps.log({ type: "goal.log", goalId: this.st.goalId, at: this.now(), msg: "complete" });
      return;
    }
    // 验收未过：注入失败原因继续驱动（C++ refeed 文案逐字保留，不放弃）。
    if (this.st.phase !== "active") {
      this.pendingVerify = true; // await 间被 pause：核验结果延后到恢复后重跑
      return;
    }
    const refeed = `验收未通过：${failure.out}\n请分析失败原因，修正后继续执行，完成后再次输出 [GOAL-DONE]。`;
    await this.injectPrompt(refeed, "verify-fail");
  }

  /* ───── 信号泵与 feed（事件驱动，R-rn1） ───── */

  /** 启动 observe 信号泵：逐信号同步 feed；abort/通道结束即退出。 */
  private startPump(ref: SessionRef): void {
    this.pumpAbort = new AbortController();
    const signal = this.pumpAbort.signal;
    const it = this.deps.transport.observe(ref, { signal })[Symbol.asyncIterator]();
    this.pumpLoop = true;
    void (async () => {
      try {
        for (;;) {
          this.pumpParked = true;
          let r: IteratorResult<Signal>;
          try {
            r = await it.next();
          } finally {
            this.pumpParked = false;
          }
          if (r.done === true) break;
          this.feedCount += 1;
          this.feedSignal(r.value);
        }
      } catch (e) {
        // 观察通道异常：显式审计不吞（后续 tick 的 alive 检查/看门狗仍可驱动重建）。
        this.deps.audit({
          type: "goal.error",
          goalId: this.st.goalId,
          at: this.now(),
          kind: "observe-channel",
          fatal: false,
          message: String(e),
        });
      } finally {
        this.pumpLoop = false;
      }
    })();
  }

  /** 等泵排空已送达信号（tick 决策前消费完，防"信号迟到决策后"竞态）。 */
  private async quiescePump(): Promise<void> {
    for (;;) {
      if (!this.pumpLoop) return; // 泵未启动/已退出：无在途消费
      if (!this.pumpParked) {
        await Promise.resolve(); // 泵正在消费/尚未首停：让渡等它挂起
        continue;
      }
      // 挂起态：连续 QUIESCE_STABLE_TURNS 个微任务轮 feedCount 无变化且泵始终
      // 挂起 → 传输队列已空，决策安全。单轮采样不够（T3-05 守护集成实证）：
      // async generator 的唤醒管线"恢复 → yield → 泵续"跨 2~3 个微任务轮，
      // 同步块内连推的多信号在管线中依次迟到——单轮 feedCount 稳定会误判
      // 排空（首个信号已消费、后续信号尚在管线），违反"已到达信号先于决策
      // 被消费"契约。窗口取 4 轮（覆盖实测管线深度 + 余量）：若仍有在途
      // 信号，feedCount 必在窗口内变化，外层循环继续等。
      const before = this.feedCount;
      let stable = true;
      for (let i = 0; i < QUIESCE_STABLE_TURNS; i++) {
        await Promise.resolve();
        if (!this.pumpLoop || !this.pumpParked || this.feedCount !== before) {
          stable = false;
          break;
        }
      }
      if (stable) return;
    }
  }

  /** 等泵完全退出（重启前确保 observe 槽位释放，防 OBSERVER_ACTIVE）。 */
  private async awaitPumpDead(): Promise<void> {
    while (this.pumpLoop) await Promise.resolve();
  }

  /**
   * 单信号处理（C++ GoalRunner::feed 移植；feed 顺序契约见 protocol.ts 头注）：
   * 规范化 → 判活指纹 → 剥离注入回显 → 解析 → 守卫作废 done → 进度优先 →
   * 错误分类 → 普通输出复位重试。
   */
  private feedSignal(sig: Signal): void {
    // done/idle/step 等无文本信号不入内容管线（transport 层"done"是回合结束，
    // 非 [GOAL-DONE] 目标完成——两者语义正交，注释防混）。
    if (sig.t !== "output" && sig.t !== "error") return;
    const raw = sig.text ?? "";
    const now = this.now();
    this.lastFeedAt = now;

    // 判活增量（R-rn4 双口径，C++ feed 判活段移植）：
    //  a) 文本变化：stripAnsi 后非空且与上次不同 → 真活动（抗静态重绘）；
    //  b) 批次密度：3s 窗口 ≥12 块 → 转轮动画（模型在跑）。
    this.chunks.push(now);
    while (this.chunks.length > 0 && (this.chunks[0] as number) < now - ACTIVITY_WINDOW_MS) {
      this.chunks.shift();
    }
    if (this.chunks.length >= ACTIVITY_MIN_CHUNKS) this.lastActiveAt = now;
    const clean = stripAnsi(raw).trim();
    if (clean !== "" && clean !== this.lastScreenText) {
      this.lastScreenText = clean;
      this.lastActiveAt = now;
    }

    // feed 顺序契约（protocol.ts 头注，T3-02）：规范化 → 剥离 → 解析 → 守卫。
    const inText = stripInjectionEcho(normalizeReceived(raw), this.st.injected);
    const prog = parseProgress(inText);
    // 回显守卫：注入后 echoGuardMs 内作废 done（注入回显里的 [GOAL-DONE] 是
    // 协议说明——错误检测不受守卫，与 C++ 一致）。
    if (now < this.deafUntilMs) prog.done = false;

    // 进度优先：同段有步进/完成标记就不按错误处理（防含"timeout"的方案描述误判）。
    if (prog.steps.length > 0 || prog.done) {
      if (this.retry.consecutive > 0) this.retry.notifySuccess();
      this.pendingRetry = null;
      this.applyProgress(prog, now);
      return;
    }

    // 错误通道 1（即时、不受守卫；仅 active 阶段——paused/blocked 不驱动）。
    const kind = classifyModelError(inText);
    if (sig.t === "error") {
      // transport 显式错误信号是权威错误：未匹配模式表 → 记 unknown（仍可重试，
      // 不静默丢弃错误信号）；refusal → fatal（头注分歧 3）。
      const k: ModelErrorKind | "unknown" = kind ?? "unknown";
      if (this.st.phase === "active") {
        if (k === "refusal") this.enterBlocked(k, now);
        else this.scheduleRetry(k, now);
      }
      return; // error 信号不落入普通输出分支（不复位重试计数）
    }
    if (kind !== null && this.st.phase === "active") {
      this.scheduleRetry(kind, now);
      return;
    }
    // 普通输出：会话存活，复位连续失败计数、清错误重试未决（C++ feed 尾段）。
    if (this.retry.consecutive > 0) this.retry.notifySuccess();
    this.pendingRetry = null;
  }

  /** 步进/完成标记落地（C++ handleMarkers 移植；N 不可知——M61 口径）。 */
  private applyProgress(prog: ParsedProgress, now: number): void {
    this.lastProgressAt = now;
    this.st.lastProgressAt = now;
    this.st.strikes = 0; // 真实步进 → 循环保护复位
    if (prog.steps.length > 0) this.sawStepMarker = true;
    if (prog.plan !== undefined) {
      // 计划清单为提示性字段（task-15 分歧登记）：不消费，权威进度以 [GOAL-STEP] 为准。
      this.deps.log({
        type: "goal.log",
        goalId: this.st.goalId,
        at: now,
        msg: "plan-observed",
        items: prog.plan.length,
      });
    }
    if (prog.steps.length > 0) {
      // 步骤标记出现即视为该步推进：n 号标记把 1..n-1 记为完成（当前步在
      // 下一步出现时转完成——C++ steps[i].done 同语义）。
      const done = new Set(this.st.steps);
      for (const s of prog.steps) {
        for (let i = 1; i < s.n; i++) done.add(i);
      }
      this.st.steps = [...done].sort((a, b) => a - b);
    }
    if (prog.done) {
      // AI 自报完成 → 进入双过核验（实际执行在 tick——纯 tick 驱动）。
      this.pendingVerify = true;
      this.deps.log({
        type: "goal.log",
        goalId: this.st.goalId,
        at: now,
        msg: "done-reported",
        steps: this.st.steps.length,
      });
    }
  }

  /** fatal 错误（error 信号 + refusal）→ blocked 等人工（审计原因，不终止进程）。 */
  private enterBlocked(kind: string, now: number): void {
    this.st.phase = "blocked";
    this.pendingRetry = null;
    this.deps.audit({
      type: "goal.error",
      goalId: this.st.goalId,
      at: now,
      kind,
      fatal: true,
    });
    this.deps.log({
      type: "goal.log",
      goalId: this.st.goalId,
      at: now,
      msg: "blocked-fatal-error",
      kind,
    });
  }

  /** 错误排程（C++ scheduleRetry 移植；注入动作延后到 tick 统一执行）。 */
  private scheduleRetry(kind: string, now: number): void {
    const intervalMs = this.deps.thresholds.retryCapSeconds * 1000;
    this.retry.notifyError(now, kind, intervalMs);
    this.deps.audit({
      type: "goal.retry",
      goalId: this.st.goalId,
      at: now,
      kind,
      consecutive: this.retry.consecutive,
      total: this.retry.total,
    });
    if (this.retry.consecutive >= RETRY_WARN_THRESHOLD) {
      // 连续 ≥10 告警事件（继续重试不打断——C++ warningActive 黄条语义）。
      this.deps.audit({
        type: "goal.warning",
        goalId: this.st.goalId,
        at: now,
        reason: "consecutive-errors",
        consecutive: this.retry.consecutive,
      });
    }
    this.deps.log({
      type: "goal.log",
      goalId: this.st.goalId,
      at: now,
      msg: "error-scheduled",
      kind,
      consecutive: this.retry.consecutive,
      nextRetryAtMs: this.retry.nextRetryAtMs,
    });
    this.pendingRetry = { kind };
  }

  /* ───── 注入与文案 ───── */

  /**
   * 统一注入入口（C++ noteInjection+inject 合流）：留痕（上限 6）→ 开回显守卫
   * 窗 → 传输注入 → 成功后落审计并复位三计时（C++ injectContract/Nudge 尾段
   * 同语义）。调用方保证 phase=active 且 session 在场。
   *
   * 修复环裁定②（2026-10-31，状态失真治理）：留痕指纹与守卫窗**先于字节上线**
   * （注入回显可能在本函数 await 窗口内经信号泵到达，stripInjectionEcho 的指纹
   * 必须已就位）；审计与计时在传输成功后落——传输拒绝（显式上抛前）回滚
   * injected 指纹 / rounds / 守卫窗，杜绝"注入被拒仍留 injected 指纹与 rounds+1"
   * 的状态失真（真机 T4-02 实证：契约被传输拒绝却留下注入痕迹）。
   */
  private async injectPrompt(text: string, kind: InjectKind): Promise<void> {
    const now = this.now();
    const prevDeafUntil = this.deafUntilMs;
    this.st.injected.push(text);
    while (this.st.injected.length > RECENT_INJECTION_CAP) this.st.injected.shift();
    this.deafUntilMs = now + this.deps.thresholds.echoGuardMs;
    this.st.rounds += 1;
    try {
      await this.deps.transport.inject(this.st.session as SessionRef, text);
    } catch (e) {
      // 回滚（text 是刚 push 的最后一条；shift 只可能移除更早条目，pop 恒正确）
      this.st.injected.pop();
      this.st.rounds -= 1;
      this.deafUntilMs = prevDeafUntil;
      throw e;
    }
    this.deps.audit({
      type: "goal.inject",
      goalId: this.st.goalId,
      at: now,
      kind,
      rounds: this.st.rounds,
    });
    this.lastFeedAt = this.lastActiveAt = this.lastProgressAt = now;
    this.st.lastProgressAt = now;
  }

  /**
   * 轻量继续指令（C++ continuePrompt 移植；总步数不可知故不带进度计数——
   * parseProgress 不外露 N，task-15 M61 口径；CONTINUE_PROMPT 常量承载核心语义）。
   */
  private continueText(): string {
    return (
      "【/goal 继续】对话已中断，目标不变、进度保留。\n" +
      `请**${CONTINUE_PROMPT}**，不要重新开始：直接从下一步按协议输出 ` +
      "[GOAL-STEP n/N] <步骤> | 推荐方案: …，全部完成后输出 [GOAL-DONE]。\n"
    );
  }

  /* ───── resume / stop 锁内实现 ───── */

  /**
   * 人工恢复：paused/blocked → active 并注入继续指令；终态显式报错。
   * 修复环裁定⑤（2026-10-31）：resume 前置存活检查——死会话先按进程死重建
   * 路径（裁定③，restartLocked：销毁残留→重建活会话→断点/全文契约注入），
   * 再返回 active；不再对死会话直接注入而永久 SESSION_NOT_ALIVE（真机控制三连
   * 实证：死会话目标 resume 永久失败，仅 stop 可达终态）。
   */
  private async resumeLocked(): Promise<GoalState> {
    if (this.st.phase === "complete" || this.st.phase === "stopped") {
      throw new BridgeError(
        "GOAL_TERMINAL_STATE",
        `目标已终态（${this.st.phase}），不可恢复：goalId=${this.st.goalId}`,
        { remediation: "终态目标不可恢复驱动；如需重跑请新建目标。" },
      );
    }
    if (this.st.phase === "active") return this.snap(); // 幂等
    this.st.phase = "active";
    this.deps.audit({ type: "goal.resume", goalId: this.st.goalId, at: this.now() });
    if (this.st.session === undefined) {
      await this.bootstrapLocked(); // 暂停中的全新目标：恢复即引导
      return this.snap();
    }
    if (!(await this.deps.transport.alive(this.st.session))) {
      await this.restartLocked(this.now()); // ⑤：死会话 → 重建 + resume 契约
      return this.snap();
    }
    await this.injectPrompt(this.continueText(), "continue");
    return this.snap();
  }

  private async stopLocked(): Promise<GoalState> {
    if (this.st.phase === "stopped" || this.st.phase === "complete") return this.snap(); // 幂等
    this.pumpAbort.abort(); // 观察流随会话终止
    if (this.st.session !== undefined) await this.deps.transport.stop(this.st.session);
    this.st.phase = "stopped";
    const now = this.now();
    this.deps.audit({ type: "goal.stop", goalId: this.st.goalId, at: now });
    this.deps.log({ type: "goal.log", goalId: this.st.goalId, at: now, msg: "stopped" });
    return this.snap();
  }

  /* ───── 快照与小工具 ───── */

  private snap(): GoalState {
    return {
      ...this.st,
      verify: [...this.st.verify],
      steps: [...this.st.steps],
      injected: [...this.st.injected],
      session: this.st.session === undefined ? undefined : { ...this.st.session },
    };
  }

  private now(): number {
    return this.deps.clock.now();
  }
}
