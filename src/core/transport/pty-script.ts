/**
 * codearts-bridge script(1) PTY 宿主（T2-02）。
 *
 * 职责：CodeartsTransport 的第一个真实传输——经 util-linux script(1) 为目标
 * TUI 提供真实 PTY（无 tmux 环境的零依赖宿主；tmux 宿主见 T2-03）。
 * 契约唯一真相源为 types.ts；本文件实现其全部六方法，并对齐 T2-01
 * FakeTransport 的可观测语义（T3-03 监督状态机以此为可迁移基准）。
 *
 * 主控裁定对照（2026-10-31，逐条落实）：
 * - R-p1 两段式注入：inject = write(text) → 可注入时钟等待 120ms →
 *   write("\r") 单独提交（v0.2.6 教训：文本+回车同块会被粘贴识别吞掉）。
 *   文本含 \r/\n 显式抛 INJECT_TEXT_MULTILINE（与两段式契约冲突，禁静默截断）。
 * - R-p2 日志信号源：observe 额外 tail `<kernelDataDir>/log/kernel-*.log`
 *   增量（kernelDataDir 经 ObserveOptions 传参，缺省 ~/.codeartsdoer/cli-data，
 *   不扩展 BridgeConfig——与 R-h3/R-h5 同风格）；`service=` 行转为 output
 *   信号补充。日志源不可用（目录/文件缺失、读取错误）**一律不报错、不影响
 *   PTY 通道**，来源可用性在 snapshot.meta.log 如实标注（本裁定显式豁免
 *   "禁静默兜底"全局约束于日志源；PTY 侧错误仍显式抛出）。
 * - R-p3 abort 对齐（T9 基准）：observe 尊重 opts.signal——挂起等待中 abort
 *   迭代立即正常落定、残存信号不交付当前消费者但保留给下一次 observe
 *   （与 FakeTransport 同态）、不 flush、不抛错。
 * - R-p4 进程终止（真实两级机理，探针+family 测试实证；评审 I1 更正）：
 *   ① 组杀：生产 spawnPty 以 detached:true 使 script 进程为新进程组长，
 *   stop 经 process.kill(-pid, SIGKILL) 终止该组——覆盖 script 本体；
 *   ② SIGHUP 级联：script -c 的命令子进程经 setsid 成独立会话，**不在组内**，
 *   子树（目标 TUI 及其后代）的终止依赖 script 死亡后 PTY master 关闭触发的
 *   SIGHUP 级联（探针实测 <300ms 全灭）；③ 残余风险：目标若忽略/捕获 SIGHUP
 *   可能残留（script 宿主固有拓扑）；④ 缓解路径：T2-03 tmux 宿主
 *   （kill-session 原生整树终止）、T2-05 结构化传输（无 PTY 树），后代
 *   /proc 清扫登记为候选项（本轮不实现）。ESRCH 视为终止目标已达成
 *   （stop 幂等语义），其余错误显式抛 PTY_STOP_FAILED。
 * - R-p5 PtyChild 注入：exec.spawnPty(args, env) 注入 seam；生产缺省实现
 *   nodeScriptSpawnPty = `script -qefc <cmd> /dev/null`，参数一律 argv 数组
 *   传递（本实现不做 shell 字符串拼接；script -c 本身为 sh 语义，故对
 *   配置路径做 shQuote 转义——数据源仅限配置路径，非用户文本）。
 * - 修复环裁定①（2026-10-31 修复轮）：PTY 宿主改经官方 wrapper
 *   `<installDir>/codearts` 启动（原 `<installDir>/bin/codearts` bin 直启）。
 *   依据：真机冒烟实证 bin 直启裸传父环境（无 SCENARIO/KERNEL_DATA_DIR 等内核
 *   env）→ TUI 停在交互式授权门（"Waiting for authorization..."）；官方
 *   wrapper 设置全量内核 env，是单一环境真相源（与 TUI 桌面快捷方式语义一致）。
 *   wrapper 缺失 → WRAPPER_MISSING（remediation=检查 installers 完整性/重装），
 *   禁静默回退 bin 直启。structured 通道维持 bin 直启（无头 run 子命令 +
 *   AK/SK 前置，无 TUI 授权门，见 structured.ts 同名注释）。
 * - R-p6 UTF-8：PTY 流按 chunk 到达，stdout/stderr 各持独立 StringDecoder，
 *   多字节序列跨 chunk 完整还原（两流独立解码器，交错不破坏字节边界）。
 *
 * 语义裁决（显式报错，禁静默兜底；与 FakeTransport 对齐项注明）：
 * - 未知 ref：全部方法抛 SESSION_UNKNOWN（与 Fake 同）；
 * - 对非存活会话 inject：抛 SESSION_NOT_ALIVE（与 Fake 同）；等待 120ms 提交
 *   窗口期间会话死亡：同样显式抛出，不向死进程写字节；
 * - 同一 ref 并发第二个 observe：抛 OBSERVER_ACTIVE（单观察者模型，与 Fake 同）；
 * - start 带 ref 复用：存活会话幂等返回同 ref；已结束会话抛 SESSION_NOT_ALIVE
 *   （真实 PTY 不可复活，禁静默重建）；
 * - 进程自然退出：observe 产出一次性 done 信号（接口未携带退出码，text 省略）
 *   后迭代正常结束；stop() 终止则不产 done、观察直接终止（与 Fake 同态）；
 * - snapshot.raw = PTY 输出缓冲（全部 chunk 解码按序累积，模拟终端缓冲区，
 *   与是否被 observe 消费无关）；日志源信号不进 raw（raw 仅 PTY 输出）。
 *   meta.log = { available, file, serviceLines }：available = 观察进行中且正在
 *   tail 某 kernel-*.log；file = 当前 tail 的文件名（basename）；serviceLines =
 *   日志源产出的信号累计数（跨观察累计，留痕不丢）。
 * - R-tm5 共享提取（T2-03 起）：日志 tailer/shQuote/lookPath/时钟类型已提取至
 *   shared.ts（唯一真相源），本文件 import 复用并 re-export shQuote/PtyClock
 *   保持既有导入面不变；行为与测试零改动。观察循环骨架（本文件与 pty-tmux
 *   各自实现）因生产/探测机制差异不做提取（见 shared.ts 头注）。
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { armLogTailer, lookPath, shQuote, type PtyClock } from "./shared";
import type { BridgeConfig } from "../config";
import { BridgeError } from "../errors";
import type {
  CodeartsTransport,
  ObserveOptions,
  SessionRef,
  Signal,
  TransportKind,
} from "./types";

/** 两段式注入的提交间隔毫秒（R-p1；v0.2.6 教训值）。 */
const INJECT_COMMIT_DELAY_MS = 120;

