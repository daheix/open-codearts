/**
 * codearts-bridge FakeTransport（T2-01）。
 *
 * 职责：CodeartsTransport 的确定性测试替身——不 spawn 任何进程、无 FS/网络
 * 副作用（R-tr4）。M3 监督状态机（T3-03）将直接注入本类做行为测试；后续真实
 * 传输（T2-02/T2-03/T2-04）以 types.ts 为契约对齐本类的可观测语义。
 *
 * 可复用性设计（主控裁定 2026-10-31 R-tr3，逐条落实）：
 * - ① 脚本化信号队列：`push(ref, sig)` 原样入队 / `emit(ref, t, text?)` 便捷
 *   入队——均显式按 ref 寻址（与六方法一致，多会话脚本无歧义）；队列被消费
 *   期间可继续追加，observe 挂起等待新信号（事件驱动唤醒，无任何定时器——⑤）。
 * - ② 注入留痕：`injections` 按调用顺序记录每次 inject 的 {ref, text, at}，
 *   供"两步提交/注入留痕"断言；stop 后留痕不丢。
 * - ③ alive 可切换：stop → false；start 复用同一 ref（恢复语义）→ true。
 * - ④ stop 后 observe 正常终止（挂起中的 next 得 done）、后续 observe 立即
 *   正常结束（空迭代）、alive=false；stop 幂等。
 * - ⑤ `at` 时间线：**调用序计数器**（二选一裁定：弃注入时钟），会话级单调
 *   递增、inject 与 emit 共享同一刻度（与真实传输的事件序一致）；
 *   start 复用归零（新生命期的确定性起点）。
 *
 * 语义裁决（显式报错，禁静默兜底）：
 * - 未知 ref：inject/observe/stop/snapshot 同步抛 `SESSION_UNKNOWN`，不产生任何
 *   副作用；alive 为**布尔查询**返回 false、start 采纳未知 ref 为新会话
 *   （修复环第 1 轮裁定③④，2026-10-31：与真实传输同源对齐——守护重启对账
 *   必经未知 ref，alive=false 走重建、start(未知 ref)=采纳重建）；
 * - 对非存活会话 inject：抛 `SESSION_NOT_ALIVE` 且不留痕；
 * - 同一 ref 并发第二个 observe：同步抛 `OBSERVER_ACTIVE`（单观察者模型，
 *   消除多消费者争抢信号的歧义；迭代器结束/return/abort 释放后可重新 observe）；
 * - observe 的 signal abort：迭代**立即正常结束**（"立即放弃"语义——已入队
 *   未消费的残存信号丢弃，不抛错，R-tr2）；
 * - snapshot.raw：会话 raw 缓冲按序拼接的 output/error 信号 text（入队时
 *   累积、与是否被 observe 消费无关，模拟终端缓冲区）；其余信号类型与无
 *   text 信号不进 raw。meta 含 id/kind/alive/closed/injections/signalCount
 *   （signalCount = 累计入队信号总数，含已消费）。
 */

import type { BridgeConfig } from "../config";
import { BridgeError } from "../errors";
import type { CodeartsTransport, ObserveOptions, SessionRef, Signal, TransportKind } from "./types";

/** 注入留痕条目（injections 数组元素；ref 用于多会话场景区分归属）。 */
export interface InjectionRecord {
  ref: SessionRef;
  text: string;
  at: number;
}

/** FakeTransport 构造选项。 */
export interface FakeTransportOptions {
  /** 传输种类（SessionRef.kind 与之一致）；缺省 "pty"。 */
  kind?: TransportKind;
}

/** 单个 fake 会话的全部可变状态（经 ref.id 寻址）。 */
interface FakeSession {
  ref: SessionRef;
  alive: boolean;
  /** stop 置位：observe 迭代终止条件之一（与 alive 双保险，语义一致）。 */
  closed: boolean;
  /** 脚本化信号队列（push/emit 入队，observe 按序消费）。 */
  pending: Signal[];
  /** 累计入队信号总数（含已消费；snapshot.meta.signalCount）。 */
  signalCount: number;
  /** raw 缓冲：入队的 output/error 信号 text 按序累积（与消费无关）。 */
  raw: string;
  /** 调用序时间线计数器（inject/emit 共享；start 复用归零）。 */
  atNext: number;
  /** 等待新信号的唤醒函数集合（observe 迭代器注册；push/stop/abort 时逐个唤醒）。 */
  waiters: Array<() => void>;
  /** 当前活跃观察者标记（单观察者模型；null = 无）。 */
  observer: symbol | null;
}

