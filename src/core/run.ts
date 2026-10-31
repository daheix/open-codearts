/**
 * codearts_run 编排核心（T2-05）：传输选择 + 单轮运行 + 进度/取消 + 审计。
 *
 * 职责边界：server.ts 的 codearts_run 工具是薄编排（参数归一 → 本模块 → 结构化
 * 返回）；传输选择、会话生命期、超时/取消语义、审计写盘的业务判断全部在本文件。
 *
 * 主控裁定落点（2026-10-31，逐条）：
 * - R-cr1（auto 传输选择显式）：selectTransport 纯函数——cfg.transport=auto 时
 *   structured 当且仅当 readAksk 有凭据（AK/SK 齐备非空）；否则 pty（ptyHost
 *   显式 tmux/script 直接采用；auto 经 tmux 可用性探测二选一）。显式 transport
 *   值优先。结果必含 {mode, reason}（无静默切换）；探测输入（hasAksk/
 *   tmuxAvailable）由 runOnce 异步解析后传入，选择逻辑本身保持纯函数可测。
 * - R-cr2（超时语义）：timeoutMs 到 → delay 定时触发 → ctrl.abort() → 观察循环
 *   终止 → transport.stop() + 返回结构化超时结果（status="timeout"，含已捕获
 *   输出摘要）。非静默、非错误——调用方可见"超时中断"事实。
 * - R-cr3（进度与取消）：progress 在注入后至少更新一次；其后按信号批次 + 2s
 *   节流更新（clock 注入，测试确定性）；context.signal abort → 停止观察并
 *   transport.stop()（对齐 types.ts T9 abort 语义：立即放弃、残存不交付）。
 * - R-cr4（审计）：run.start / run.exit 成对写 audit/install.jsonl（经
 *   appendInstallAudit），含 mode/reason/session/prompt 摘要/结果摘要；prompt
 *   全文不入审计——只记长度与前 80 字符。run.start 审计失败 → 停止会话并显式
 *   报错（禁止无审计的运行）；run.exit 审计失败不掩盖运行结果（R-t1 同纪律，
 *   run.start 已留痕，部署级写故障由 health/审计监控暴露）。
 * - 错误路径（任务书 Step1）：error 信号经 classifyError 分级，任一 retryable
 *   → 结果 retryable=true 并附摘要；**不静默重试**——重试属目标引擎（T3 监督
 *   状态机）职责。transport 抛出的 BridgeError 原样上抛（工具层 R-t1 转
 *   结构化 content），run.exit 审计以 status="error" 留痕。
 *
 * 修复环第 1 轮（2026-10-31，主控裁定/I-M48/I-M50）：
 * - M48 预 abort 短路：start/审计完成后 ctrl.signal 已 aborted → inject 零调用
 *   （已取消的 prompt 不写入目标会话），照常 stop + cancelled 结果。
 * - M50 error 路径审计对齐：run.exit(status="error") 补 outputBytes/summary/
 *   retryable，与成功路径 schema 一致（审计消费方单一 schema）。
 *
 * 终态语义（status 四值，均为结构化结果非错误）：
 * - "completed"：观察到 done 信号（PTY 宿主进程退出 / structured 回合 exit=0）；
 * - "timeout"：timeoutMs 到（R-cr2，已 stop）；
 * - "cancelled"：宿主 signal abort（R-cr3，已 stop）；
 * - "ended"：事件流结束但无 done、无超时、无取消（如 structured 回合失败退出
 *   ——R-s4 错误回合不宣告会话死亡，会话保活可续接；错误事实在 errors/summary）。
 * 优先级：completed > timeout > cancelled > ended（done 是最强完成事实）。
 * 超时/取消/错误路径必 stop；completed/ended 不 stop（structured 会话保活供
 * 续接；PTY 宿主 done 即进程已退，stop 幂等无意义）。
 */

import { randomUUID } from "node:crypto";
import type { BridgeConfig } from "./config";
import { readAksk } from "./config";
import { BridgeError } from "./errors";
import { appendInstallAudit } from "./install";
import { createScriptTransport, nodeScriptSpawnPty } from "./transport/pty-script";
import { createTmuxTransport, nodeTmuxExec } from "./transport/pty-tmux";
import { classifyError, createStructuredTransport, nodeRunSpawnProc } from "./transport/structured";
import type { CodeartsTransport, ObserveOptions, SessionRef } from "./transport/types";