/** 观察空闲轮询周期毫秒：进程死亡检测（接口无 onExit，仅 alive() 可查）与日志 tail 兜底。 */
const POLL_MS = 200;



/** 可注入时钟（R-p1）：类型真相源在 shared.ts（R-tm5 提取），此处 re-export 保持导入面。 */
export type { PtyClock };

const defaultClock: PtyClock = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** sh 单引号转义（真相源 shared.ts，R-tm5 提取；re-export 保持既有导入面——
 *  transport-script.test.ts 从本文件导入 shQuote）。 */
export { shQuote };

/** PTY 子进程句柄（R-p5 注入 seam；实现方保证 onData 单播、write 同步入队）。 */
export interface PtyChild {
  pid: number;
  onData(cb: (chunk: string) => void): void;
  write(data: string): void;
  kill(): void;
  alive(): boolean;
}

/* ───── 生产缺省 PtyChild 实现（node child_process + script(1)） ───── */


/**
 * 生产缺省 spawnPty：spawn args[0]（detached，子进程为进程组长），stdio 三管道。
 * - 可执行文件缺失：同步抛 PTY_HOST_UNAVAILABLE（无竞态，先探测后 spawn）；
 * - R-p6：stdout/stderr 各持独立 StringDecoder，多字节跨 chunk 完整还原；
 * - R-p4：kill = process.kill(-pid, SIGKILL) 组杀（覆盖 script 本体；子树靠
 *   master 关闭 SIGHUP 级联，两级机理见文件头 R-p4）；ESRCH = 已死（幂等）。
 */
