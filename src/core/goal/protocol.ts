/**
 * /goal 完成协议——纯函数模块（T3-02，自 codeartsGUI 逐条移植）。
 *
 * 语义源（逐条搬运，分歧清单见 task-15-report.md）：
 * - `codeartsGUI/src/goalprotocol.cpp`：stripAnsi 状态机、标记正则与校验、
 *   contract/resume/continue 文案模板（逐字保留）；
 * - `codeartsGUI/src/goalrunner.cpp`：stripInjectionEcho 逐行剔除、kEchoGuardMs=3000；
 * - `codeartsGUI/CHANGELOG.md` v0.2.5/v0.2.6：注入回显误判修复、ESC[? 私有标记
 *   消费修复、hasRealContent 逐字符 isLetterOrNumber + CJK 区间（抗心跳/静态重绘）。
 *
 * 裁定落点：
 * - R-pg1（逐条搬运）：22 个 goalrunner 用例语义逐条对应 test/protocol.test.ts
 *   （用例名以【源用例N】注明）；纯状态机/时序语义（看门狗计时、重试引擎、
 *   验收编排）落 T3-03 runner，本模块只提供其协议面。
 * - R-pg2（纯函数）：本模块不 import 传输/FS/时钟；时间相关语义（回显守卫 3s
 *   窗口）以 ECHO_GUARD_MS 常量 + 调用方注入时刻表达，保持可测。
 *
 * 调用方顺序契约（对齐 C++ GoalRunner::feed，T3-03 必须遵守）：
 *   1) `stripInjectionEcho(raw, recentInjections)` 剔除自身注入回显；
 *   2) `parseProgress(已剥离文本)` 解析步骤/完成标记；
 *   3) 若 `nowMs - injectedAtMs < ECHO_GUARD_MS`，作废解析结果中的 done
 *      （注入回显里的 [GOAL-DONE] 是协议说明，非 AI 申报——v0.2.5 e2e 实证）。
 */
/* ───── 协议常量（与 GUI 逐字一致） ───── */

/** 计划标记（C++ parse 的 `\[GOAL-PLAN\]` 字面）。 */
export const GOAL_PLAN_MARK = "[GOAL-PLAN]";

/** 完成标记（C++ parse 的 `\[GOAL-DONE\]` 字面）。 */
export const GOAL_DONE_MARK = "[GOAL-DONE]";

/**
 * 轻量续跑指令（v0.2.6 续跑语义统一）：会话活着、上下文仍在时只发这一句，
 * 不重发全文契约；只有会话进程真死（Recovering）才重发完整断点续跑契约。
 */
export const CONTINUE_PROMPT = "继续完成剩余任务";

/**
 * 注入后回显守卫窗口毫秒数（C++ GoalRunner::kEchoGuardMs=3000 移植）。
 * 窗口判断本身不在本模块（时间由调用方注入）：`nowMs - injectedAtMs < ECHO_GUARD_MS`
 * 即守卫活跃，其间作废 done 标记（真实场景回显瞬时、AI 响应有延迟，可干净区分）。
 */
export const ECHO_GUARD_MS = 3000;

/* ───── stripAnsi（源：goalprotocol.cpp 状态机逐分支搬运） ───── */

const ESC = 0x1b;
const BEL = 0x07;

/**
 * 剥离 ANSI/VT 转义序列（按 UTF-16 码元逐个消费，与 QChar 遍历同粒度）：
 * - CSI（`ESC [` + 参数/中间字节 0x20-0x3F + 终结字节 0x40-0x7E）：必须先吃参数/
 *   中间字节（含私有标记 `?`、分号、数字）再吃一个终结字节——否则 `ESC[?2026h`
 *   会残留 "2026h" 污染内容判定与遍历（v0.2.6 修复的抗心跳失效根因）；
 * - OSC（`ESC ]` … BEL 或 `ESC \`）：标题/剪贴板等串；
 * - DCS/APC/PM/SOS（`ESC P/^/_/X` … `ESC \`）；
 * - 单字符 ESC 序列（如 `ESC =` / `ESC >`）与串尾孤立 ESC：直接丢弃。
 */
