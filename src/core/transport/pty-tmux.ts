/**
 * codearts-bridge tmux PTY 宿主（T2-03）。
 *
 * 职责：CodeartsTransport 的第二个真实传输——经 tmux 客户端命令托管目标 TUI
 * （PTY 首选形态：可 attach 观看、跨守护重启存活；零依赖宿主见 T2-02 script）。
 * 契约唯一真相源为 types.ts；日志信号源共享件见 shared.ts（R-tm5 提取）。
 *
 * 主控裁定对照（2026-10-31，逐条落实）：
 * - R-tm1 探测与错误：每次 start 均执行 `tmux -V` 探测（**非缓存**）；失败 →
 *   BridgeError(PTY_HOST_UNAVAILABLE)，remediation = 安装 tmux 或配置
 *   ptyHost=script；**禁静默切换**到 script。
 * - R-tm2 start 幂等：先 `has-session -t codearts-<slug>`；命中 → 重连（不
 *   重建）；未命中 → `new-session -d -s <target> <installDir>/codearts`
 *   （argv 数组传参，禁 shell 字符串拼接用户数据；命令参数经 shQuote——tmux
 *   将命令参数交 sh 解析，空格路径会被拆词，转义对象仅为配置路径，与 T2-02
 *   R-p5 同源依据）。
 * - 修复环裁定①（2026-10-31 修复轮）：PTY 宿主改经官方 wrapper
 *   `<installDir>/codearts` 启动（原 `<installDir>/bin/codearts` bin 直启）。
 *   依据：真机冒烟实证 bin 直启裸传父环境（无 SCENARIO/KERNEL_DATA_DIR 等内核
 *   env）→ TUI 停在交互式授权门；官方 wrapper 设置全量内核 env，是单一环境
 *   真相源。wrapper 缺失 → WRAPPER_MISSING（仅在需 new-session 时检查；存活
 *   会话重连不消费 wrapper），禁静默回退 bin 直启。structured 维持 bin 直启
 *   （无头 run 子命令 + AK/SK 前置，见 structured.ts 同名注释）。
 * - R-tm3 inject 两段式：`send-keys -t <target> <text>` 与
 *   `send-keys -t <target> Enter` 为两次独立调用且保序；文本段加 `-l`
 *   （字面文本——否则 "C-c"/"F1" 等会被 tmux 解释为键名，Enter 段刻意不加
 *   -l 以发送键）；多行文本合法（修复环裁定② 2026-10-31：契约天然多行，
 *   -l 字面整块发送 + Enter 提交，原 INJECT_TEXT_MULTILINE 拒绝分支已删；
 *   回退开关登记：若真机复验发现 TUI 逐行提前提交致契约截断，回退为注入前
 *   \n→空格 单行扁平化，与 pty-script 同步登记）。
 *   不设 120ms 时延窗口：send-keys 为 tmux 服务器侧原子操作，两次独立调用
 *   的次序由服务器保证（v0.2.6 教训针对的是单块写入被粘贴识别吞回车）。
 * - R-tm4 stop/alive/snapshot：stop=`kill-session -t <target>`（不存在→幂等，
 *   复查 has-session 证实后标记 closed，非字符串匹配 stderr）；alive=
 *   `has-session` 退出码；snapshot=`capture-pane -p -t <target>`（含 meta）。
 *   alive 为**布尔查询**（修复环裁定④ 2026-10-31）：未知/kind 不符 ref 一律
 *   false（不抛错）——守护重启后 reconcile 必经未知 ref 路径，false 使其走
 *   tmux 既有同名重建对账语义而非崩溃（与 pty-script 修复环④同源）。
 * - R-tm5 共享提取：日志 tailer/lookPath/shQuote/时钟类型提取至 shared.ts
 *   （pty-script.ts 同步改为 import，行为与测试零改动）；观察循环骨架因两宿主
 *   探测/生产机制差异不做提取，最小重复并标注来源。
 * - R-tm6 语义对齐：abort=立即放弃（T9 基准，残存信号保留给下一次 observe、
 *   不 flush、不抛错）；observe 尊重 opts.signal；stop 后 observe 终止（不产
 *   done）；日志信号源与 T2-02 同语义（shared.armLogTailer，meta 如实标注）。
 *
 * 设计裁决（实现者决策，供评审）：
 * - 签名：`createTmuxTransport(exec, opts)`——plan 卡写 `(cfg, exec)`，但
 *   types.ts（T2-01 唯一真相源）以 start(cfg) 逐次交付配置；为避免 installDir
 *   双真相源并对齐 T2-02 先例 createScriptTransport(exec, opts)，取 (exec, opts)。
 * - 会话命名 `codearts-<slug>-<hash8(installDir)>`：slug = installDir 基名转写
 *   （非 [a-zA-Z0-9] → '-'，截 24 字符）；hash8 = installDir sha256 前 8 位十六
 *   进制。同 cfg 确定性同名（跨守护重启重连锚点，spec §宿主重启对账），不同
 *   安装目录不碰撞。
 * - ref.id 即 tmux 会话名；tmux 服务器为状态真相。start(ref) **不要求** ref 曾
 *   在本实例注册（跨守护重启后从 state 恢复的 ref 可直接重连/重建，T3-04 对账
 *   依赖此语义）；其余方法仍要求注册（SESSION_UNKNOWN，与 Fake/script 对齐）。
 * - start(ref) 对已亡会话 = 同名重建（spec："tmux 存活则重连；否则重启会话"），
 *   用当前 cfg 的 installDir；重建时显式清空队列与捕获基线（pane 已更换，旧
 *   输出不属新生命期）、复位 closed/doneEmitted，日志计数保留（本传输账目）。
 *   重建时的活跃观察者（如有）按 **stop 语义** 终止（置旧状态对象 closed 并
 *   唤醒——观察循环见 closed 即静默返回，不产 done 信号；与 tmux kill-session
 *   的会话级行为一致：会话消亡则其上一切观察随之终止）。新状态对象以
 *   observer/waiters 干净起步——否则旧观察者结束时只能清到旧对象，新对象上
 *   残留的陈旧观察者标记会令后续 observe(ref) 永远 OBSERVER_ACTIVE（评审
 *   I1）。日志可用性在新旧对象间显式同步：两对象共享同一 log 状态对象且
 *   shared.ts 全部原地变更（见 shared.ts I1 注），旧观察者结束（close→不可用
 *   态）对新对象的 snapshot 立即可见，不产生分叉的陈旧 meta。
 * - observe = 生成器体内轮询 `capture-pane -p`（注入时钟，POLL_MS）：基线在
 *   首轮捕获确定（基线前内容不交付，与日志 tailer statSync 基线同理）；差分
 *   规则：新内容前缀演进 → 交付增量；非前缀演进（TUI 重绘）→ 全量如实转达。
 *   生产者仅在生成器体内运行（与 script 的 onData 独立生产者不同），残存保留
 *   语义由会话队列跨观察持久承担（测试钉死）。pane 捕获在 observe() 返回后
 *   才异步进行（tmux 探测为异步），故存活校验发生在首次 next（显式
 *   SESSION_NOT_ALIVE，与 script 的同步抛错时点差异已注明）。
 * - snapshot.raw = 即时 capture-pane 输出（F1 终审修复波：桥接侧快照按
 *   SESSION_RAW_CAP_BYTES（512KB）尾保留，丢弃量见 meta.rawDroppedBytes——pane
 *   全量仍由 tmux history 自身持有，本封顶只收口桥接侧内存）；会话亡故 →
 *   raw=""（无 pane 可捕获）。
 * - 一次性 done 语义：observe 期间会话外部消亡 → 产一次 done 后迭代结束
 *   （对齐 script 进程自然退出）；本传输 stop() 终止则不产 done（与 Fake 同态）。
 *
 * 语义裁决（显式报错，禁静默兜底；与 Fake/script 对齐项注明）：
 * - 未知 ref（未注册/非法 kind/空 id）：SESSION_UNKNOWN（与 Fake 同）；
 * - 对非存活会话 inject：SESSION_NOT_ALIVE（与 Fake 同）；send-keys 失败时
 *   复查存活——亡 → SESSION_NOT_ALIVE，活 → PTY_INJECT_FAILED（带 stderr）；
 * - 同一 ref 并发第二个 observe：OBSERVER_ACTIVE（单观察者模型，与 Fake 同）；
 * - kill-session 失败且会话仍在：PTY_STOP_FAILED；capture-pane 失败且会话在：
 *   PTY_CAPTURE_FAILED；new-session 失败：PTY_START_FAILED——均显式抛出。
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { BridgeConfig } from "../config";
import { BridgeError } from "../errors";
import { armLogTailer, capRawTail, lookPath, shQuote, type PtyClock } from "./shared";
import type {
  CodeartsTransport,
  ObserveOptions,
  SessionRef,
  Signal,
  TransportKind,
} from "./types";

/** 观察空闲轮询周期毫秒（会话存活探测/capture-pane 差分/日志 tail 兜底）。 */
const POLL_MS = 200;

