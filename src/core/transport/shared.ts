/**
 * codearts-bridge 传输层共享小助手（R-tm5 提取，2026-10-31）。
 *
 * 职责：pty-script（T2-02）与 pty-tmux（T2-03）两宿主的共享实现件，唯一真相源
 * 在本文件；两宿主只 import、不复制。提取范围以"显著降低重复且不破坏既有测试"
 * 为限（主控裁定 R-tm5）：
 * - 日志信号源 tailer（`<kernelDataDir>/log/kernel-*.log` 增量 tail + service=
 *   行过滤入队，R-p2/R-tm6 同语义）——自 pty-script.ts 原样迁移（逻辑零改动，
 *   仅把"唤醒会话等待者"从直接调用 wakeAll(s) 改为注入 wake 回调，因唤醒机制
 *   属各宿主自有状态）；
 * - shQuote / lookPath / 可注入时钟类型——两宿主同源小助手。
 *
 * I1（评审修复，2026-10-31）：log 状态在本文件内一律**原地变更**（不整体替换
 * s.log 引用）。原因：tmux 同名重建（T2-03 start(ref) 对账语义）时新旧会话
 * 状态对象共享同一 log 对象，若以引用替换方式更新可用性，旧观察者结束时的
 * close 只替换到旧对象，新对象读到的 snapshot.meta.log 将永久滞留陈旧值
 * （分叉）；原地变更使可用性/文件名/计数对所有持有时显式同步。
 *
 * 观察循环骨架（队列排空/closed/单观察者/abort 对齐）各宿主差异较大
 * （script 为同步 child.alive() + onData 独立生产者；tmux 为异步 has-session
 * 探测 + 生成器体内轮询 capture-pane 生产者），**不做**提取——按 R-tm5 的
 * "否则最小重复实现"处理，两宿主各自实现并互相标注来源。
 *
 * 终审修复波 F1（2026-10-31）：新增会话 raw 封顶尾缓冲（CappedTailBuffer /
 * SESSION_RAW_CAP_BYTES / capRawTail）——三传输（structured/script/tmux）共享
 * 的桥接侧内存收口（内存要求③），三宿主一致语义：raw 只保留最新 512KB 尾部，
 * 丢弃量以 rawDroppedBytes 计数暴露于 snapshot().meta（审计可见，非静默）。
 */

import { accessSync, constants, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Signal } from "./types";

/** 可注入时钟（R-p1/R-tm6）：返回在 ms 毫秒后落定的 Promise。 */
export type PtyClock = (ms: number) => Promise<void>;

/**
 * sh 单引号转义：script -c 与 tmux new-session 的命令参数均经 /bin/sh 语义
 * 解析（已实测），命令串中的路径须转义以防空格/引号破坏。数据源仅为配置路径
 * （installDir），非用户文本。
 */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** PATH 探测：返回可执行文件绝对路径；找不到返回 null（不做任何兜底替换）。 */
export function lookPath(exe: string, env: NodeJS.ProcessEnv): string | null {
  if (exe.includes("/")) {
    try {
      accessSync(exe, constants.X_OK);
      return exe;
    } catch {
      return null;
    }
  }
  for (const dir of (env.PATH ?? "").split(":")) {
    if (dir === "") continue;
    const candidate = path.join(dir, exe);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // 该目录不存在此文件：继续搜下一目录（搜索语义，非兜底）
    }
  }
  return null;
}

/* ───── 日志信号源 tailer（R-p2 / R-tm6 唯一真相源） ───── */

/** 内核数据根缺省值（与 health.ts R-h3 同源）。 */
export const DEFAULT_KERNEL_DATA_DIR = path.join(homedir(), ".codeartsdoer", "cli-data");

/** 内核日志文件名口径（与 health.ts KERNEL_LOG_RE 同源：log 目录顶层 kernel-*.log）。 */
const KERNEL_LOG_RE = /^kernel-.+\.log$/;

/** 日志 tailer 宿主状态（transport 实现方的会话状态对象须结构性满足）。 */
export interface LogSourceState {
  /** 日志源状态（snapshot.meta.log；serviceLines 跨观察累计，留痕不丢）。 */
  log: { available: boolean; file: string | null; serviceLines: number };
  /** 待消费信号队列（service= 行转为 output 信号入队）。 */
  queue: Signal[];
}

/** 日志 tailer（observe 生命期）。 */
export interface LogTailer {
  /** 增量扫描一次（事件驱动 + 观察轮询 tick 兜底调用；幂等、可重入合并）。 */
  poll(): Promise<void>;
  /** 关闭 watcher（幂等；关闭后 available 转 false 如实标注）。 */
  close(): void;
}