export function stripAnsi(text: string): string {
  const out: string[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text.charCodeAt(i) !== ESC) {
      out.push(text[i] as string);
      i += 1;
      continue;
    }
    // ESC 已消费：判别后续序列类型
    if (i + 1 >= n) break; // 串尾孤立 ESC：丢弃
    const k = text.charCodeAt(i + 1);
    if (k === 0x5b) {
      // '['：CSI——先吃参数/中间字节，再吃一个终结字节；无终结字节则吃到串尾
      i += 2;
      while (i < n) {
        const ch = text.charCodeAt(i);
        if (ch >= 0x20 && ch <= 0x3f) {
          i += 1; // 参数/中间字节（含 ?、;、数字）
          continue;
        }
        if (ch >= 0x40 && ch <= 0x7e) {
          i += 1; // 终结字节
        }
        break;
      }
    } else if (k === 0x5d) {
      // ']'：OSC——至 BEL 或 ESC \（ST）
      i += 2;
      while (i < n) {
        const ch = text.charCodeAt(i);
        if (ch === BEL) {
          i += 1;
          break;
        }
        if (ch === ESC && i + 1 < n && text.charCodeAt(i + 1) === 0x5c) {
          i += 2;
          break;
        }
        i += 1;
      }
    } else if (k === 0x50 || k === 0x5e || k === 0x5f || k === 0x58) {
      // P ^ _ X：DCS/APC/PM/SOS——至 ST
      i += 2;
      while (i < n) {
        const ch = text.charCodeAt(i);
        if (ch === ESC && i + 1 < n && text.charCodeAt(i + 1) === 0x5c) {
          i += 2;
          break;
        }
        i += 1;
      }
    } else {
      // 单字符 ESC 序列：直接丢弃
      i += 2;
    }
  }
  return out.join("");
}

/* ───── hasRealContent（v0.2.6 教训：逐字符判定，空白/标点不算内容） ───── */

/** CJK 表意文字区间（码点）：显式收录常用四段（与正则属性互为补充，口径见头注）。 */
const CJK_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意文字
  [0xf900, 0xfaff], // CJK 兼容表意文字
  [0x20000, 0x2a6df], // CJK 扩展 B
];

/** 单字符判定：ASCII 字母/数字快路径 + CJK 区间 + Unicode 字母/数字属性（等价 QChar::isLetterOrNumber）。 */
function isLetterOrNumberChar(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  if ((cp >= 0x30 && cp <= 0x39) || (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
    return true;
  }
  for (const [lo, hi] of CJK_RANGES) {
    if (cp >= lo && cp <= hi) return true;
  }
  return /\p{L}|\p{N}/u.test(ch);
}

/**
 * 判断一段（可能混有转义序列的）终端输出是否含"真实内容"：
 * 先 stripAnsi，再逐字符（按 Unicode 码点）检查是否出现字母或数字（含 CJK）。
 * 纯控制序列、转轮帧（`-`/`|` 等标点）、退格、空白 → false；中文/字母/数字 → true。
 * v0.2.6 教训：以"有文字输出"判活会被静态重绘与控制帧永久欺骗，必须逐字符判定。
 */
export function hasRealContent(text: string): boolean {
  const clean = stripAnsi(text);
  for (const ch of clean) {
    if (isLetterOrNumberChar(ch)) return true;
  }
  return false;
}

/* ───── parseProgress（源：goalprotocol.cpp parse 正则逐条搬运） ───── */

/** 步骤行解析结果的单个步骤（title 已剔除 "| 推荐方案: …" 尾巴并 trim）。 */
export interface ParsedStep {
  /** 步骤序号（1 基）。 */
  n: number;
  /** 步骤描述。 */
  title: string;
}

/** parseProgress 结果：计划清单（可选）、步骤聚合、完成标记。 */
export interface ParsedProgress {
  /** [GOAL-PLAN] 后的编号步骤清单；无标记或未给出清单 → undefined。 */
  plan?: string[];
  /** 文中全部 [GOAL-STEP n/N] 行（按出现序聚合）。 */
  steps: ParsedStep[];
  /** 是否出现 [GOAL-DONE]（真伪由调用方剥离回显并施加守卫后裁定）。 */
  done: boolean;
}

/**
 * 步骤行正则（C++ 同源）：`[GOAL-STEP n/N] 标题 [| 推荐方案: 摘要]`。
 * 容错：n/N 斜杠周围允许空白；推荐方案冒号全/半角皆可。推荐方案捕获组在 TS
 * 接口中不外露（任务书固定 steps 形状，只取 n/title；title 语义与 C++ 一致）。
 */
const GOAL_STEP_RE =
  /\[GOAL-STEP\s+(\d+)\s*\/\s*(\d+)\]\s*([^|\r\n]*?)(?:\s*\|\s*推荐方案[:：]\s*(.+))?\s*$/gm;

/** 整行编号清单项（plan 提取的后续行形态：契约规定"每步一行 N. 描述"）。 */
const PLAN_ITEM_LINE_RE = /^\s*(\d+)\s*[.、)．]\s*(.+?)\s*$/;