/** 会话名 slug 段的长度上限（可读性与 tmux 会话名简短的平衡）。 */
const SLUG_MAX = 24;

/** installDir → 确定性 tmux 会话名（设计裁决见文件头"会话命名"）。 */
export function sessionNameFor(installDir: string): string {
  const base = path.basename(installDir);
  const slug =
    base
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "")
      .slice(0, SLUG_MAX) || "main";
  const hash = createHash("sha256").update(installDir, "utf8").digest("hex").slice(0, 8);
  return `codearts-${slug}-${hash}`;
}

/* ───── exec 注入 seam 与生产缺省实现 ───── */

/** 单条 tmux 客户端命令的执行结果（args 不含 "tmux" 本体）。 */
export interface TmuxRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** tmux 命令执行器（注入 seam）：测试注入有状态 fake；生产用 nodeTmuxExec。 */
export interface TmuxExec {
  /** 运行一条 tmux 命令；argv 数组传参，无 shell 字符串拼接。 */
  run(args: string[]): Promise<TmuxRunResult>;
}

/**
 * 生产缺省 TmuxExec：显式 lookPath 探测（先探测后 spawn，无竞态），spawn 收集
 * stdout/stderr（各持独立 StringDecoder，多字节跨 chunk 完整还原，R-p6 同款）。
 * - PATH 上无 tmux：同步抛 PTY_HOST_UNAVAILABLE（R-tm1 同款显式错误）；
 * - spawn 层其他错误：PTY_SPAWN_FAILED；
 * - 退出码：正常退出取 code；被信号杀死取 -1（tmux 客户端命令罕见，如实呈现）；
 * - 不设超时强杀（业务代码禁内嵌超时兜底；tmux 服务器僵死属部署故障，显式暴露）。
 */