export function nodeScriptSpawnPty(args: string[], env: NodeJS.ProcessEnv): PtyChild {
  const exe = args[0];
  if (exe === undefined || exe === "") {
    throw new BridgeError("PTY_HOST_UNAVAILABLE", "spawnPty 参数缺少可执行文件名", {
      remediation: "检查 ptyHost=script 的传输装配参数。",
    });
  }
  const resolved = lookPath(exe, env);
  if (resolved === null) {
    throw new BridgeError("PTY_HOST_UNAVAILABLE", `PATH 上未找到可执行文件：${exe}`, {
      remediation: "安装 util-linux（提供 script(1)），或将 ptyHost 配置为 tmux。",
    });
  }
  const child = spawn(resolved, args.slice(1), {
    detached: true, // R-p4：script 为新进程组长，供 kill(-pid) 组杀（子树终止靠 SIGHUP 级联，见文件头 R-p4）
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.pid === undefined) {
    throw new BridgeError("PTY_SPAWN_FAILED", `进程 spawn 失败：${exe}`);
  }
  const pid: number = child.pid; // 收窄捕获（闭包内 child.pid 类型为 number|undefined）

  let exited = false;
  const decOut = new StringDecoder("utf8"); // R-p6：每流独立解码器
  const decErr = new StringDecoder("utf8");
  let sink: ((chunk: string) => void) | null = null;

  child.stdout?.on("data", (b: Buffer) => {
    const s = decOut.write(b);
    if (s !== "" && sink !== null) sink(s);
  });
  child.stderr?.on("data", (b: Buffer) => {
    const s = decErr.write(b);
    if (s !== "" && sink !== null) sink(s);
  });
  child.on("exit", () => {
    exited = true;
  });
  // 流错误（典型：写端 EPIPE）= 底层进程已死：alive() 如实转 false（显式状态，
  // 非兜底——不改变错误向调用方的呈现，inject 等入口仍会显式报 SESSION_NOT_ALIVE）。
  const markDead = (): void => {
    exited = true;
  };
  child.stdin?.on("error", markDead);
  child.stdout?.on("error", markDead);
  child.stderr?.on("error", markDead);
  child.on("error", markDead);

  return {
    pid,
    onData(cb) {
      sink = cb;
    },
    write(data) {
      child.stdin?.write(data);
    },
    kill() {
      if (exited) return;
      try {
        // R-p4 第一级：负 pid = SIGKILL script 进程组（覆盖 script 本体）。
        // 子树（目标 TUI）不在组内（script -c 子进程 setsid 独立会话）——
        // script 死亡 → PTY master 关闭 → SIGHUP 级联终止子树（第二级）；
        // 完整两级机理与残余风险见文件头 R-p4。
        process.kill(-pid, "SIGKILL");
      } catch (e) {
        const code = (e as NodeJS.ErrnoException | null)?.code;
        if (code !== "ESRCH") {
          throw new BridgeError(
            "PTY_STOP_FAILED",
            `进程组终止失败：pid=${pid} errno=${code ?? String(e)}`,
            { cause: e },
          );
        }
        // ESRCH：进程组已不存在——终止目标已达成（stop 幂等），非静默兜底
      }
    },
    alive() {
      return !exited;
    },
  };
}

/* ───── 会话状态与日志 tailer ───── */

/** 单个 script PTY 会话的全部可变状态（经 ref.id 寻址）。 */
interface PtySession {
  ref: SessionRef;
  child: PtyChild;
  /** PTY 输出缓冲：全部 chunk 解码按序累积（snapshot.raw，与消费无关）。 */
  raw: string;
  /** 待消费信号队列（PTY chunk / 日志 service 行 / done）。 */
  queue: Signal[];
  /** observe 挂起等待者（wakeAll 唤醒后自旋复查状态）。 */
  waiters: Array<() => void>;
  /** 当前活跃观察者标记（单观察者模型；null = 无）。 */
  observer: symbol | null;
  /** stop 置位：观察迭代终止条件之一。 */
  closed: boolean;
  /** 进程死亡 done 信号是否已产出（只产一次）。 */
  exitHandled: boolean;
  /** 日志源状态（snapshot.meta.log；观察期间由 tailer 维护，serviceLines 跨观察累计）。 */
  log: { available: boolean; file: string | null; serviceLines: number };
}


/** 会话唤醒/等待机制（模块级：PTY 观察循环与日志 tailer 共用）。 */
function wakeAll(s: PtySession): void {
  const waiters = s.waiters.splice(0);
  for (const wake of waiters) wake();
}

function waitFor(s: PtySession): Promise<void> {
  return new Promise((resolve) => {
    s.waiters.push(resolve);
  });
}


/**

/* ───── script(1) 传输 ───── */

/** createScriptTransport 选项。 */
export interface ScriptTransportOptions {
  /** 注入时钟（R-p1 缺省 setTimeoutPromise）；观察轮询 tick 同用此时钟。 */
  clock?: PtyClock;
}

/**
 * 构造 script(1) PTY 宿主传输。
 * @param exec PtyChild 注入 seam（R-p5）：生产传 { spawnPty: nodeScriptSpawnPty }；
 *   测试可注入 fake child 或经 nodeScriptSpawnPty 真实 spawn bash fixture。
 */
export function createScriptTransport(
  exec: { spawnPty(args: string[], env: NodeJS.ProcessEnv): PtyChild },
  opts: ScriptTransportOptions = {},
): CodeartsTransport {
  const clock = opts.clock ?? defaultClock;
  const kind: TransportKind = "pty";
  /** 会话表：id → 状态（含已 stop 会话：snapshot/留痕不丢）。 */
  const sessions = new Map<string, PtySession>();
  let idNext = 0;

  function requireSession(ref: SessionRef): PtySession {
    const s = sessions.get(ref.id);
    if (s === undefined) {
      throw new BridgeError("SESSION_UNKNOWN", `未知会话引用：kind=${ref.kind} id=${ref.id}`, {
        remediation: "仅可使用本 transport.start 返回过的 SessionRef。",
      });
    }
    return s;
  }

  function assertInjectable(s: PtySession, ref: SessionRef): void {
    if (s.closed || !s.child.alive()) {
      throw new BridgeError(
        "SESSION_NOT_ALIVE",
        `会话已结束，拒绝操作：id=${ref.id}`,
        {
          remediation: "script 宿主会话不可复活；请新建会话（start 不带 ref）。",
        },
      );
    }
  }

  const transport: CodeartsTransport = {
    kind,

    async start(cfg: BridgeConfig, ref?: SessionRef): Promise<SessionRef> {
      if (ref !== undefined) {
        const s = requireSession(ref);
        assertInjectable(s, ref);
        return { ...s.ref }; // 复用语义：存活会话幂等返回（真实 PTY 无恢复概念）
      }
      const id = `script-${++idNext}`;
      const created: SessionRef = { kind, id };
      // 修复环裁定①（2026-10-31）：PTY 宿主一律经官方 wrapper <installDir>/codearts
      // 启动——wrapper 设置全量内核 env（SCENARIO/KERNEL_DATA_DIR/OPENCODE_* 等，
      // 单一环境真相源，与 TUI 桌面快捷方式语义一致）；bin 直启裸传父环境会使
      // TUI 停在交互式授权门（真机冒烟实证）。wrapper 缺失显式报错，禁静默回退
      // bin 直启（回退即掩盖部署缺陷，与全局"禁静默兜底"约束同源）。
      const wrapper = path.join(cfg.installDir, "codearts");
      if (!existsSync(wrapper)) {
        throw new BridgeError("WRAPPER_MISSING", `官方启动 wrapper 缺失：${wrapper}`, {
          remediation:
            "installers 目录不完整（应含 codearts 启动脚本）。检查安装目录完整性，或重新执行官方安装/升级恢复（codearts_upgrade）。",
        });
      }
      const cmd = shQuote(wrapper);
      // R-p5：argv 数组传递，无 shell 字符串拼接；-c 命令串经 shQuote 转义
      const child = exec.spawnPty(["script", "-qefc", cmd, "/dev/null"], process.env);
      const s: PtySession = {
        ref: created,
        child,
        raw: "",
        queue: [],
        waiters: [],
        observer: null,
        closed: false,
        exitHandled: false,
        log: { available: false, file: null, serviceLines: 0 },
      };
      // onData 单播：start 时接线一次，输出持续入 raw + 队列（与是否观察无关）
      child.onData((chunk) => {
        s.raw += chunk;
        s.queue.push({ t: "output", at: Date.now(), text: chunk });
        wakeAll(s);
      });
      sessions.set(id, s);
      return { ...created };
    },

    async inject(ref: SessionRef, text: string): Promise<void> {
      const s = requireSession(ref);
      assertInjectable(s, ref);
      if (text.includes("\r") || text.includes("\n")) {
        throw new BridgeError(
          "INJECT_TEXT_MULTILINE",
          `注入文本含换行符（长度=${text.length}），与两段式提交契约冲突`,
          { remediation: "单行文本注入；多行内容分行多次 inject，每段单独提交。" },
        );
      }
      s.child.write(text);
      await clock(INJECT_COMMIT_DELAY_MS); // R-p1：两段式提交窗口
      assertInjectable(s, ref); // 窗口期死亡：显式报错，不向死进程写 "\r"
      s.child.write("\r");
    },

    observe(ref: SessionRef, observeOpts?: ObserveOptions): AsyncIterable<Signal> {
      const s = requireSession(ref);
      if (s.observer !== null) {
        throw new BridgeError("OBSERVER_ACTIVE", `会话已有活跃观察者（单观察者模型）：id=${ref.id}`, {
          remediation: "先结束当前观察（迭代完成/return/abort）再重新 observe。",
        });
      }
      if (observeOpts?.signal?.aborted) return emptySignals(); // 未开始即取消

      const token = Symbol("observer");
      s.observer = token;
      // tailer 同步装配（statSync 基线在返回前确定——增量语义的确定性关键）
      const tailer = armLogTailer(s, observeOpts?.kernelDataDir, () => wakeAll(s));
      const signal = observeOpts?.signal;
      let terminated = false;
      const release = (): void => {
        if (s.observer === token) s.observer = null;
        tailer.close();
      };

      async function* iterate(): AsyncGenerator<Signal> {
        const onAbort = (): void => wakeAll(s);
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          while (true) {
            // abort = 立即放弃：残存不交付、保留给下一次 observe（T9 基准同态）
            if (signal?.aborted || terminated) return;
            if (s.queue.length > 0) {
              yield s.queue.shift() as Signal;
              continue;
            }
            if (s.closed) return; // stop：观察直接终止（不产 done，与 Fake 同态）
            if (!s.child.alive()) {
              if (!s.exitHandled) {
                s.exitHandled = true;
                s.queue.push({ t: "done", at: Date.now() }); // 进程自然退出：一次性 done
                continue;
              }
              return;
            }
            const tick = clock(POLL_MS).then(() => {
              void tailer.poll(); // 日志 tail 兜底（事件丢失/未就绪窗口）
            });
            await Promise.race([waitFor(s), tick]);
          }
        } finally {
          signal?.removeEventListener("abort", onAbort);
          release();
        }
      }

      // 包装迭代器（与 FakeTransport M34 同构）：显式 return/throw 先同步终结
      // 挂起等待并释放观察者/关闭 tailer，再委托内部 generator——"未启动即
      // return"（generator 体未执行、finally 不触发）也不泄漏 watcher。
      const inner = iterate();
      const iterator: AsyncIterator<Signal> = {
        next: () => inner.next(),
        return: (v?: unknown) => {
          terminated = true;
          release();
          wakeAll(s);
          return inner.return(v as undefined);
        },
        throw: (e?: unknown) => {
          terminated = true;
          release();
          wakeAll(s);
          return inner.throw(e);
        },
      };
      return { [Symbol.asyncIterator]: () => iterator };
    },

    async alive(ref: SessionRef): Promise<boolean> {
      const s = requireSession(ref);
      return !s.closed && s.child.alive();
    },

    async stop(ref: SessionRef): Promise<void> {
      const s = requireSession(ref);
      if (!s.closed) {
        s.closed = true;
        if (s.child.alive()) s.child.kill(); // R-p4：组杀 + SIGHUP 级联两级终止（机理见文件头 R-p4）
      }
      wakeAll(s);
    },

    async snapshot(ref: SessionRef): Promise<{ raw: string; meta: Record<string, unknown> }> {
      const s = requireSession(ref);
      return {
        raw: s.raw,
        meta: {
          id: s.ref.id,
          kind: s.ref.kind,
          host: "script",
          pid: s.child.pid,
          alive: !s.closed && s.child.alive(),
          closed: s.closed,
          log: { ...s.log },
        },
      };
    },
  };

  return transport;
}

/** 空信号迭代（observe 收到已 abort 的 signal 时返回；不占观察者、不装配 tailer）。 */
function emptySignals(): AsyncIterable<Signal> {
  return (async function* () {})();
}