/** 行内编号项起点（plan 提取的首行形态：如 "[GOAL-PLAN] 1.调研 2.实现 3.测试"）。 */
const PLAN_ITEM_START_RE = /(?:^|(?<=\s))(\d+)\s*[.、)．]\s*/g;

/**
 * 提取 [GOAL-PLAN] 之后的编号步骤清单：
 * - 首行（与标记同行余文）：按行内编号项切分（数字编号 + . 、 ) ．之一 + 空白）；
 * - 后续行：整行编号项逐行收集，首个非编号行截止；
 * - 提取结果为空 → 返回空数组（由调用方决定 plan 是否缺省）。
 * 注：编号形似项（如"共 3.5 万"）可能被误认为编号项——plan 为提示性字段，
 * 权威进度以 [GOAL-STEP] 标记为准（C++ 从不解析计划清单，此为 TS 侧扩展，
 * 分歧已登记）。
 */
function extractPlanItems(rest: string): string[] {
  const items: string[] = [];
  const lines = rest.split("\n");

  // 首行：行内编号项（记录每个编号项的标题起点与下一项起点，切片收集）
  const first = lines[0];
  if (first !== undefined) {
    const titleStarts: number[] = [];
    const matchStarts: number[] = [];
    const re = new RegExp(PLAN_ITEM_START_RE.source, "g"); // 每次新建，防 lastIndex 串扰
    let m: RegExpExecArray | null = re.exec(first);
    while (m !== null) {
      matchStarts.push(m.index);
      titleStarts.push(m.index + m[0].length);
      m = re.exec(first);
    }
    for (let idx = 0; idx < titleStarts.length; idx += 1) {
      const end = idx + 1 < matchStarts.length ? matchStarts[idx + 1] as number : first.length;
      const title = first.slice(titleStarts[idx] as number, end).trim();
      if (title !== "") items.push(title);
    }
  }

  // 后续行：整行编号项，首个非编号行截止
  for (let li = 1; li < lines.length; li += 1) {
    const lm = PLAN_ITEM_LINE_RE.exec(lines[li] as string);
    if (lm === null) break;
    const title = lm[2];
    if (title !== undefined) {
      const t = title.trim();
      if (t !== "") items.push(t);
    }
  }
  return items;
}

/**
 * 解析一段终端文本中的 /goal 协议标记（对齐 C++ GoalProtocol::parse）：
 * - 内部先 stripAnsi（容忍标记被转义序列打断；编码规范化是传输层职责，协议层不碰）；
 * - done：文本含 [GOAL-DONE] 字面（**调用方必须先剥离注入回显**——契约/续跑文案
 *   自身含该字样，v0.2.5 实证不剥离必误判）；
 * - steps：全部合法步骤行（校验同 C++：tot > 0 且 1 ≤ n ≤ tot，非法行整体忽略）；
 * - plan：[GOAL-PLAN] 后的编号清单（无标记或未给清单 → undefined）。
 */
export function parseProgress(text: string): ParsedProgress {
  const clean = stripAnsi(text);
  const done = clean.includes(GOAL_DONE_MARK);

  const steps: ParsedStep[] = [];
  for (const m of clean.matchAll(GOAL_STEP_RE)) {
    const cur = Number.parseInt(m[1] as string, 10);
    const tot = Number.parseInt(m[2] as string, 10);
    if (!(tot > 0) || cur < 1 || cur > tot) continue; // 非法步骤行整体忽略（C++ 同语义）
    const title = m[3];
    if (title === undefined) continue; // 正则保证存在；防御 noUncheckedIndexedAccess
    steps.push({ n: cur, title: title.trim() });
  }

  let plan: string[] | undefined;
  const planIdx = clean.indexOf(GOAL_PLAN_MARK);
  if (planIdx >= 0) {
    const items = extractPlanItems(clean.slice(planIdx + GOAL_PLAN_MARK.length));
    if (items.length > 0) plan = items;
  }

  return plan === undefined ? { steps, done } : { plan, steps, done };
}

/* ───── stripInjectionEcho（源：goalrunner.cpp 逐行剔除，逐条搬运） ───── */