/* ───── 常量（口径唯一真相源，测试钉死） ───── */

/** 缺省超时（毫秒）：M2 真机冒烟口径 ≤120s 的上限同源。 */
export const RUN_DEFAULT_TIMEOUT_MS = 120_000;

/** 捕获输出摘要上限（字符数；超出取尾部并加省略号前缀）。 */
export const RUN_SUMMARY_MAX_CHARS = 500;

/** 进度节流窗口（毫秒；R-cr3"每 2s 或每信号批次"）。 */
export const RUN_PROGRESS_THROTTLE_MS = 2_000;

/** 审计中 prompt 预览长度（字符数；R-cr4"只记长度与前 80 字符"）。 */
export const RUN_PROMPT_PREVIEW_CHARS = 80;

/* ───── R-cr1：传输选择（纯函数） ───── */

/** 实际使用的传输模式（pty 细分宿主）。 */
export type RunTransportMode = "structured" | "pty-tmux" | "pty-script";

/** 传输选择结果：mode + 人类可读原因（无静默切换）。 */
export interface TransportSelection {
  mode: RunTransportMode;
  reason: string;
}

/** selectTransport 输入（异步探测解析后的纯数据）。 */
export interface SelectTransportInput {
  transport: BridgeConfig["transport"];
  ptyHost: BridgeConfig["ptyHost"];
  /** AK/SK 凭据齐备（AK 与 SK 均非空）。 */
  hasAksk: boolean;
  /** tmux 可用（仅 ptyHost=auto 时被消费）。 */
  tmuxAvailable: boolean;
}

/** pty 宿主解析（显式优先；auto 看 tmux 探测）。 */
function selectPtyHost(ptyHost: BridgeConfig["ptyHost"], tmuxAvailable: boolean, prefix: string): TransportSelection {
  if (ptyHost === "tmux") return { mode: "pty-tmux", reason: `${prefix}；ptyHost=tmux（显式）` };
  if (ptyHost === "script") return { mode: "pty-script", reason: `${prefix}；ptyHost=script（显式）` };
  return tmuxAvailable
    ? { mode: "pty-tmux", reason: `${prefix}；ptyHost=auto：tmux 可用 → tmux` }
    : { mode: "pty-script", reason: `${prefix}；ptyHost=auto：tmux 不可用 → script` };
}

/**
 * R-cr1 传输选择（纯函数，禁 I/O）：
 * - 显式 transport=structured / pty 直接采用（显式值优先）；
 * - auto：有凭据 → structured；否则 pty（宿主按 ptyHost 解析）。
 */
export function selectTransport(input: SelectTransportInput): TransportSelection {
  if (input.transport === "structured") {
    return { mode: "structured", reason: "配置 transport=structured（显式）" };
  }
  if (input.transport === "pty") {
    return selectPtyHost(input.ptyHost, input.tmuxAvailable, "配置 transport=pty（显式）");
  }
  if (input.hasAksk) {
    return { mode: "structured", reason: "auto：检测到 AK/SK 凭据 → structured" };
  }
  return selectPtyHost(input.ptyHost, input.tmuxAvailable, "auto：未检测到 AK/SK 凭据 → pty");
}

/**
 * 是否需要 tmux 可用性探测（避免无谓 spawn：仅 ptyHost=auto 且决策可能落到 pty 时）。
 * T3-07 起导出：daemon 生产装配（cli.ts resolveProductionTransport）与 runOnce
 * 共用同一探测条件，杜绝第二套选择真相源（M78 双份同码教训）。
 */
export function needsTmuxProbe(transport: BridgeConfig["transport"], ptyHost: BridgeConfig["ptyHost"], hasAksk: boolean): boolean {
  if (ptyHost !== "auto") return false;
  if (transport === "pty") return true;
  return transport === "auto" && !hasAksk;
}

/* ───── 生产装配（传输工厂 / tmux 探测 / 时钟） ───── */

/** 生产传输工厂：按选择结果构造对应真实传输（注入 seam 供测试替换）。 */
export function defaultBuildTransport(sel: TransportSelection): CodeartsTransport {
  switch (sel.mode) {
    case "structured":
      return createStructuredTransport({ spawnProc: nodeRunSpawnProc });
    case "pty-tmux":
      return createTmuxTransport(nodeTmuxExec());
    case "pty-script":
      return createScriptTransport({ spawnPty: nodeScriptSpawnPty });
  }
}

