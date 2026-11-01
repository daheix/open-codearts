/**
 * 守护会话画面状态注册表（2026-11-02 用户裁决：非托管 TUI 画面必须可正确查看）。
 *
 * 为什么需要：码道 TUI 是增量重绘（每帧只画变化格子），rawBuf 只保留 512KB 尾部——
 * 长会话的完整画面信息会滚出缓冲，直接重放 raw 片段到新 xterm 只能得到碎片
 * （"只有第一行乱麻数字"缺陷的根因）。唯一正确做法：守护侧维护**持续更新的
 * 屏幕网格状态**（xterm-headless 无头解析器），任何时候都能序列化出完整当前画面。
 *
 * 数据流：ticker（5s）+ 视图请求（随到随喂）→ transport.snapshot().raw 的**追加
 * 增量** → term.write()。rawBuf 是 append-only 尾缓冲，用 fedLen+尾部样本判定连续性；
 * 会话重建（守护重启后 reconcile 重建会话，rawBuf 从零开始）→ 检测到长度回退 →
 * 重置网格重新喂入（新缓冲含启动期整屏绘制，网格自愈正确）。
 *
 * 守护重启自愈：reconcile 必重建会话（全新 rawBuf + 启动整屏帧），注册表按新缓冲
 * 重建网格——设计上无需持久化。
 */
import { Terminal } from "@xterm/headless";
import type { CodeartsTransport, SessionRef } from "./transport/types";

/** 网格尺寸（须 ≥ TUI 实际 ioctl 尺寸；TUI 曾实测自适应扩宽到 312 列）。 */
const GRID_COLS = 400;
const GRID_ROWS = 120;
/** 连续性判定：上次喂入结束处向前取的 raw 尾部样本长度。 */
const TAIL_SAMPLE = 48;

interface GridState {
  term: Terminal;
  fedLen: number;
  fedTail: string;
  /** 状态版本：每次喂入非空增量 +1。 */
  rev: number;
  /** 最近一次喂入时的快照元数据（alive/pid 等透传给视图消费方）。 */
  lastMeta: Record<string, unknown>;
}

/** 单行序列化结果：[行号(0 基), ANSI 帧串]。空行不入列（消费方按缺席清行）。 */
type RowPair = [number, string];

