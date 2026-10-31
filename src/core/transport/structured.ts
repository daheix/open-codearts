/**
 * codearts-bridge structured 传输（T2-04）—— `codearts run --format json` 驱动。
 *
 * 职责：CodeartsTransport 的结构化通道实现——**每回合 = 一个独立
 * `<installDir>/bin/codearts run <prompt> --format json --print-logs` 进程**
 * （回合进程退出即回合结束，内核内存每回合归零——痛点②治理主路径；会话连续性
 * 经 `--session <id>` 续接）。契约唯一真相源为 types.ts；本文件实现其全部六方法，
 * 并对齐 T2-01 FakeTransport 的可观测语义（T3-03 监督状态机可迁移基准）。
 *
 * 主控裁定对照（2026-10-31，逐条落实）：
 * - R-s1 回合=进程：inject(ref, prompt) 即发起新回合——spawn argv 一律数组传递
 *   （禁 shell 字符串拼接，prompt 为单个 argv 元素，空格/特殊字符不被拆词解释）；
 *   `--session <id>` 续接（会话 id 已捕获时）。session id 从事件行宽容提取：
 *   任意 JSON 对象行的 `sessionID` / `session_id` 字符串字段，**首现即捕获、
 *   后续不改写**；非 JSON 行保留原文为 output 信号（宽容解析，不静默丢弃）。
 * - R-s2 AK/SK 前置：每次 start 均执行 readAksk(cfg.akskFile)（非缓存）；缺失
 *  （文件不存在 / AK、SK 任一为空）→ BridgeError(AKSK_MISSING)，remediation 含
 *   官方配置入口与 config.env 说明；**不静默转 PTY**。读取错误（EACCES 等）
 *   由 readAksk 原样向上传播（显式不吞）。会话缓存最近一次成功 start 的凭据，
 *   后续回合 env 装配用缓存值（凭据文件中途删除不追溯已建会话——显式语义）。
 * - R-s3 env 装配：沿用父进程全量环境（wrapper 全量字段语义：不裁剪任何变量），
 *   仅叠加 CODEARTS_CLI_AK / CODEARTS_CLI_SK；OPENCODE_MODE 不注入（交由 run
 *   子命令语义；如实测发现必须，须显式注释依据再补——当前无证据）。
 * - R-s4 并发=1：同一 ref 存在活跃回合（已 spawn 且退出回调未到）时再 inject →
 *   BridgeError(ROUND_ACTIVE)；kill = 直接杀进程+进程组（生产 spawn detached 使
 *   回合进程为进程组长，stop 经 process.kill(-pid, SIGKILL) 组杀——T2-02 教训：
 *   防孤儿内部 server；ESRCH 视为终止目标已达成，其余错误显式抛
 *   STRUCTURED_STOP_FAILED）；进程退出 → 一次性 done（code=0）/ error（code≠0）
 *   信号并清理（回合状态留账，下次 inject 覆盖）。
 * - R-s5 事件→信号映射表（唯一真相源，本表即注释）：
 *   ┌──────────────────────────────────┬─────────────────────────────────────┐
 *   │ JSONL 行                          │ Signal                              │
 *   ├──────────────────────────────────┼─────────────────────────────────────┤
 *   │ JSON 对象 type="session.id"       │ 捕获会话 id（首现）+ step（原文整行） │
 *   │ JSON 对象 type="message.part"     │ output（text=part.text，无则原文整行）│
 *   │ JSON 对象 type="error"            │ error（text=message，无则原文整行）   │
 *   │ 其余 JSON 对象（未知事件）          │ output（原文整行，宽容不丢弃）        │
 *   │ 非 JSON 行（日志噪声/横幅）         │ output（原文整行，宽容不丢弃）        │
 *   │ 任意 JSON 对象含 sessionID/        │ 捕获会话 id（首现优先，不改写）       │
 *   │ session_id 字符串字段              │ （与上述映射叠加，不互斥）            │
 *   │ 进程退出 code=0                   │ done（一次性，无 text，随后迭代结束） │
 *   │ 进程退出 code≠0                   │ error（一次性，text=退出码详情，       │
 *   │                                  │  无 done；随后迭代结束）              │
 *   └──────────────────────────────────┴─────────────────────────────────────┘
 *   classifyError(line)：ECONNRESET / timeout / 429 / 503 → "retryable"；
 *   认证失败 → "fatal"（**优先于 retryable**——凭据缺失重试无意义，须人工配置）；
 *   其余 → undefined。子串宽容匹配（面向 T3 重试策略的分类线索，非解析器）。
 *
 * 设计裁决（实现者决策，供评审）：
 * - 签名：`createStructuredTransport(exec)`——plan 卡写 `(cfg, exec, aksk?)`，
 *   但 types.ts（T2-01 唯一真相源）以 start(cfg) 逐次交付配置、aksk 经
 *   readAksk(cfg.akskFile) 在 start 内前置读取（R-s2），为避免 installDir/凭据
 *   双真相源并对齐 T2-02/T2-03 先例，取 (exec) 单参（本传输无轮询时钟需求：
 *   全事件驱动，行回调/退出回调直接驱动，无需注入 clock）。
 * - 语义映射：inject = 发起新回合（text 即本轮 prompt；接口注"注入一段文本
 *  （如续跑指令）"的 structured 对应物）；prompt 允许多行/任意字符（argv 元素
 *   直传，无 PTY 两段式提交问题，故无 INJECT_TEXT_MULTILINE 检查）；空串 prompt
 *   显式拒绝（INJECT_TEXT_EMPTY——空回合必为调用方缺陷）。
 * - alive() 语义：!closed（会话可接受新回合即"存活"）。回合进程存活与否属回合
 *   状态，由 snapshot.meta.activeRound / lastExit 如实标注——回合失败（exit≠0）
 *   产 error 信号但**不**宣告会话死亡（监督层可续接新回合重试，T3 依赖此语义；
 *   与 PTY 宿主"进程死=会话死"的固有差异源于回合=进程模型）。
 * - stop 为会话终态（closed）：终止活跃回合进程组、观察终止（不产 done）、
 *   后续 inject/start(ref) 显式 SESSION_NOT_ALIVE（与 PTY 宿主终态语义一致）。
 * - stdout/stderr 合并为同一行流（按到达序）；每流独立 StringDecoder（多字节
 *   跨 chunk 完整还原）；进程退出时冲刷残段（stdout 先于 stderr）——最后一行
 *   无换行符的事件不丢失。
 * - start(cfg) 不 spawn 任何进程（回合进程仅由 inject 发起）：start 只做 AK/SK
 *   前置检查与会话登记；ref.id = `structured-<n>`（本实例内唯一不透明标识）。
 *
 * 语义裁决（显式报错，禁静默兜底；与 Fake/script 对齐项注明）：
 * - 未知 ref（未注册/kind 不符）：SESSION_UNKNOWN（与 Fake 同）；
 * - 活跃回合中 inject：ROUND_ACTIVE（并发=1，R-s4）；空 prompt：INJECT_TEXT_EMPTY；
 * - 同一 ref 并发第二个 observe：OBSERVER_ACTIVE（单观察者模型，与 Fake 同）；
 * - observe 尊重 opts.signal（T9 基准）：abort=立即放弃——残存未消费信号丢弃
 *   不交付当前消费者、保留给下一次 observe、不 flush、不抛错；
 * - stop 后 observe 终止（不产 done）；回合退出信号交付完毕后迭代自然结束
 *   （再 observe 为立即结束的空迭代——空闲会话无信号流，等下一回合）；
 * - spawn 失败（bin 缺失/不可执行，lookPath 预检）：STRUCTURED_SPAWN_FAILED
 *  （remediation 指向 codearts_status/repair）；组杀失败（非 ESRCH）：
 *   STRUCTURED_STOP_FAILED——均显式抛出。
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { readAksk, type Aksk, type BridgeConfig } from "../config";
import { BridgeError } from "../errors";
import { lookPath } from "./shared";
import type {
  CodeartsTransport,
  ObserveOptions,
  SessionRef,
  Signal,
  TransportKind,
} from "./types";

/** 回合进程退出信息（code=null 表示 spawn 本身失败，signal 携带原因码）。 */
export interface ProcExit {
  code: number | null;
  signal: string | null;
}

