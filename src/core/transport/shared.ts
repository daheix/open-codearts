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