/** FakeTransport：脚本化信号 / 注入留痕 / 可切换存活的确定性传输替身。 */
export class FakeTransport implements CodeartsTransport {
  readonly kind: TransportKind;

  /** 注入留痕（只读纪律：调用方只读，勿改写——数组引用直接暴露以保持零拷贝）。 */
  readonly injections: InjectionRecord[] = [];

  /** 会话表：id → 状态。含已 stop 的会话（留痕/快照不丢）。 */
  private readonly sessions = new Map<string, FakeSession>();

  /** start 自增序号（新会话 id 生成：`fake-<n>`）。 */
  private idNext = 0;

  constructor(opts: FakeTransportOptions = {}) {
    this.kind = opts.kind ?? "pty";
  }

  /* ───── CodeartsTransport 六方法 ───── */

  async start(cfg: BridgeConfig, ref?: SessionRef): Promise<SessionRef> {
    // cfg 仅满足接口签名；Fake 不读配置、无副作用（R-tr4）。显式标注以示故意。
    void cfg;
    if (ref !== undefined) {
      if (ref.kind !== this.kind) {
        // kind 不符 = 非本传输的引用（与 script/tmux 非法引用同裁决：SESSION_UNKNOWN）
        throw new BridgeError("SESSION_UNKNOWN", `非法会话引用：kind=${ref.kind} id=${ref.id}`, {
          remediation: "仅可使用本 transport.start 返回过的 SessionRef。",
        });
      }
      let s = this.sessions.get(ref.id);
      if (s === undefined) {
        // 修复环裁定③（2026-10-31）：未知但形态合法的 ref = 跨守护重启对账
        // 语义（与真实传输对齐）：采纳为新会话（id 保留调用方值）。
        s = {
          ref: { ...ref },
          alive: true,
          closed: false,
          pending: [],
          signalCount: 0,
          raw: "",
          atNext: 0,
          waiters: [],
          observer: null,
        };
        this.sessions.set(ref.id, s);
      }
      // 复用/恢复语义：复活会话并归零时间线；信号队列、raw 缓冲、注入留痕
      // 一律保留（留痕是审计事实，重启不抹除）。
      s.alive = true;
      s.closed = false;
      s.atNext = 0;
      return { ...s.ref };
    }
    const id = `fake-${++this.idNext}`;
    const created: SessionRef = { kind: this.kind, id };
    this.sessions.set(id, {
      ref: created,
      alive: true,
      closed: false,
      pending: [],
      signalCount: 0,
      raw: "",
      atNext: 0,
      waiters: [],
      observer: null,
    });
    return { ...created };
  }

  async inject(ref: SessionRef, text: string): Promise<void> {
    const s = this.requireSession(ref);
    if (!s.alive) {
      throw new BridgeError("SESSION_NOT_ALIVE", `会话已停止，拒绝注入：id=${ref.id}`, {
        remediation: "先 start 复用该会话引用恢复存活，再注入。",
      });
    }
    this.injections.push({ ref: { ...s.ref }, text, at: s.atNext++ });
  }

  observe(ref: SessionRef, opts?: ObserveOptions): AsyncIterable<Signal> {
    const s = this.requireSession(ref);
    if (s.observer !== null) {
      throw new BridgeError(
        "OBSERVER_ACTIVE",
        `会话已有活跃观察者（单观察者模型）：id=${ref.id}`,
        { remediation: "先结束当前观察（迭代完成/return/abort）再重新 observe。" },
      );
    }
    // 已 abort：立即正常结束的空迭代，且不占用观察者名额（"未开始即取消"）。
    if (opts?.signal?.aborted) return emptySignals();

    const token = Symbol("observer");
    s.observer = token;
    const self = this;
    // 消费方显式终结标记：包装迭代器 return/throw 置位并唤醒挂起等待（M34），
    // 挂起中的 next 立即正常落定，委托给 async generator 的 return/throw 请求
    // 才有机会被处理（否则排在永不落定的 next 之后，同样永不落定）。
    let terminated = false;

    async function* iterate(): AsyncGenerator<Signal> {
      const signal = opts?.signal;
      const onAbort = (): void => self.wakeAll(s);
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        while (true) {
          // abort = 立即放弃：每次 next 先检查，未消费残存信号丢弃（R-tr2 正常结束）；
          // 消费方 return/throw 同为立即放弃（terminated，M34 对称语义）。
          if (signal?.aborted || terminated) return;
          if (s.pending.length === 0) {
            if (s.closed || !s.alive) return;
            await waitFor(s);
            continue;
          }
          yield s.pending.shift() as Signal;
        }
      } finally {
        signal?.removeEventListener("abort", onAbort);
        self.releaseObserver(s, token);
      }
    }