/** 回合子进程句柄（注入 seam；单播回调，start 注入端在 spawn 后接线一次）。 */
export interface ProcChild {
  pid: number;
  /** 注册行回调：stdout/stderr 按到达序解码分行的完整行（含残段冲刷）。 */
  onLine(cb: (line: string) => void): void;
  /** 注册退出回调（一次性）。 */
  onExit(cb: (exit: ProcExit) => void): void;
  /** 终止进程组（生产：detached + 负 PID SIGKILL；ESRCH 幂等）。 */
  kill(): void;
  alive(): boolean;
}

/** 回合进程执行器（注入 seam）：测试注入 fake（离线零进程），生产用 nodeRunSpawnProc。 */
export interface StructuredExec {
  /** spawn 一个回合进程；argv 数组传参（禁 shell 拼接）；spawn 失败同步抛错。 */
  spawnProc(args: string[], env: NodeJS.ProcessEnv): ProcChild;
}

/* ───── 生产缺省 ProcChild 实现（node child_process，直 exec 不经 shell） ───── */

/**
 * 生产缺省 spawnProc：直接 exec args[0]（绝对路径，detached 使其为进程组长），
 * stdin=ignore（prompt 走 argv，回合进程不读 stdin——无写端 EPIPE 面）。
 * - 可执行文件缺失/不可执行：先 lookPath 预检（accessSync X_OK）再 spawn，
 *   同步抛 STRUCTURED_SPAWN_FAILED（无竞态窗口）；
 * - R-p6 同款 UTF-8 纪律：stdout/stderr 各持独立 StringDecoder；
 * - 退出时冲刷两流残段（stdout 先于 stderr）后回调 exit——最后一行无换行符
 *   的事件不丢失；
 * - spawn 期 'error'（预检后的竞态，如 EACCES/EMFILE）：显式转退出回调
 *   （code=null，signal=SPAWN_ERROR:<errno>），由传输层产出 error 信号，绝不静默；
 * - kill = process.kill(-pid, SIGKILL) 组杀（R-s4：防孤儿内部 server）；
 *   ESRCH = 已死（幂等），其余错误显式抛 STRUCTURED_STOP_FAILED。
 */