/**
 * 把已注入的文本从原始输出里整段剔除，避免其回显被当作 AI 输出解析
 * （C++ GoalRunner::stripInjectionEcho 同语义）：
 * - 对每段注入文本按行拆分（跳过空行），行 trim 后长度 ≥6 的片段从输出中
 *   全部移除（QString::remove 语义 = 移除所有出现）；<6 字符的短行不剔除
 *   （防误伤正常文本）；
 * - 注入可能多行且终端会重排，故逐行剔除以抗换行差异；跨行断词的局部回显
 *   由 ECHO_GUARD_MS 守卫窗口兜住（两层防御，均与 GUI 一致）。
 * `injected` 由调用方维护为"最近注入"（C++ 侧上限 6 条；窗口策略属 runner）。
 */
export function stripInjectionEcho(text: string, injected: string[]): string {
  let out = text;
  for (const inj of injected) {
    if (inj === "") continue;
    for (const line of inj.split("\n")) {
      if (line === "") continue; // Qt::SkipEmptyParts 同语义
      const key = line.trim();
      if (key.length >= 6) out = out.split(key).join("");
    }
  }
  return out;
}

/* ───── 契约文案构造（源：goalprotocol.cpp contract/resume 模板逐字搬运） ───── */

/** 执行协议条款（C++ contractPrompt 逐字保留；FR-7 三标记 + FR-8 决策自主权）。 */
const CONTRACT_PROTOCOL_BODY = `

执行协议（严格遵守）：
1. 先输出一行：[GOAL-PLAN] 然后列出编号步骤清单（每步一行 N. 描述）。
2. 每开始一步输出：[GOAL-STEP n/N] 步骤描述 | 推荐方案: 你检索并整理出的最优方案摘要。
3. 遇到方案选型/技术决策，先用 websearch/webfetch 检索，整理出最优解与理由，然后直接采用推荐方案继续执行，不要停下来询问我。
4. 小步推进：每完成一步立即开始下一步，不要等待确认。
5. 全部完成且验收命令通过后，最后一行输出：[GOAL-DONE]

现在开始，先输出 [GOAL-PLAN]。
`;

/**
 * 构造 /goal 目标契约（首条注入）：目标全文 + 验收命令 + 三标记协议 + 决策自主权条款。
 * 对齐 C++ contractPrompt：验收命令为空（或全空白）时省略验收块；多条命令逐条
 * 各占一行（C++ 单条 acceptance 的 TS 扩展，语义分歧已登记）。
 *
 * @param objective 目标全文
 * @param verify    独立验收命令清单（每条必须独立执行并通过）
 */
export function buildContract(objective: string, verify: string[]): string {
  let p = "【/goal 目标契约】\n";
  p += `目标：${objective}\n`;
  const cmds = verify.map((v) => v.trim()).filter((v) => v !== "");
  for (const cmd of cmds) {
    p += `最终验收命令（必须独立执行并通过）：${cmd}\n`;
  }
  p += CONTRACT_PROTOCOL_BODY;
  return p;
}

/** buildResumeContract 的状态形状（任务书接口；lastStepTitle 未纳入，分歧已登记）。 */
export interface ResumeState {
  /** 目标全文（不变）。 */
  objective: string;
  /** 已完成步骤号清单（长度 = 已完成步数）。 */
  doneSteps: number[];
  /** 总步数；缺省时以已知最大完成步号近似（仅文案近似，权威进度在 runner 状态）。 */
  totalSteps?: number;
}

/**
 * 构造断点续跑契约（会话重建后注入）：目标 + 已完成进度 + 重列计划并从断点继续。
 * 对齐 C++ resumePrompt 文案；doneSteps/totalSteps 缺省口径见 ResumeState 注释。
 */
export function buildResumeContract(state: ResumeState): string {
  const doneCount = state.doneSteps.length;
  const total = state.totalSteps ?? (doneCount > 0 ? Math.max(...state.doneSteps) : 0);
  let p = "【/goal 断点续跑】此前对话中断，目标不变。\n";
  p += `目标：${state.objective}\n`;
  p += `进度：已完成 ${doneCount}/${total} 步`;
  p += "\n请先重新输出 [GOAL-PLAN] 列出全部步骤，并把已完成步骤标注（完成），然后从中断处按协议继续执行（[GOAL-STEP n/N] … | 推荐方案: … → 完成后 [GOAL-DONE]）。\n";
  return p;
}