/** 列出 log 目录顶层 kernel-*.log，按 mtime 降序取最新（并列按文件名）。 */
function newestKernelLog(
  dir: string,
): { path: string; name: string; size: number; mtimeMs: number } | null {
  let best: { path: string; name: string; size: number; mtimeMs: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!KERNEL_LOG_RE.test(name)) continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (!st.isFile()) continue;
    if (
      best === null ||
      st.mtimeMs > best.mtimeMs ||
      (st.mtimeMs === best.mtimeMs && name > best.name)
    ) {
      best = { path: full, name, size: st.size, mtimeMs: st.mtimeMs };
    }
  }
  return best;
}

/**
 * 装配日志 tailer（observe 调用时同步执行——statSync 基线保证确定性：observe
 * 返回后追加的内容必被读到；watcher 就绪前的事件由观察轮询 tick 兜底）。
 * - 基线 = 最新 kernel-*.log 当前大小（只看增量）；无文件/目录缺失 → 不可用态；
 * - 事件（文件追加/目录建删）→ poll：重列目录，最新文件变化即切换（新文件从 0
 *   读，轮转内容全新）；否则从 offset 增量读，完整行经 service= 过滤入队；
 * - wake：新信号入队后由宿主唤醒其观察等待者（唤醒机制属宿主自有状态）；
 * - 一切 FS 错误按 R-p2 处理：不抛出，如实转不可用态（PTY 通道不受影响，
 *   本裁定显式豁免"禁静默兜底"全局约束于日志源；PTY 侧错误仍显式抛出）。
 */
export function armLogTailer(
  s: LogSourceState,
  kernelDataDir: string | undefined,
  wake: () => void,
): LogTailer {
  const dir = path.join(kernelDataDir ?? DEFAULT_KERNEL_DATA_DIR, "log");
  let current: string | null = null;
  let offset = 0;
  let partial = ""; // 未遇 \n 的行尾残段（跨增量保持）
  const decoder = new StringDecoder("utf8"); // 文件字节 → 字符（跨增量多字节安全）
  let closedT = false;
  let polling = false;
  let dirty = false;
  let fileWatcher: FSWatcher | null = null;
  let dirWatcher: FSWatcher | null = null;

  // I1：原地变更（不替换 s.log 引用）——理由见文件头"I1 评审修复"
  const markUnavailable = (): void => {
    s.log.available = false;
    s.log.file = null;
  };

  // ── 同步基线（确定性关键：observe 返回时基线已定） ──
  try {
    const newest = newestKernelLog(dir);
    if (newest !== null) {
      current = newest.path;
      offset = newest.size;
      s.log.available = true;
      s.log.file = newest.name;
    }
  } catch {
    markUnavailable(); // 目录缺失等（R-p2：不报错）
  }

  const rearmFileWatcher = (p: string): void => {
    fileWatcher?.close();
    fileWatcher = null;
    try {
      const w = watch(p, { persistent: false }, () => void tailer.poll());
      w.on("error", () => {
        // 被跟踪文件被删/失效（轮转常态）：关闭自身，目录 watcher + 轮询兜底恢复
        w.close();
        if (fileWatcher === w) fileWatcher = null;
      });
      fileWatcher = w;
    } catch {
      // watch 启动失败（文件竞态删除）：轮询兜底
    }
  };

  const tailer: LogTailer = {
    poll() {
      if (closedT) return Promise.resolve();
      if (polling) {
        dirty = true;
        return Promise.resolve();
      }
      polling = true;
      const step = async (): Promise<void> => {
        try {
          do {
            dirty = false;
            await readIncrement();
          } while (dirty);
        } catch {
          markUnavailable(); // R-p2：日志源任何错误不影响 PTY 通道
        }
      };
      return step().finally(() => {
        polling = false;
      });
    },
    close() {
      if (closedT) return;
      closedT = true;
      fileWatcher?.close();
      fileWatcher = null;
      dirWatcher?.close();
      dirWatcher = null;
      markUnavailable();
    },
  };

  async function readIncrement(): Promise<void> {
    let newest: ReturnType<typeof newestKernelLog> = null;
    try {
      newest = newestKernelLog(dir);
    } catch {
      markUnavailable(); // 目录在观察中被删（R-p2）
      return;
    }
    if (newest === null) {
      current = null;
      offset = 0;
      partial = "";
      markUnavailable();
      return;
    }
    if (newest.path !== current) {
      // 轮转/首见新文件：从 0 读（新文件内容全部为增量），残段作废
      rearmFileWatcher(newest.path);
      current = newest.path;
      offset = 0;
      partial = "";
      s.log.available = true; // I1：原地变更（见文件头）
      s.log.file = newest.name;
    }
    if (offset >= newest.size) return; // 无增量
    const fh = await open(newest.path, "r");
    try {
      const len = newest.size - offset;
      const buf = Buffer.alloc(len);
      const { bytesRead } = await fh.read(buf, 0, len, offset);
      offset += bytesRead;
      partial += decoder.write(buf.subarray(0, bytesRead));
    } finally {
      await fh.close();
    }
    const lines = partial.split("\n");
    partial = lines.pop() ?? ""; // 末段可能不完整：留待下一增量
    for (const raw of lines) {
      const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
      if (!line.includes("service=")) continue; // R-p2：仅 service= 行转为信号
      s.log.serviceLines++;
      s.queue.push({ t: "output", at: Date.now(), text: line });
    }
    wake();
  }

  // 目录 watcher：轮转（新建/删除/重命名）感知；追加事件在部分平台亦可见，
  // 与文件 watcher 双保险，均只作 poll 触发信号。
  try {
    dirWatcher = watch(dir, { persistent: false }, () => void tailer.poll());
    dirWatcher.on("error", () => {
      dirWatcher?.close();
      dirWatcher = null;
    });
  } catch {
    markUnavailable(); // 目录缺失等（R-p2：不报错）
  }
  if (current !== null) rearmFileWatcher(current);

  return tailer;
}