export function nodeTmuxExec(env: NodeJS.ProcessEnv = process.env): TmuxExec {
  return {
    async run(args: string[]): Promise<TmuxRunResult> {
      const resolved = lookPath("tmux", env);
      if (resolved === null) {
        throw new BridgeError("PTY_HOST_UNAVAILABLE", "PATH 上未找到 tmux", {
          remediation: "安装 tmux（如 sudo apt install tmux），或配置 ptyHost=script。",
        });
      }
      return await new Promise<TmuxRunResult>((resolve, reject) => {
        const child = spawn(resolved, args, { env, stdio: ["ignore", "pipe", "pipe"] });
        const decOut = new StringDecoder("utf8");
        const decErr = new StringDecoder("utf8");
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (b: Buffer) => {
          stdout += decOut.write(b);
        });
        child.stderr?.on("data", (b: Buffer) => {
          stderr += decErr.write(b);
        });
        child.on("error", (e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") {
            reject(
              new BridgeError("PTY_HOST_UNAVAILABLE", `PATH 上未找到 tmux：${resolved}`, {
                remediation: "安装 tmux（如 sudo apt install tmux），或配置 ptyHost=script。",
                cause: e,
              }),
            );
            return;
          }
          reject(new BridgeError("PTY_SPAWN_FAILED", `tmux 进程 spawn 失败：${String(e)}`, { cause: e }));
        });
        child.on("close", (code) => {
          resolve({ stdout: stdout + decOut.end(), stderr: stderr + decErr.end(), exitCode: code ?? -1 });
        });
      });
    },
  };
}