export function nodeRunSpawnProc(args: string[], env: NodeJS.ProcessEnv): ProcChild {
  const exe = args[0];
  if (exe === undefined || exe === "") {
    throw new BridgeError("STRUCTURED_SPAWN_FAILED", "spawnProc 参数缺少可执行文件路径", {
      remediation: "检查 structured 传输装配参数（<installDir>/bin/codearts）。",
    });
  }
  const resolved = lookPath(exe, env); // 含 "/" → accessSync X_OK 直检
  if (resolved === null) {
    throw new BridgeError("STRUCTURED_SPAWN_FAILED", `可执行文件缺失或不可执行：${exe}`, {
      remediation: "运行 codearts_status 检查安装完整性；必要时用 codearts_repair 修复。",
    });
  }
  const child = spawn(resolved, args.slice(1), {
    detached: true, // R-s4：回合进程为新进程组长，供 kill(-pid) 组杀
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (child.pid === undefined) {
    throw new BridgeError("STRUCTURED_SPAWN_FAILED", `进程 spawn 失败：${exe}`);
  }
  const pid: number = child.pid; // 收窄捕获（child.pid 类型为 number|undefined）

  let exited = false;
  const decOut = new StringDecoder("utf8");
  const decErr = new StringDecoder("utf8");
  let partialOut = ""; // 未遇 \n 的行尾残段（跨 chunk 保持）
  let partialErr = "";
  let lineSink: ((line: string) => void) | null = null;
  let exitSink: ((exit: ProcExit) => void) | null = null;

  const emitLine = (line: string): void => {
    lineSink?.(line); // 空行也如实交付（宽容，不静默丢弃）
  };

  /** 增量解码 → 完整行（按流独立缓冲，跨 chunk 多字节安全）。 */
  const feed = (chunk: string, which: "out" | "err"): void => {
    const partial = which === "out" ? (partialOut += chunk) : (partialErr += chunk);
    const parts = partial.split("\n");
    const rest = parts.pop() ?? ""; // 末段可能不完整：留待下一增量
    if (which === "out") partialOut = rest;
    else partialErr = rest;
    for (const raw of parts) {
      emitLine(raw.endsWith("\r") ? raw.slice(0, -1) : raw);
    }
  };

  /** 退出时残段冲刷（进程已终，无更多输入；stdout 先于 stderr）。 */
  const flush = (partial: string): void => {
    if (partial === "") return;
    emitLine(partial.endsWith("\r") ? partial.slice(0, -1) : partial);
  };

  child.stdout?.on("data", (b: Buffer) => feed(decOut.write(b), "out"));
  child.stderr?.on("data", (b: Buffer) => feed(decErr.write(b), "err"));
  // 流错误（典型：读端异常）= 底层进程已死：alive() 如实转 false（显式状态，
  // 不改变错误呈现——exit 事件仍会到达并驱动 error 信号）。
  child.stdout?.on("error", () => {
    exited = true;
  });
  child.stderr?.on("error", () => {
    exited = true;
  });
  child.on("exit", (code, signal) => {
    exited = true;
    flush(partialOut);
    partialOut = "";
    flush(partialErr);
    partialErr = "";
    exitSink?.({ code, signal });
  });
  child.on("error", (e: NodeJS.ErrnoException) => {
    // spawn 失败（预检后竞态）：显式转退出回调（code=null），绝不静默吞掉。
    if (exited) return;
    exited = true;
    exitSink?.({ code: null, signal: `SPAWN_ERROR:${e.code ?? "UNKNOWN"}` });
  });

  return {
    pid,
    onLine(cb) {
      lineSink = cb;
    },
    onExit(cb) {
      exitSink = cb;
    },
    kill() {
      if (exited) return;
      try {
        process.kill(-pid, "SIGKILL"); // R-s4：负 pid = 进程组 SIGKILL
      } catch (e) {
        const code = (e as NodeJS.ErrnoException | null)?.code;
        if (code !== "ESRCH") {
          throw new BridgeError(
            "STRUCTURED_STOP_FAILED",
            `回合进程组终止失败：pid=${pid} errno=${code ?? String(e)}`,
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

/* ───── 会话状态 ───── */

/** 单个回合的可变状态（活跃回合与刚退出回合共用；下次 inject 覆盖）。 */
interface RoundState {
  child: ProcChild;
  /** 退出回调已到（回合终局；此后会话空闲，可发起新回合）。 */
  exitSeen: boolean;
  /** 回合终局信号（done/error）是否已入队（只产一次）。 */
  exitSignalEnqueued: boolean;
}

/** 单个 structured 会话的全部可变状态（经 ref.id 寻址；含已 stop 会话：留账不丢）。 */
interface StructSession {
  ref: SessionRef;
  /** 最近一次成功 start 绑定的配置（回合 argv 装配用；start(ref) 刷新）。 */
  cfg: BridgeConfig;
  /** 最近一次成功 start 前置读取的凭据（回合 env 装配用；R-s2 注）。 */
  aksk: Aksk;
  /** 已捕获的 codearts 会话 id（null = 尚未建立；首现捕获后不改写）。 */
  codeartsSessionId: string | null;
  /** 当前回合（null = 从未发起/已被新一轮覆盖）。 */
  round: RoundState | null;
  /** 已发起回合总数（snapshot.meta.rounds）。 */
  roundSeq: number;
  /** 最近一次回合退出信息（snapshot.meta.lastExit）。 */
  lastExit: ProcExit | null;
  /** raw 缓冲：output/error 信号 text 按序累积（每条后接 \n；与消费无关）。 */
  raw: string;
  /** 待消费信号队列（事件行 / 回合终局信号）。 */
  queue: Signal[];
  /** observe 挂起等待者（wakeAll 唤醒后自旋复查状态）。 */
  waiters: Array<() => void>;
  /** 当前活跃观察者标记（单观察者模型；null = 无）。 */
  observer: symbol | null;
  /** stop 置位：会话终态（观察终止、注入拒绝）。 */
  closed: boolean;
}

/** 会话唤醒/等待机制（与 pty-script 同构；本传输无轮询，纯事件驱动）。 */
function wakeAll(s: StructSession): void {
  const waiters = s.waiters.splice(0);
  for (const wake of waiters) wake();
}

function waitFor(s: StructSession): Promise<void> {
  return new Promise((resolve) => {
    s.waiters.push(resolve);
  });
}

/* ───── structured 传输 ───── */

/**
 * 构造 structured 传输（回合=进程）。
 * @param exec 回合进程执行器注入 seam：生产传 { spawnProc: nodeRunSpawnProc }；
 *   测试注入 fake（离线零进程）或经 nodeRunSpawnProc 真实 spawn fixture。
 */
export function createStructuredTransport(exec: StructuredExec): CodeartsTransport {
  const kind: TransportKind = "structured";
  /** 会话表：id → 状态（含已 stop 会话：snapshot/留账不丢）。 */
  const sessions = new Map<string, StructSession>();
  let idNext = 0;

  function requireSession(ref: SessionRef): StructSession {
    const s = ref.kind === kind ? sessions.get(ref.id) : undefined;
    if (s === undefined) {
      throw new BridgeError("SESSION_UNKNOWN", `未知会话引用：kind=${ref.kind} id=${ref.id}`, {
        remediation: "仅可使用本 transport.start 返回过的 SessionRef。",
      });
    }
    return s;
  }

  /**
   * R-s5 事件行解析 → 信号入队（映射表见文件头——唯一真相源）。
   * 宽容纪律：非 JSON 行、非对象 JSON、未知事件类型一律原文 output（不静默丢弃）；
   * 会话 id 提取对所有 JSON 对象行生效（sessionID/session_id，首现捕获不改写）。
   */
  function handleLine(s: StructSession, line: string): void {
    let obj: unknown = undefined;
    try {
      obj = JSON.parse(line);
    } catch {
      // 非 JSON：走原文 output 分支
    }
    if (obj !== null && typeof obj === "object" && !Array.isArray(obj)) {
      const ev = obj as Record<string, unknown>;
      // 会话 id 宽容提取（首现优先，捕获后不改写）
      if (s.codeartsSessionId === null) {
        const sid = ev.sessionID ?? ev.session_id;
        if (typeof sid === "string" && sid !== "") s.codeartsSessionId = sid;
      }
      const type = typeof ev.type === "string" ? ev.type : null;
      if (type === "session.id") {
        s.queue.push({ t: "step", at: Date.now(), text: line });
        wakeAll(s);
        return;
      }
      if (type === "message.part") {
        const part = ev.part;
        const partText =
          typeof part === "object" && part !== null && typeof (part as Record<string, unknown>).text === "string"
            ? ((part as Record<string, unknown>).text as string)
            : null;
        const text = partText ?? (typeof ev.text === "string" ? ev.text : line);
        s.raw += `${text}\n`;
        s.queue.push({ t: "output", at: Date.now(), text });
        wakeAll(s);
        return;
      }
      if (type === "error") {
        const text = typeof ev.message === "string" ? ev.message : line;
        s.raw += `${text}\n`;
        s.queue.push({ t: "error", at: Date.now(), text });
        wakeAll(s);
        return;
      }
      // 其余 JSON 对象：落到下方原文 output（宽容不丢弃）
    }
    s.raw += `${line}\n`;
    s.queue.push({ t: "output", at: Date.now(), text: line });
    wakeAll(s);
  }

  const transport: CodeartsTransport = {
    kind,

    async start(cfg: BridgeConfig, ref?: SessionRef): Promise<SessionRef> {
      // R-s2：AK/SK 前置检查——每次 start 都执行（非缓存）；readAksk 的非 ENOENT
      // 错误原样向上传播（显式不吞）。
      const aksk = await readAksk(cfg.akskFile);
      if (
        aksk === undefined ||
        aksk.AK === undefined ||
        aksk.AK === "" ||
        aksk.SK === undefined ||
        aksk.SK === ""
      ) {
        throw new BridgeError(
          "AKSK_MISSING",
          `structured 传输要求 AK/SK 凭据（F2 实测：无头 run 命令强制 CODEARTS_CLI_AK/SK）：akskFile=${cfg.akskFile}`,
          {
            remediation: `在 https://codearts.huaweicloud.com/portal/settings/cli-auth 获取 CLI 凭据，写入 ${cfg.akskFile}（两行：AK=… / SK=…，权限 0600）后重试；如需免凭据交互请显式配置 pty 传输，本传输不静默切换。`,
          },
        );
      }
      if (ref !== undefined) {
        const s = requireSession(ref);
        if (s.closed) {
          throw new BridgeError("SESSION_NOT_ALIVE", `会话已停止，不可复用：id=${ref.id}`, {
            remediation: "structured 会话 stop 后为终态；请新建会话（start 不带 ref）。",
          });
        }
        s.cfg = cfg; // 刷新绑定配置与凭据（下一回合装配用最新值）
        s.aksk = aksk;
        return { ...s.ref };
      }
      const id = `structured-${++idNext}`;
      const created: SessionRef = { kind, id };
      sessions.set(id, {
        ref: created,
        cfg,
        aksk,
        codeartsSessionId: null,
        round: null,
        roundSeq: 0,
        lastExit: null,
        raw: "",
        queue: [],
        waiters: [],
        observer: null,
        closed: false,
      });
      return { ...created };
    },

    async inject(ref: SessionRef, text: string): Promise<void> {
      const s = requireSession(ref);
      if (s.closed) {
        throw new BridgeError("SESSION_NOT_ALIVE", `会话已停止，拒绝注入：id=${ref.id}`, {
          remediation: "structured 会话 stop 后为终态；请新建会话（start 不带 ref）。",
        });
      }
      // R-s4 并发=1：活跃回合（已 spawn、退出回调未到）期间禁止新回合
      if (s.round !== null && !s.round.exitSeen) {
        throw new BridgeError("ROUND_ACTIVE", `会话已有活跃回合（并发=1）：id=${ref.id}`, {
          remediation: "等待当前回合结束（done/error 信号）或 stop 终止后再发起新回合。",
        });
      }
      if (text.length === 0) {
        throw new BridgeError("INJECT_TEXT_EMPTY", "注入文本为空（prompt 不得为空串）", {
          remediation: "提供非空 prompt；空回合必为调用方缺陷，本传输显式拒绝。",
        });
      }
      // R-s1：argv 数组传参（禁 shell 拼接）；--session 续接已捕获会话。
      // 修复环裁定①（2026-10-31）：structured 维持 bin 直启（不经
      // <installDir>/codearts 官方 wrapper）——`run` 子命令为无头 JSONL 通道，
      // 无 TUI 交互授权门，凭据由 R-s2 AK/SK 前置保障；wrapper 的 TUI env
      // 装配（OPENCODE_MODE=tui 等）对无头通道无意义，且会引入对 wrapper 文件
      // 的额外部署依赖。此为显式设计决策，非"PTY 走 wrapper"的回退对照面。
      const argv = [path.join(s.cfg.installDir, "bin", "codearts"), "run", text];
      if (s.codeartsSessionId !== null) argv.push("--session", s.codeartsSessionId);
      argv.push("--format", "json", "--print-logs");
      // R-s3：父进程全量环境 + CODEARTS_CLI_AK/SK 注入；OPENCODE_MODE 不注入
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CODEARTS_CLI_AK: s.aksk.AK,
        CODEARTS_CLI_SK: s.aksk.SK,
      };
      const child = exec.spawnProc(argv, env); // spawn 失败（bin 缺失等）同步抛出，回合不登记
      s.roundSeq++;
      const round: RoundState = { child, exitSeen: false, exitSignalEnqueued: false };
      s.round = round;
      child.onLine((line) => handleLine(s, line));
      child.onExit((exit) => {
        round.exitSeen = true;
        s.lastExit = exit;
        if (round.exitSignalEnqueued) return; // 只产一次（防御重复回调）
        round.exitSignalEnqueued = true;
        // 注：stop() 组杀触发的退出同样如实入账（error 信号入队）——会话已
        // closed，该信号随终态保留在队列（记录事实），不向已终止的观察补投 done。
        if (exit.code === 0) {
          s.queue.push({ t: "done", at: Date.now() }); // R-s5：退出码 0 → done（无 text）
        } else {
          // 回合失败：error 信号（会话不死亡——可续接新回合，见 alive() 语义注）
          const detail = `回合进程异常退出：code=${exit.code} signal=${exit.signal ?? "null"}`;
          s.raw += `${detail}\n`;
          s.queue.push({ t: "error", at: Date.now(), text: detail });
        }
        wakeAll(s);
      });
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
      const signal = observeOpts?.signal;
      let terminated = false;
      const release = (): void => {
        if (s.observer === token) s.observer = null;
      };

      async function* iterate(): AsyncGenerator<Signal> {
        const onAbort = (): void => wakeAll(s);
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          while (true) {
            // abort = 立即放弃：残存不交付当前消费者、保留在队列给下一次 observe（T9 基准同态）
            if (signal?.aborted || terminated) return;
            if (s.queue.length > 0) {
              yield s.queue.shift() as Signal;
              continue;
            }
            if (s.closed) return; // stop：观察直接终止（不产 done，与 Fake 同态）
            if (s.round !== null && s.round.exitSignalEnqueued) {
              return; // 回合终局信号已交付：本次观察自然终结（空闲会话无信号流）
            }
            await waitFor(s);
          }
        } finally {
          signal?.removeEventListener("abort", onAbort);
          release();
        }
      }

      // 包装迭代器（与 FakeTransport M34 / pty-script 同构，来源标注）：显式
      // return/throw 先同步终结挂起等待并释放观察者，再委托内部 generator——
      // "未启动即 return"（generator 体未执行、finally 不触发）也不泄漏。
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
      // structured 语义：会话可接受新回合即"存活"（回合进程存活状态见
      // snapshot.meta.activeRound/lastExit；回合失败不宣告会话死亡）。
      return !requireSession(ref).closed;
    },

    async stop(ref: SessionRef): Promise<void> {
      const s = requireSession(ref);
      if (s.closed) return; // 幂等
      s.closed = true;
      // R-s4：直接杀进程+进程组（detached+负 PID；ESRCH=已达成，见生产实现注）
      if (s.round !== null && !s.round.exitSeen && s.round.child.alive()) {
        s.round.child.kill();
      }
      wakeAll(s);
    },

    async snapshot(ref: SessionRef): Promise<{ raw: string; meta: Record<string, unknown> }> {
      const s = requireSession(ref);
      return {
        // raw = output/error 信号文本按序累积（每条后接 \n）；step/done 不入 raw
        raw: s.raw,
        meta: {
          id: s.ref.id,
          kind: s.ref.kind,
          host: "structured",
          codeartsSessionId: s.codeartsSessionId,
          activeRound: s.round !== null && !s.round.exitSeen,
          rounds: s.roundSeq,
          lastExit: s.lastExit === null ? null : { ...s.lastExit },
          alive: !s.closed,
          closed: s.closed,
        },
      };
    },
  };

  return transport;
}

/**
 * R-s5 错误分级（纯函数；供 T3 监督层对 error 信号文本分类）。
 * 优先级：认证失败（fatal，须人工配置凭据，重试无意义）先于可重试特征。
 * 匹配为行内子串宽容匹配（分类线索，非解析器）。
 */
export function classifyError(line: string): "retryable" | "fatal" | undefined {
  if (line.includes("认证失败")) return "fatal";
  const lower = line.toLowerCase();
  if (
    lower.includes("econnreset") ||
    lower.includes("timeout") ||
    line.includes("429") ||
    line.includes("503")
  ) {
    return "retryable";
  }
  return undefined;
}

/** 空信号迭代（observe 收到已 abort 的 signal 时返回；不占观察者）。 */
function emptySignals(): AsyncIterable<Signal> {
  return (async function* () {})();
}