/* ───── 会话 raw 封顶尾缓冲（终审修复波 F1，2026-10-31） ───── */

/**
 * 会话 raw 缓冲字节上限（512KB）。守护长驻下会话 raw 若无限累积，桥接侧 RSS
 * 单调增长（终审实证 raw 无消费者、仅调试快照用）；封顶后最坏占用恒为 cap。
 */
export const SESSION_RAW_CAP_BYTES = 512 * 1024;

/**
 * 封顶尾缓冲（F1 唯一真相源）：按追加序累积文本，总量（UTF-8 字节）超过
 * cap 时丢弃**最旧**字节、保留最新 ≤cap 字节（尾滚动）；累计丢弃字节数经
 * droppedBytes 暴露（snapshot.meta.rawDroppedBytes，审计可见非静默）。
 *
 * 实现纪律：
 * - 块列表累积（追加 O(1)）；裁剪先整块丢弃、边界块内按**码点**粒度裁剪——
 *   永不劈开代理对/多字节字符（slice 落在码点边界，UTF-8 重编码无损）；
 * - 字节口径统一 Buffer.byteLength(·, "utf8")（与"512KB 内存"的语义一致，
 *   非 UTF-16 code unit 数）；
 * - 本类不做任何兜底/吞错：纯内存结构，无失败路径。
 */
export class CappedTailBuffer {
  readonly #cap: number;
  #chunks: string[] = [];
  #bytes = 0;
  #dropped = 0;

  constructor(cap: number = SESSION_RAW_CAP_BYTES) {
    this.#cap = cap;
  }

  /** 追加一段输出（空串为无操作）；超限即时裁剪，#bytes 恒 ≤ max(cap, 单块字节)。 */
  append(text: string): void {
    if (text === "") return;
    this.#chunks.push(text);
    this.#bytes += Buffer.byteLength(text, "utf8");
    this.#trim();
  }

  /** 当前保留的尾部内容（拼接一次；≤ cap 字节）。 */
  value(): string {
    return this.#chunks.join("");
  }

  /** 累计丢弃的最旧字节数（snapshot.meta.rawDroppedBytes）。 */
  get droppedBytes(): number {
    return this.#dropped;
  }

  /** 超限裁剪：先整块丢（不改边界），末块码点粒度精确裁到 cap。 */
  #trim(): void {
    while (this.#bytes > this.#cap) {
      const head = this.#chunks[0]!;
      const headBytes = Buffer.byteLength(head, "utf8");
      if (this.#chunks.length > 1 && this.#bytes - headBytes >= this.#cap) {
        // 整块丢弃后仍 ≥ cap：安全整丢（不触码点边界）
        this.#chunks.shift();
        this.#bytes -= headBytes;
        this.#dropped += headBytes;
        continue;
      }
      // 边界块（或单块超限）：只丢超出部分，码点对齐防劈开字符
      const excess = this.#bytes - this.#cap;
      let removed = 0;
      let cut = 0;
      for (const ch of head) {
        if (removed >= excess) break;
        removed += Buffer.byteLength(ch, "utf8");
        cut += ch.length;
      }
      this.#chunks[0] = head.slice(cut);
      this.#bytes -= removed;
      this.#dropped += removed;
    }
  }
}

/**
 * 一次性封顶（无状态场景：tmux capture-pane 快照等非累积 raw）：返回按
 * SESSION_RAW_CAP_BYTES 尾保留的内容与本次丢弃字节数。语义与 CappedTailBuffer
 * 单次 append 逐字一致（同一实现路径，无第二真相源）。
 */
export function capRawTail(
  text: string,
  cap: number = SESSION_RAW_CAP_BYTES,
): { raw: string; droppedBytes: number } {
  const buf = new CappedTailBuffer(cap);
  buf.append(text);
  return { raw: buf.value(), droppedBytes: buf.droppedBytes };
}