/**
 * 生产 tmux 可用性探测：`tmux -V` 退出码 0 → 可用；PTY_HOST_UNAVAILABLE
 * （PATH 无 tmux / 探测失败）→ 不可用（显式事实，选择 reason 留痕）；其余
 * 错误原样上抛（禁静默吞错）。
 */
export async function probeTmuxAvailable(): Promise<boolean> {
  try {
    await nodeTmuxExec().run(["-V"]);
    return true;
  } catch (e) {
    if (e instanceof BridgeError && e.code === "PTY_HOST_UNAVAILABLE") return false;
    throw e;
  }
}

/** 可注入时钟（now + 可取消 delay；测试用 FakeClock 确定性驱动）。 */
export interface RunClock {
  now(): number;
  /** 可取消延时：cancel 后 promise 永不再触发回调（防事件循环悬挂/迟到触发）。 */
  delay(ms: number): { promise: Promise<void>; cancel(): void };
}

/** 生产时钟：Date.now + setTimeout/clearTimeout。 */
export const defaultRunClock: RunClock = {
  now: () => Date.now(),
  delay(ms: number) {
    let handle: ReturnType<typeof setTimeout> | undefined;
    const promise = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, ms);
    });
    return {
      promise,
      cancel: () => {
        if (handle !== undefined) clearTimeout(handle);
        handle = undefined;
      },
    };
  },
};

/* ───── runOnce：单轮运行编排 ───── */

/** runOnce 输入（cfg 必带；其余缺省见各字段注）。 */
export interface RunOnceInput {
  /** 全局配置（transport/ptyHost/akskFile/stateDir 由 selectTransport 与审计消费）。 */
  cfg: BridgeConfig;
  /** 注入会话的 prompt（非空；空串显式报错）。 */
  prompt: string;
  /** 续接的会话引用（缺省新建会话）。 */
  session?: SessionRef;
  /** 超时毫秒（正整数；缺省 RUN_DEFAULT_TIMEOUT_MS）。 */
  timeoutMs?: number;
  /** 宿主进度通道（R-cr3；缺省=无进度通道，如实跳过——非宿主调用场景）。 */
  progress?: (update: { status: string }) => unknown;
  /** 宿主取消信号（R-cr3；缺省=不可取消，超时仍兜底运行上限——显式文档）。 */
  signal?: AbortSignal;
  /** tmux 探测（缺省 probeTmuxAvailable；测试注入确定性结果）。 */
  tmuxProbe?: () => Promise<boolean>;
  /** 传输工厂（缺省 defaultBuildTransport；测试注入 FakeTransport）。 */
  buildTransport?: (sel: TransportSelection) => CodeartsTransport;
  /** 时钟（缺省 defaultRunClock；测试注入 FakeClock）。 */
  clock?: RunClock;
  /** 内核数据目录（R-p2 传参口径；仅真实 PTY 传输的日志源消费）。 */
  kernelDataDir?: string;
}

/** runOnce 结构化结果（契约字段：session/summary/signals/mode/reason/auditId）。 */
export interface RunResult {
  status: "completed" | "timeout" | "cancelled" | "ended";
  /** 会话引用（structured/pty 会话可供续接——timeout/cancelled 路径已 stop 除外）。 */
  session: SessionRef;
  mode: RunTransportMode;
  /** 传输选择原因（R-cr1 无静默切换）。 */
  reason: string;
  /** 观察到的信号总数（含 done）。 */
  signals: number;
  /** error 信号数。 */
  errors: number;
  /** 任一 error 信号被 classifyError 判为 retryable（不静默重试的显式标记）。 */
  retryable: boolean;
  /** 已捕获输出摘要（output+error 文本尾部，≤RUN_SUMMARY_MAX_CHARS）。 */
  summary: string;
  /** 捕获文本总字节数（UTF-8）。 */
  outputBytes: number;
  durationMs: number;
  /** 审计 id（run.start/run.exit 成对共用）。 */
  auditId: string;
  /** 进度通道失败次数（>0 才出现——进度通道故障的显式留痕，非静默）。 */
  progressFailures?: number;
}

/** 输入校验（显式报错，禁静默截断/钳位）。 */
function validateInput(prompt: string, timeoutMs: number): void {
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new BridgeError("TOOL_INPUT_INVALID", `prompt 须为非空字符串，实际为 ${typeof prompt}`);
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new BridgeError("TOOL_INPUT_INVALID", `timeoutMs 须为正整数，实际为 ${String(timeoutMs)}`);
  }
}