/* ───── 会话状态 ───── */

/** 单个 tmux 会话的全部可变状态（经会话名寻址；tmux 服务器为存在性真相）。 */
interface TmuxSession {
  ref: SessionRef;
  /** tmux 会话名（= ref.id）。 */
  target: string;
  /** 待消费信号队列（capture 差分 / 日志 service 行 / done）；跨观察持久（残存保留）。 */
  queue: Signal[];
  /** observe 挂起等待者（wakeAll 唤醒后自旋复查状态）。 */
  waiters: Array<() => void>;
  /** 当前活跃观察者标记（单观察者模型；null = 无）。 */
  observer: symbol | null;
  /** stop 置位：观察迭代终止条件之一（stop 不产 done，与 Fake 同态）。 */
  closed: boolean;
  /** 外部消亡 done 信号是否已产出（只产一次）。 */
  doneEmitted: boolean;
  /** 最近一次 capture-pane 内容（null = 尚无基线；基线轮不产信号）。 */
  lastCapture: string | null;
  /** 日志源状态（snapshot.meta.log；serviceLines 跨观察累计，shared.tailer 维护）。 */
  log: { available: boolean; file: string | null; serviceLines: number };
}

/** 会话唤醒/等待机制（与 pty-script 同构；R-tm5：观察骨架不提取，最小重复）。 */
function wakeAll(s: TmuxSession): void {
  const waiters = s.waiters.splice(0);
  for (const wake of waiters) wake();
}

function waitFor(s: TmuxSession): Promise<void> {
  return new Promise((resolve) => {
    s.waiters.push(resolve);
  });
}

/** 空信号迭代（observe 收到已 abort 的 signal / 已 closed 时返回；不占观察者）。 */
function emptySignals(): AsyncIterable<Signal> {
  return (async function* () {})();
}

/* ───── tmux 传输 ───── */

/** createTmuxTransport 选项。 */
export interface TmuxTransportOptions {
  /** 注入时钟（R-tm6 observe 轮询节奏；缺省真实 setTimeout）。 */
  clock?: PtyClock;
}

/**
 * 构造 tmux PTY 宿主传输。
 * @param exec TmuxExec 注入 seam：生产传 nodeTmuxExec()；测试注入有状态 fake。
 * @param opts 可注入时钟等（见 TmuxTransportOptions）。
 */