export class ViewRegistry {
  private states = new Map<string, GridState>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly transport: CodeartsTransport) {}

  /** 启动连续性 ticker：喂入由调用方给定的会话清单（无人查看时也不掉队，防 512KB 截断断代）。 */
  start(refs: () => SessionRef[], intervalMs = 5000): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.feedAll(refs());
    }, intervalMs);
    // 不阻挡进程退出（bun test 场景）；守护进程常驻无影响
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.states.clear();
  }

  /** 喂入全部给定会话（单会话失败不影响其余，错误显式落 stderr）。 */
  async feedAll(refs: SessionRef[]): Promise<void> {
    for (const ref of refs) {
      try {
        await this.feed(ref);
      } catch (e) {
        console.error(`[codearts-bridge] 画面网格喂入失败（refId=${ref.id}）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** 注册会话（daemon 在 listSessions 变化时调用；幂等）。 */
  track(refId: string): void {
    if (!this.states.has(refId)) {
      this.states.set(refId, {
        term: new Terminal({ cols: GRID_COLS, rows: GRID_ROWS, allowProposedApi: true }),
        fedLen: 0,
        fedTail: "",
        rev: 0,
        lastMeta: {},
      });
    }
  }

  /** 会话消亡 → 丢弃网格（下次 track 重建；避免给已死会话持续喂空转）。 */
  untrack(refId: string): void {
    this.states.delete(refId);
  }

  /**
   * 喂入增量并推进网格状态。返回当前 rev（无变化则 rev 不变）。
   * @param ref 会话引用（kind 透传）
   */
  async feed(ref: SessionRef): Promise<number> {
    this.track(ref.id);
    const st = this.states.get(ref.id)!;
    const snap = await this.transport.snapshot(ref);
    const raw = snap.raw;
    // 连续性判定：长度回退 = 会话重建（新 rawBuf）；尾部样本失配 = 前端被截断淘汰
    if (st.fedLen > 0) {
      const tailOk =
        raw.length >= st.fedLen && raw.slice(Math.max(0, st.fedLen - TAIL_SAMPLE), st.fedLen) === st.fedTail;
      if (!tailOk) {
        // 重建语义：清网格从头喂（新缓冲含启动整屏帧）；截断淘汰场景属降级
        // （尽力喂入现存尾部，标注由消费方自行权衡）——两者都不静默丢状态。
        st.term.reset();
        st.fedLen = 0;
        st.fedTail = "";
      }
    }
    if (raw.length > st.fedLen) {
      const delta = st.fedLen === 0 ? raw : raw.slice(st.fedLen);
      await new Promise<void>((resolve) => st.term.write(delta, resolve));
      st.fedLen = raw.length;
      st.fedTail = raw.slice(Math.max(0, st.fedLen - TAIL_SAMPLE), st.fedLen);
      st.rev += 1;
    }
    st.lastMeta = snap.meta;
    return st.rev;
  }

  /**
   * 序列化当前网格为行帧（0 基行号 → ANSI 串；空行缺席）。
   * SGR 逐 run 输出（fg/bg/粗体/斜体/下划线/反显），行首显式复位，杜绝跨行样式泄漏。
   */
  rowsOf(refId: string): RowPair[] {
    const st = this.states.get(refId);
    if (st === undefined) return [];
    const buf = st.term.buffer.active;
    const out: RowPair[] = [];
    for (let y = 0; y < GRID_ROWS; y++) {
      const line = buf.getLine(y);
      if (line === undefined) continue;
      let frame = "\x1b[0m";
      let lastFg = "";
      let lastBg = "";
      let lastAttr = "";
      let wrote = false;
      for (let x = 0; x < GRID_COLS; x++) {
        const cell = line.getCell(x);
        if (cell === undefined) break;
        if (cell.getWidth() === 0) continue; // 宽字符续体
        const fg = sgrOfColor(cell.isFgDefault?.() ?? true, cell.isFgPalette?.() ?? false, cell.isFgRGB?.() ?? false, cell.getFgColor(), 3);
        const bg = sgrOfColor(cell.isBgDefault?.() ?? true, cell.isBgPalette?.() ?? false, cell.isBgRGB?.() ?? false, cell.getBgColor(), 4);
        const attrs = `${cell.isBold?.() ? 1 : 0}${cell.isDim?.() ? 2 : 0}${cell.isItalic?.() ? 3 : 0}${cell.isUnderline?.() ? 4 : 0}${cell.isInverse?.() ? 7 : 0}`;
        if (fg !== lastFg || bg !== lastBg || attrs !== lastAttr) {
          frame += sgrFrame(fg, bg, attrs);
          lastFg = fg;
          lastBg = bg;
          lastAttr = attrs;
        }
        const chars = cell.getChars();
        if (chars.length === 0 && isPlainDefault(cell, fg, bg, attrs)) {
          // 纯默认空白：跳过（默认前景/背景/无属性），行尾自然留白
          continue;
        }
        frame += chars.length === 0 ? " " : chars;
        wrote = true;
      }
      if (wrote) out.push([y, frame]);
    }
    return out;
  }

  /** 当前状态版本（消费方据此判断是否有新帧）。 */
  revisionOf(refId: string): number {
    return this.states.get(refId)?.rev ?? 0;
  }

  /** 最近一次喂入的快照元数据（alive/pid 等；未喂过为空对象）。 */
  metaOf(refId: string): Record<string, unknown> {
    return this.states.get(refId)?.lastMeta ?? {};
  }
}

/** 纯默认空白判定（无任何属性且默认配色）。 */
function isPlainDefault(cell: { getBgColor(): number; isBgDefault?(): boolean }, fg: string, bg: string, attrs: string): boolean {
  void cell;
  return fg === "" && bg === "" && attrs === "00000";
}

/** 颜色 → SGR 参数段（""=默认）。 */
function sgrOfColor(isDefault: boolean, isPalette: boolean, isRGB: boolean, color: number, base: 3 | 4): string {
  if (isDefault || (!isPalette && !isRGB)) return "";
  const code = base === 3 ? 38 : 48;
  if (isRGB) {
    const r = (color >> 16) & 0xff;
    const g = (color >> 8) & 0xff;
    const b = color & 0xff;
    return `${code};2;${r};${g};${b}`;
  }
  return `${code};5;${color}`;
}

/** 属性组 → SGR 序列。 */
function sgrFrame(fg: string, bg: string, attrs: string): string {
  const parts: string[] = ["0"];
  if (attrs[0] === "1") parts.push("1");
  if (attrs[1] === "1") parts.push("2");
  if (attrs[2] === "1") parts.push("3");
  if (attrs[3] === "1") parts.push("4");
  if (attrs[4] === "1") parts.push("7");
  if (fg !== "") parts.push(fg);
  if (bg !== "") parts.push(bg);
  return `\x1b[${parts.join(";")}m`;
}
