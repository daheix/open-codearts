/**
 * codearts-bridge 传输层接口（T2-01）。
 *
 * 职责：定义目标会话传输的最小完整抽象（R-tr1），供 M2 各传输实现
 * （T2-02 script PTY / T2-03 tmux / T2-04 structured）与 M3 监督状态机
 * （T3-03 经 FakeTransport）共同依赖。
 *
 * 主控裁定 2026-10-31（R-tr1）：本文件为传输接口唯一真相源；签名与任务书
 * 逐字一致，**禁止可选兜底字段扩展**（保持最小）。后续任务如需扩展，
 * 先改本文件并走评审，禁止在实现侧私自加字段。
 */

import type { BridgeConfig } from "../config";

/** 传输种类：structured = 结构化通道（HTTP/daemon），pty = 伪终端通道（tmux/script 宿主）。 */
export type TransportKind = "structured" | "pty";

/** 会话事件信号：at 为产生时刻（毫秒时间戳或调用序刻度，由实现定义并在其文档注明）。 */
export interface Signal {
  t: "output" | "error" | "idle" | "step" | "done";
  at: number;
  text?: string;
}

/** 会话引用：由 transport.start 返回、后续方法凭其寻址（不透明值，调用方只透传）。 */
export interface SessionRef {
  kind: TransportKind;
  id: string;
}

/**
 * observe 选项（T2-02 扩展，主控裁定 2026-10-31 R-p2）：
 * - signal：取消语义见 observe 注（唯一真相源：立即放弃、残存不交付、不抛错）。
 * - kernelDataDir：内核数据根（日志源 `<dir>/log/kernel-*.log`）经 opts 传参
 *   （与 T1-06 R-h3 / T1-07 R-h5 同风格，**不扩展 BridgeConfig**）；缺省由实现
 *   自定（script 宿主默认 ~/.codeartsdoer/cli-data）。仅真实传输消费；日志源
 *   不可用不报错，来源可用性在 snapshot.meta 如实标注（R-p2）。
 */
export interface ObserveOptions {
  signal?: AbortSignal;
  kernelDataDir?: string;
}

/** 目标会话传输接口（最小完整，六方法）。 */
export interface CodeartsTransport {
  /** 本传输的种类（构造即定；SessionRef.kind 与之一致）。 */
  readonly kind: TransportKind;

  /**
   * 启动（或复用）一个目标会话。ref 缺省创建新会话；传入 start 返回过的 ref
   * 表示复用/恢复该会话（语义由实现定义并注明）。
   */
  start(cfg: BridgeConfig, ref?: SessionRef): Promise<SessionRef>;

  /** 向会话注入一段文本（如续跑指令）。 */
  inject(ref: SessionRef, text: string): Promise<void>;

  /**
   * 观察会话事件流。opts.signal abort → 迭代正常结束（不抛错，R-tr2）。
   * abort 语义（本文件为唯一真相源）：**立即放弃**——残存未消费信号丢弃、
   * 不 flush；真实传输（T2-02~04）须对齐该状态机行为（T3-03 经 FakeTransport
   * 验证的行为以此为基准）。
   * 并发观察策略由实现定义（FakeTransport 为单观察者，重复 observe 显式报错）。
   */
  observe(ref: SessionRef, opts?: ObserveOptions): AsyncIterable<Signal>;

  /** 会话是否存活。 */
  alive(ref: SessionRef): Promise<boolean>;

  /** 停止会话；对已停止会话幂等。 */
  stop(ref: SessionRef): Promise<void>;

  /** 会话当前状态快照（raw 语义由实现定义并注明）。 */
  snapshot(ref: SessionRef): Promise<{ raw: string; meta: Record<string, unknown> }>;
}