export function createTmuxTransport(
  exec: TmuxExec,
  opts: TmuxTransportOptions = {},
): CodeartsTransport {
  const clock = opts.clock ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const kind: TransportKind = "pty";
  /** 会话注册表：会话名 → 状态（轻量账目；存在性真相在 tmux 服务器）。 */
  const sessions = new Map<string, TmuxSession>();

  function requireSession(ref: SessionRef): TmuxSession {
    const s = sessions.get(ref.id);
    if (s === undefined || ref.kind !== kind) {
      throw new BridgeError("SESSION_UNKNOWN", `未知会话引用：kind=${ref.kind} id=${ref.id}`, {
        remediation: "仅可使用本 transport.start 返回过的 SessionRef。",
      });
    }
    return s;
  }

  /** tmux 服务器侧会话存在性（has-session 退出码，R-tm4）。 */
  async function hasSessionName(target: string): Promise<boolean> {
    const r = await exec.run(["has-session", "-t", target]);
    return r.exitCode === 0;
  }

  /** R-tm1：每次 start 均探测（非缓存）；失败显式报错，禁静默切换。 */
  async function probeTmux(): Promise<void> {
    const r = await exec.run(["-V"]);
    if (r.exitCode !== 0) {
      throw new BridgeError(
        "PTY_HOST_UNAVAILABLE",
        `tmux 探测失败（tmux -V 退出码 ${r.exitCode}）：${r.stderr.trim()}`,
        { remediation: "安装 tmux（如 sudo apt install tmux），或配置 ptyHost=script。" },
      );
    }
  }

  /** 断言会话可注入/可观察（存活 = 未 stop 且 tmux 侧存在）。 */
  async function assertAlive(s: TmuxSession, ref: SessionRef): Promise<void> {
    if (s.closed || !(await hasSessionName(s.target))) {
      throw new BridgeError("SESSION_NOT_ALIVE", `会话已结束，拒绝操作：id=${ref.id}`, {
        remediation: "tmux 宿主会话可经 start(ref) 同名重建（对账语义）。",
      });
    }
  }

  /** send-keys 失败的显式归因：复查存活——亡 → NOT_ALIVE；活 → 宿主故障。 */
  async function ensureSent(r: TmuxRunResult, s: TmuxSession, ref: SessionRef): Promise<void> {
    if (r.exitCode === 0) return;
    if (await hasSessionName(s.target)) {
      throw new BridgeError(
        "PTY_INJECT_FAILED",
        `send-keys 失败（退出码 ${r.exitCode}）：${r.stderr.trim()}`,
      );
    }
    throw new BridgeError("SESSION_NOT_ALIVE", `会话已结束，拒绝注入：id=${ref.id}`, {
      remediation: "tmux 宿主会话可经 start(ref) 同名重建（对账语义）。",
    });
  }

  /** capture-pane 差分一轮：基线轮只建基线；前缀演进交增量；重绘交全量。 */
  async function pollCapture(s: TmuxSession): Promise<void> {
    const r = await exec.run(["capture-pane", "-p", "-t", s.target]);
    if (r.exitCode !== 0) {
      throw new BridgeError(
        "PTY_CAPTURE_FAILED",
        `capture-pane 失败（退出码 ${r.exitCode}）：${r.stderr.trim()}`,
      );
    }
    const out = r.stdout;
    const prev = s.lastCapture;
    s.lastCapture = out;
    if (prev === null || out === prev) return;
    const text = out.startsWith(prev) ? out.slice(prev.length) : out;
    s.queue.push({ t: "output", at: Date.now(), text });
    wakeAll(s);
  }

  /** 新建/同名重建后的会话状态（重建保留日志计数，清空 pane 侧痕迹）。 */
  function freshSession(target: string, prev?: TmuxSession): TmuxSession {
    const created: SessionRef = { kind, id: target };
    const s: TmuxSession = {
      ref: created,
      target,
      queue: [],
      // I1：waiters/observer 一律干净起步。重建路径在调用本函数前已对旧对象
      // wakeAll（waiters 全数摘除、旧观察者按 stop 语义终止于旧对象），新对象
      // 继承旧 observer 标记会让旧观察者的收尾清不到它，后续 observe 永远
      // OBSERVER_ACTIVE。log 引用继承保留（与旧对象共享同一状态对象，可用性
      // 经 shared.ts 原地变更在两者间显式同步）。
      waiters: [],
      observer: null,
      closed: false,
      doneEmitted: false,
      lastCapture: null,
      log: prev?.log ?? { available: false, file: null, serviceLines: 0 },
    };
    return s;
  }

  const transport: CodeartsTransport = {
    kind,

    async start(cfg: BridgeConfig, ref?: SessionRef): Promise<SessionRef> {
      // 非法 ref 先本地拒绝（不触碰 tmux）；合法 ref 不要求注册过（跨守护重启：
      // ref 来自 state，由 tmux 服务器验证其存在性）
      if (ref !== undefined && (ref.kind !== kind || ref.id === "")) {
        throw new BridgeError("SESSION_UNKNOWN", `非法会话引用：kind=${ref.kind} id=${ref.id}`, {
          remediation: "仅可使用本 transport.start 返回过的 SessionRef。",
        });
      }
      await probeTmux(); // R-tm1：非缓存，每次 start 均探测
      // start(ref) 不要求注册过（跨守护重启：ref 来自 state，tmux 服务器验证其存在性）
      const target = ref !== undefined ? ref.id : sessionNameFor(cfg.installDir);
      const exists = await hasSessionName(target);
      if (!exists) {
        // 修复环裁定①（2026-10-31）：与 pty-script 同源——PTY 宿主一律经官方
        // wrapper <installDir>/codearts 启动（全量内核 env 单一真相源）；bin 直启
        // 使 TUI 停在交互式授权门（真机冒烟实证）。缺失显式报错，禁静默回退
        // bin 直启。仅在需 new-session（新建/同名重建）时检查——存活会话重连
        // 不消费 wrapper，不受部署目录事后残缺影响。
        const wrapper = path.join(cfg.installDir, "codearts");
        if (!existsSync(wrapper)) {
          throw new BridgeError("WRAPPER_MISSING", `官方启动 wrapper 缺失：${wrapper}`, {
            remediation:
              "installers 目录不完整（应含 codearts 启动脚本）。检查安装目录完整性，或重新执行官方安装/升级恢复（codearts_upgrade）。",
          });
        }
        // R-tm2：new-session argv 数组传参；命令参数经 shQuote（tmux 交 sh 解析）
        const r = await exec.run([
          "new-session",
          "-d",
          "-s",
          target,
          shQuote(wrapper),
        ]);
        if (r.exitCode !== 0) {
          throw new BridgeError(
            "PTY_START_FAILED",
            `new-session 失败（退出码 ${r.exitCode}）：${r.stderr.trim()}`,
            { remediation: "检查 installDir/codearts（官方 wrapper）存在且可执行，以及 tmux 服务器状态。" },
          );
        }
        const prev = sessions.get(target);
        if (prev === undefined) {
          sessions.set(target, freshSession(target));
        } else {
          // 同名重建：pane 已更换——队列/捕获基线显式清空（旧输出不属新生命期，
          // 非静默：文档与测试钉死）；日志计数保留（本传输账目）。
          // I1（评审修复）：重建前先终止旧对象上的活跃观察者——置旧状态对象
          // closed 并唤醒，旧观察循环见 closed 即按 stop 语义静默结束（不产
          // done 信号，与 tmux kill-session 的会话级行为一致：会话消亡则其上
          // 一切观察随之终止）；新对象以 observer/waiters 干净起步（见
          // freshSession），杜绝旧观察者收尾只清旧对象、新对象永久残留陈旧
          // 观察者标记的滞留。
          prev.closed = true;
          wakeAll(prev);
          sessions.set(target, freshSession(target, prev));
        }
      } else if (!sessions.has(target)) {
        // 采纳既有会话（跨守护重启重连）：本实例此前未见，从零建账
        sessions.set(target, freshSession(target));
      }
      return { kind, id: target };
    },

    async inject(ref: SessionRef, text: string): Promise<void> {
      const s = requireSession(ref);
      await assertAlive(s, ref);
      // 修复环裁定②：多行文本合法（目标契约天然多行）——-l 字面整块发送
      // （换行符随字面文本进入 pane），Enter 段独立提交（两段式保序不变）。
      // 回退开关登记：TUI 逐行提前提交致契约截断时回退 \n→空格 扁平化
      // （与 pty-script 同步，见该文件修复环②条目）。
      // R-tm3：两段独立调用且保序；文本段 -l 字面发送，Enter 段发键（见文件头）
      const r1 = await exec.run(["send-keys", "-l", "-t", s.target, text]);
      await ensureSent(r1, s, ref);
      const r2 = await exec.run(["send-keys", "-t", s.target, "Enter"]);
      await ensureSent(r2, s, ref);
    },

    observe(ref: SessionRef, observeOpts?: ObserveOptions): AsyncIterable<Signal> {
      const s = requireSession(ref);
      if (s.observer !== null) {
        throw new BridgeError("OBSERVER_ACTIVE", `会话已有活跃观察者（单观察者模型）：id=${ref.id}`, {
          remediation: "先结束当前观察（迭代完成/return/abort）再重新 observe。",
        });
      }
      if (s.closed) return emptySignals(); // stop 后 observe：立即空迭代（与 Fake 同态）
      if (observeOpts?.signal?.aborted) return emptySignals(); // 未开始即取消

      const token = Symbol("observer");
      s.observer = token;
      // tailer 同步装配（statSync 基线在返回前确定——增量语义的确定性关键，与 script 同）
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
          // tmux 探测为异步：存活校验发生在首次 next（与 script 同步抛错的时点差异见文件头）
          await assertAlive(s, ref);
          while (true) {
            // abort = 立即放弃：残存不交付当前消费者、保留在队列给下一次 observe（T9 基准同态）
            if (signal?.aborted || terminated) return;
            if (s.queue.length > 0) {
              yield s.queue.shift() as Signal;
              continue;
            }
            if (s.closed) return; // stop：观察直接终止（不产 done，与 Fake 同态）
            if (!(await hasSessionName(s.target))) {
              // 外部消亡（非本传输 stop）：一次性 done（对齐 script 进程自然退出）
              if (!s.doneEmitted) {
                s.doneEmitted = true;
                s.queue.push({ t: "done", at: Date.now() });
                continue;
              }
              return;
            }
            await pollCapture(s); // capture-pane 差分 → 队列（基线轮不产信号）
            if (s.queue.length > 0) continue;
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

      // 包装迭代器（与 pty-script/FakeTransport M34 同构，来源标注）：显式
      // return/throw 先同步终结挂起等待并释放观察者/关闭 tailer，再委托内部
      // generator——"未启动即 return"（generator 体未执行、finally 不触发）
      // 也不泄漏 watcher。
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
      // 修复环裁定④：布尔查询——未知 / kind 不符 ref → false（不抛错）。
      if (ref.kind !== kind || !sessions.has(ref.id)) return false;
      const s = sessions.get(ref.id) as TmuxSession;
      if (s.closed) return false;
      return hasSessionName(s.target); // R-tm4：alive = has-session 退出码
    },

    async stop(ref: SessionRef): Promise<void> {
      const s = requireSession(ref);
      if (s.closed) return; // 幂等：不再 kill-session
      const r = await exec.run(["kill-session", "-t", s.target]); // R-tm4
      if (r.exitCode !== 0 && (await hasSessionName(s.target))) {
        // 会话仍在而 kill-session 失败：宿主故障，显式抛出（不存在 → 幂等达成）
        throw new BridgeError(
          "PTY_STOP_FAILED",
          `kill-session 失败（退出码 ${r.exitCode}）：${r.stderr.trim()}`,
        );
      }
      s.closed = true;
      wakeAll(s);
    },

    async snapshot(ref: SessionRef): Promise<{ raw: string; meta: Record<string, unknown> }> {
      const s = requireSession(ref);
      const alive = !s.closed && (await hasSessionName(s.target));
      let raw = "";
      let rawDroppedBytes = 0;
      if (alive) {
        const r = await exec.run(["capture-pane", "-p", "-t", s.target]); // R-tm4
        if (r.exitCode !== 0) {
          throw new BridgeError(
            "PTY_CAPTURE_FAILED",
            `capture-pane 失败（退出码 ${r.exitCode}）：${r.stderr.trim()}`,
          );
        }
        // F1（终审修复波）：桥接侧快照封顶尾保留（tmux history 仍持全量，非静默——
        // 丢弃量如实入 meta）
        const capped = capRawTail(r.stdout);
        raw = capped.raw;
        rawDroppedBytes = capped.droppedBytes;
      }
      return {
        // raw = 即时 capture（512KB 尾封顶）；会话亡故无 pane 可捕获 → 空串
        //（meta.alive 如实标注）
        raw,
        meta: {
          id: s.ref.id,
          kind: s.ref.kind,
          host: "tmux",
          target: s.target,
          alive,
          closed: s.closed,
          rawDroppedBytes,
          log: { ...s.log },
        },
      };
    },
  };

  return transport;
}