    // 包装迭代器：显式 return/throw 时先同步终结挂起等待并释放观察者再委托——
    // ① "未启动即 return"（async generator 体未执行、finally 不触发）也不泄漏；
    // ② 挂起等待（pending next 于 waitFor）时对称唤醒（M34）：与 abort 路径同态，
    //    挂起中的 next 立即正常落定（done）、残存信号丢弃，消费方调用不悬死。
    const inner = iterate();
    const iterator: AsyncIterator<Signal> = {
      next: () => inner.next(),
      return: (v?: unknown) => {
        terminated = true;
        self.releaseObserver(s, token);
        self.wakeAll(s);
        return inner.return(v as undefined);
      },
      throw: (e?: unknown) => {
        terminated = true;
        self.releaseObserver(s, token);
        self.wakeAll(s);
        return inner.throw(e);
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  async alive(ref: SessionRef): Promise<boolean> {
    // 修复环裁定④（2026-10-31）：布尔查询——未知 ref → false（不抛错，
    // 与真实传输同源对齐；守护重启对账凭 false 走重建路径）。
    return this.sessions.get(ref.id)?.alive ?? false;
  }

  async stop(ref: SessionRef): Promise<void> {
    const s = this.requireSession(ref);
    s.alive = false;
    s.closed = true;
    this.wakeAll(s);
  }

  async snapshot(ref: SessionRef): Promise<{ raw: string; meta: Record<string, unknown> }> {
    const s = this.requireSession(ref);
    return {
      raw: s.raw,
      meta: {
        id: s.ref.id,
        kind: s.ref.kind,
        alive: s.alive,
        closed: s.closed,
        injections: this.injections.filter((i) => i.ref.id === s.ref.id).length,
        signalCount: s.signalCount,
      },
    };
  }

  /* ───── Fake 特有脚本 API（测试/T3-03 使用，不属于 CodeartsTransport） ───── */

  /**
   * 向指定会话原样入队一个信号（脚本方完全控制，含 at）；
   * 同时累积 raw 缓冲（output/error 带 text 时）并唤醒挂起的观察者。
   */
  push(ref: SessionRef, sig: Signal): void {
    const s = this.requireSession(ref);
    if ((sig.t === "output" || sig.t === "error") && sig.text !== undefined) {
      s.raw += sig.text;
    }
    s.pending.push(sig);
    s.signalCount++;
    this.wakeAll(s);
  }

  /** 便捷入队：at 由会话调用序计数器提供（与 inject 共享时间线）；返回入队的信号。 */
  emit(ref: SessionRef, t: Signal["t"], text?: string): Signal {
    const s = this.requireSession(ref);
    const at = s.atNext++;
    const sig: Signal = text !== undefined ? { t, at, text } : { t, at };
    this.push(ref, sig);
    return sig;
  }

  /* ───── 内部机制 ───── */

  /** 未知 ref 显式报错（全部方法的统一入口守卫，禁静默兜底）。 */
  private requireSession(ref: SessionRef): FakeSession {
    const s = this.sessions.get(ref.id);
    if (s === undefined) {
      throw new BridgeError("SESSION_UNKNOWN", `未知会话引用：kind=${ref.kind} id=${ref.id}`, {
        remediation: "仅可使用本 transport.start 返回过的 SessionRef。",
      });
    }
    return s;
  }

  /** 释放观察者（仅持有者可释放；幂等）。 */
  private releaseObserver(s: FakeSession, token: symbol): void {
    if (s.observer === token) s.observer = null;
  }

  /** 唤醒全部挂起等待者（push/stop/abort 路径共用；等待者醒来后自旋复查状态）。 */
  private wakeAll(s: FakeSession): void {
    const waiters = s.waiters.splice(0);
    for (const wake of waiters) wake();
  }
}

/** 注册挂起等待：队列/终止状态变化时被唤醒（事件驱动，无定时器）。 */
function waitFor(s: FakeSession): Promise<void> {
  return new Promise((resolve) => {
    s.waiters.push(resolve);
  });
}

/** 空信号迭代（observe 收到已 abort 的 signal 时返回；不占用观察者）。 */
function emptySignals(): AsyncIterable<Signal> {
  return (async function* () {})();
}