/**
 * 单轮运行：选择传输 → start → 审计 run.start → 注入 prompt → 观察（进度节流 /
 * 超时 / 取消）→ 审计 run.exit → 结构化结果。传输抛错的 BridgeError 原样上抛
 * （工具层经 R-t1 以结构化 content 返回；run.exit 以 status="error" 留痕）。
 */
export async function runOnce(input: RunOnceInput): Promise<RunResult> {
  const { cfg } = input;
  const timeoutMs = input.timeoutMs ?? RUN_DEFAULT_TIMEOUT_MS;
  validateInput(input.prompt, timeoutMs);

  const clock = input.clock ?? defaultRunClock;
  const buildTransport = input.buildTransport ?? defaultBuildTransport;
  const tmuxProbe = input.tmuxProbe ?? probeTmuxAvailable;

  // R-cr1：先解析选择输入（aksk 读取 + 按需 tmux 探测），再纯函数选择（无静默切换）
  const aksk = await readAksk(cfg.akskFile);
  const hasAksk = aksk !== undefined && aksk.AK !== undefined && aksk.AK !== "" && aksk.SK !== undefined && aksk.SK !== "";
  let tmuxAvailable = false;
  if (needsTmuxProbe(cfg.transport, cfg.ptyHost, hasAksk)) {
    tmuxAvailable = await tmuxProbe();
  }
  const sel = selectTransport({ transport: cfg.transport, ptyHost: cfg.ptyHost, hasAksk, tmuxAvailable });

  const transport = buildTransport(sel);
  const ref = await transport.start(cfg, input.session);

  const startedAt = clock.now();
  const auditId = randomUUID();
  const promptPreview = input.prompt.slice(0, RUN_PROMPT_PREVIEW_CHARS);

  // R-cr4：run.start 先于注入落盘——审计失败则停止会话并显式报错（禁止无审计的运行）
  try {
    await appendInstallAudit(cfg, {
      ts: new Date().toISOString(),
      kind: "run.start",
      auditId,
      mode: sel.mode,
      reason: sel.reason,
      session: ref.id,
      sessionKind: ref.kind,
      promptLength: input.prompt.length,
      promptPreview,
      timeoutMs,
      reused: input.session !== undefined,
    });
  } catch (e) {
    // 清理失败不掩盖审计主错误（会话尚未注入 prompt，停止即干净回滚）
    try {
      await transport.stop(ref);
    } catch {
      // 停止失败仅说明会话残留（无 prompt 注入、无信号流），由 snapshot/下次运行对账
    }
    throw e;
  }

  const external = input.signal;
  const ctrl = new AbortController();
  const onExternalAbort = (): void => ctrl.abort();
  external?.addEventListener("abort", onExternalAbort, { once: true });
  // 已预先 abort 的宿主信号：监听器不会触发，须同步传播（取消语义对"开始前已取消"同样成立）
  if (external?.aborted) ctrl.abort();

  // R-cr2：超时定时——到点 abort（观察循环立即终止）→ finally stop → 结构化超时结果
  let timerCancelled = false;
  let timeoutFired = false;
  const timer = clock.delay(timeoutMs);
  void timer.promise.then(
    () => {
      if (timerCancelled) return;
      timeoutFired = true;
      ctrl.abort();
    },
    () => undefined, // delay 实现不允许 reject；防御性空转（不掩盖任何业务错误）
  );

  const textParts: string[] = [];
  let outputBytes = 0;
  let signalsCount = 0;
  let errorsCount = 0;
  let retryable = false;
  let sawDone = false;
  let progressFailures = 0;
  let lastProgressAt = Number.NEGATIVE_INFINITY;
  let runError: BridgeError | undefined;

  // 捕获摘要（M50：error 路径 run.exit 审计与成功路径 schema 对齐——提前计算）
  const fullText = () => textParts.join("");
  const summarize = (): string => {
    const t = fullText();
    return t.length > RUN_SUMMARY_MAX_CHARS ? `…${t.slice(-RUN_SUMMARY_MAX_CHARS)}` : t;
  };

  // 进度通道失败不中断运行；计数入结果（显式留痕，非静默）
  const reportProgress = async (status: string): Promise<void> => {
    if (input.progress === undefined) return;
    try {
      await input.progress({ status });
    } catch {
      progressFailures++;
    }
  };

  try {
    // M48（修复环裁定）：预 abort 短路——start/审计完成后信号已取消的 prompt
    // 不再写入目标会话（inject 零调用）；取消语义照常经 finally stop + 结构化
    // cancelled 结果返回（非静默：status 如实标记取消事实）。
    if (!ctrl.signal.aborted) {
      await transport.inject(ref, input.prompt);
      lastProgressAt = clock.now();
      await reportProgress(`prompt 已提交（mode=${sel.mode}），等待目标响应`);
      const observeOpts: ObserveOptions = {
        signal: ctrl.signal,
        ...(input.kernelDataDir !== undefined ? { kernelDataDir: input.kernelDataDir } : {}),
      };
      for await (const sig of transport.observe(ref, observeOpts)) {
        signalsCount++;
        if (sig.t === "error" && sig.text !== undefined) {
          errorsCount++;
          // 错误分级（R-s5 classifyError）：retryable → 显式标记；不静默重试
          if (classifyError(sig.text) === "retryable") retryable = true;
        }
        if ((sig.t === "output" || sig.t === "error") && sig.text !== undefined) {
          textParts.push(sig.text);
          outputBytes += Buffer.byteLength(sig.text, "utf8");
        }
        if (sig.t === "done") {
          sawDone = true;
          break;
        }
        // R-cr3：信号批次 + 2s 节流
        const now = clock.now();
        if (now - lastProgressAt >= RUN_PROGRESS_THROTTLE_MS) {
          lastProgressAt = now;
          await reportProgress(`运行中：信号 ${signalsCount} 个（错误 ${errorsCount}）`);
        }
      }
    }
  } catch (e) {
    runError = e instanceof BridgeError ? e : new BridgeError("INTERNAL", String(e), { cause: e });
  } finally {
    timerCancelled = true;
    timer.cancel();
    external?.removeEventListener("abort", onExternalAbort);
    // R-cr2/R-cr3/错误路径：超时、取消、异常必 stop（显式清理）；
    // completed/ended 不 stop（structured 会话保活供续接；PTY done 即进程已退）
    if (timeoutFired || (external?.aborted ?? false) || runError !== undefined) {
      try {
        await transport.stop(ref);
      } catch {
        // 停止失败不掩盖主结果（会话残留由 snapshot/下次运行对账；stop 均幂等）
      }
    }
  }

  if (runError !== undefined) {
    // R-cr4：异常路径 run.exit 以 status="error" 留痕（尽力而为，不掩盖上抛错误）。
    // M50（修复环裁定）：补 outputBytes/summary——与成功路径 schema 对齐，
    // error 留痕同样承载已捕获输出的事实（审计消费方单一 schema）。
    try {
      await appendInstallAudit(cfg, {
        ts: new Date().toISOString(),
        kind: "run.exit",
        auditId,
        mode: sel.mode,
        session: ref.id,
        sessionKind: ref.kind,
        status: "error",
        errorCode: runError.code,
        errorMessage: runError.message,
        signals: signalsCount,
        errors: errorsCount,
        retryable,
        durationMs: clock.now() - startedAt,
        outputBytes,
        summary: summarize(),
      });
    } catch {
      // run.start 已留痕；写失败属部署故障（R-t1 同纪律，不掩盖上抛的业务错误）
    }
    throw runError;
  }

  const summary = summarize();
  const status: RunResult["status"] = sawDone
    ? "completed"
    : timeoutFired
      ? "timeout"
      : (external?.aborted ?? false)
        ? "cancelled"
        : "ended";

  const result: RunResult = {
    status,
    session: { ...ref },
    mode: sel.mode,
    reason: sel.reason,
    signals: signalsCount,
    errors: errorsCount,
    retryable,
    summary,
    outputBytes,
    durationMs: clock.now() - startedAt,
    auditId,
  };
  if (progressFailures > 0) result.progressFailures = progressFailures;

  // R-cr4：run.exit 成对留痕（尽力而为；失败不掩盖运行结果，run.start 已保证落盘）
  try {
    await appendInstallAudit(cfg, {
      ts: new Date().toISOString(),
      kind: "run.exit",
      auditId,
      mode: sel.mode,
      session: ref.id,
      sessionKind: ref.kind,
      status,
      signals: signalsCount,
      errors: errorsCount,
      retryable,
      durationMs: result.durationMs,
      outputBytes,
      summary,
    });
  } catch {
    // 同上：run.start 已留痕；部署级写故障由 codearts_health/审计监控暴露
  }

  return result;
}
