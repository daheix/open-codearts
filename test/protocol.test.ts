/**
 * T3-02 完成协议移植测试（bun:test）——语义源：codeartsGUI `tests/test_goalrunner.cpp`
 * 的 22 用例逐条搬运。用例名以【源用例N】标注对应关系；纯状态机/时序语义（看门狗
 * 计时、重试引擎、验收双过编排、断点落盘）落在 T3-03 runner，本文件只钉其协议面，
 * 22 条完整映射表见 task-15-report.md。
 *
 * 语义对齐来源（逐条搬运依据）：
 * - `src/goalprotocol.cpp`：stripAnsi 状态机（v0.2.6 修复：ESC[? 私有标记整体消费）、
 *   parse 标记正则与合法性校验、contract/resume/continue 文案模板逐字保留；
 * - `src/goalrunner.cpp`：stripInjectionEcho 逐行剔除（≥6 字符片段）、
 *   kEchoGuardMs=3000（回显守卫窗口）；
 * - CHANGELOG v0.2.5/v0.2.6：注入回显被误当 AI 完成、抗心跳内容判定、续跑语义统一。
 *
 * 本模块为纯函数测试：无传输/FS/时钟依赖（裁定 R-pg2）；时间相关语义以
 * ECHO_GUARD_MS 常量 + 调用方注入时刻的方式表达（T3-03 runner 消费）。
 */
import { describe, expect, it } from "bun:test";
import {
  CONTINUE_PROMPT,
  ECHO_GUARD_MS,
  GOAL_DONE_MARK,
  GOAL_PLAN_MARK,
  buildContract,
  buildResumeContract,
  hasRealContent,
  parseProgress,
  stripAnsi,
  stripInjectionEcho,
} from "../src/core/goal/protocol";

/* ───── 常量 ───── */

describe("协议常量（与 GUI 逐字一致）", () => {
  it("【源用例18/19/30 协议面】GOAL_PLAN_MARK/GOAL_DONE_MARK/CONTINUE_PROMPT 常量值", () => {
    expect(GOAL_PLAN_MARK).toBe("[GOAL-PLAN]");
    expect(GOAL_DONE_MARK).toBe("[GOAL-DONE]");
    // 停续语义（源用例18）：轻量"继续完成剩余任务"，非重发全文契约
    expect(CONTINUE_PROMPT).toBe("继续完成剩余任务");
  });

  it("【源用例19 协议面】ECHO_GUARD_MS=3000（C++ kEchoGuardMs 移植；窗口判断由调用方注入时刻表达）", () => {
    expect(ECHO_GUARD_MS).toBe(3000);
  });

  it("【源用例18】CONTINUE_PROMPT 不含全文契约字样（非重启：无'目标契约'、不承载目标复述）", () => {
    expect(CONTINUE_PROMPT.includes("目标契约")).toBe(false);
    expect(CONTINUE_PROMPT.includes("最终验收命令")).toBe(false);
  });
});

/* ───── 契约构造（C++ contractPrompt/resumePrompt 逐字搬运） ───── */

describe("buildContract（源：GoalProtocol::contractPrompt）", () => {
  it("【源用例1】契约含目标、验收命令、[GOAL-PLAN]/[GOAL-DONE] 说明与自主推进条款", () => {
    const c = buildContract("实现登录页", ["pytest -q"]);
    expect(c.includes("【/goal 目标契约】")).toBe(true);
    expect(c.includes("目标：实现登录页")).toBe(true);
    expect(c.includes("最终验收命令（必须独立执行并通过）：pytest -q")).toBe(true);
    // FR-7 三标记协议说明（五条执行协议逐字保留）
    expect(c.includes("1. 先输出一行：[GOAL-PLAN] 然后列出编号步骤清单（每步一行 N. 描述）。")).toBe(true);
    expect(c.includes("[GOAL-STEP n/N] 步骤描述 | 推荐方案:")).toBe(true);
    expect(c.includes("5. 全部完成且验收命令通过后，最后一行输出：[GOAL-DONE]")).toBe(true);
    // FR-8：决策自主权条款（检索→自荐→直行，不停下来问）
    expect(c.includes("不要停下来询问我")).toBe(true);
    expect(c.includes("现在开始，先输出 [GOAL-PLAN]。")).toBe(true);
  });

  it("【源用例4 协议面】验收命令独立下发：多条命令逐条各占一行", () => {
    const c = buildContract("目标", ["make test", "bun run typecheck"]);
    expect(c.includes("最终验收命令（必须独立执行并通过）：make test\n")).toBe(true);
    expect(c.includes("最终验收命令（必须独立执行并通过）：bun run typecheck\n")).toBe(true);
  });

  it("空验收清单省略验收块（对齐 C++ acceptance.trimmed().isEmpty() 语义）", () => {
    const c = buildContract("目标", []);
    expect(c.includes("最终验收命令")).toBe(false);
    // 协议说明仍在
    expect(c.includes(GOAL_PLAN_MARK)).toBe(true);
  });

  it("空白验收项跳过（逐项 trimmed 判空，同 C++ 口径）", () => {
    const c = buildContract("目标", ["  ", "\t", "make test"]);
    expect(c.includes("make test")).toBe(true);
    expect(c.match(/最终验收命令/g)?.length).toBe(1);
  });

  it("【源用例22 前提】契约原文自身含 [GOAL-DONE] 字样——parseProgress 直接解析必置 done（回显守卫存在的原因，钉死）", () => {
    const c = buildContract("目标Z", ["true"]);
    expect(parseProgress(c).done).toBe(true);
  });
});

describe("buildResumeContract（源：GoalProtocol::resumePrompt）", () => {
  it("【源用例7/13 协议面】断点续跑契约：含目标、进度 x/y、重列 [GOAL-PLAN] 与 [GOAL-DONE] 指引", () => {
    const r = buildResumeContract({ objective: "目标", doneSteps: [1, 2], totalSteps: 4 });
    expect(r.includes("【/goal 断点续跑】此前对话中断，目标不变。")).toBe(true);
    expect(r.includes("目标：目标")).toBe(true);
    expect(r.includes("进度：已完成 2/4 步")).toBe(true);
    expect(r.includes("请先重新输出 [GOAL-PLAN] 列出全部步骤，并把已完成步骤标注（完成）")).toBe(true);
    expect(r.includes("完成后 [GOAL-DONE]")).toBe(true);
  });

  it("totalSteps 缺省 → 以已知最大完成步号近似总数（仅文案近似，权威进度在 T3-03 runner 状态）", () => {
    expect(buildResumeContract({ objective: "g", doneSteps: [1, 2, 3] }).includes("进度：已完成 3/3 步")).toBe(true);
    expect(buildResumeContract({ objective: "g", doneSteps: [] }).includes("进度：已完成 0/0 步")).toBe(true);
  });
});

/* ───── parseProgress（源：GoalProtocol::parse） ───── */

describe("parseProgress：步骤行与完成标记", () => {
  it("【源用例2】步骤行 \"[GOAL-STEP 1/3] 调研 | 推荐方案: 检索最优解\" 解析出 n=1/title=调研；title 不含推荐方案", () => {
    const p = parseProgress("[GOAL-STEP 1/3] 调研 | 推荐方案: 检索最优解");
    expect(p.steps.length).toBe(1);
    expect(p.steps[0]?.n).toBe(1);
    expect(p.steps[0]?.title).toBe("调研");
    expect(p.done).toBe(false);
  });

  it("【源用例2】plan 提取：\"[GOAL-PLAN] 1.调研 2.实现 3.测试\" 行内编号清单", () => {
    const p = parseProgress("[GOAL-PLAN] 1.调研 2.实现 3.测试");
    expect(p.plan).toEqual(["调研", "实现", "测试"]);
  });

  it("plan 提取：多行编号清单（契约规定的'每步一行 N. 描述'形态），非编号行截止", () => {
    const p = parseProgress("[GOAL-PLAN]\n1. 调研需求\n2. 实现功能\n3. 测试验收\n以上请确认。");
    expect(p.plan).toEqual(["调研需求", "实现功能", "测试验收"]);
  });

  it("无 [GOAL-PLAN] → plan 为 undefined（可选字段不产空数组）", () => {
    expect(parseProgress("普通输出").plan).toBeUndefined();
    expect(parseProgress("[GOAL-PLAN] 后面没写清单").plan).toBeUndefined();
  });

  it("【源用例3】[GOAL-DONE] 置 done=true；无标记文本 done=false", () => {
    expect(parseProgress("[GOAL-DONE] 全部完成").done).toBe(true);
    expect(parseProgress("工作中，尚未完成").done).toBe(false);
  });

  it("【源用例11 协议面】普通推进文字：有内容但无标记 → steps 空、done=false（是否推进由 runner 编排）", () => {
    const p = parseProgress("filler output line without markers 0123");
    expect(p.steps.length).toBe(0);
    expect(p.done).toBe(false);
  });

  it("步骤行校验：n/tot 非法（cur<1、cur>tot、tot<=0）不产步骤（C++ tot>0 && 1<=cur<=tot 同语义）", () => {
    expect(parseProgress("[GOAL-STEP 0/3] 零号").steps.length).toBe(0);
    expect(parseProgress("[GOAL-STEP 4/3] 越界").steps.length).toBe(0);
    expect(parseProgress("[GOAL-STEP 1/0] 零总步").steps.length).toBe(0);
  });

  it("【源用例12】含 timeout 字样的进度标记不误判：标记照常解析（进度优先语义的协议面）", () => {
    const p = parseProgress("[GOAL-STEP 1/2] 配置请求 timeout 参数 | 推荐方案: x");
    expect(p.steps.length).toBe(1);
    expect(p.steps[0]?.title).toBe("配置请求 timeout 参数");
    expect(p.done).toBe(false);
  });

  it("多步骤行聚合：全部 [GOAL-STEP] 按出现序收集（C++ 有状态只取首个，TS 无状态聚合——分歧见报告）", () => {
    const p = parseProgress("[GOAL-STEP 1/2] 调研 | 推荐方案: A\n[GOAL-STEP 2/2] 实现 | 推荐方案: B");
    expect(p.steps.length).toBe(2);
    expect(p.steps[0]?.n).toBe(1);
    expect(p.steps[1]?.n).toBe(2);
    expect(p.steps[1]?.title).toBe("实现");
  });

  it("容错与 C++ 正则一致：全角冒号'推荐方案：'、斜杠周围空格 '[GOAL-STEP 2/ 3]'", () => {
    const p1 = parseProgress("[GOAL-STEP 2/3] 实现 | 推荐方案：直接编码");
    expect(p1.steps[0]?.title).toBe("实现");
    const p2 = parseProgress("[GOAL-STEP 2/ 3] 实现");
    expect(p2.steps[0]?.n).toBe(2);
    expect(p2.steps[0]?.title).toBe("实现");
  });

  it("ANSI 打断标记不破坏解析（C++ parse 内部先 stripAnsi 同语义）", () => {
    expect(parseProgress("[GOAL-DO\x1b[2KNE] 完成").done).toBe(true);
    expect(parseProgress("[GOAL-STEP 1\x1b[?25h/2] 实现").steps.length).toBe(1);
  });
});

/* ───── stripAnsi（源：GoalProtocol::stripAnsi 状态机逐分支搬运） ───── */

describe("stripAnsi：ANSI/VT 转义剥离", () => {
  it("【源用例14/17·v0.2.6 回归】ESC[?25h / ESC[?2026h 私有标记整体消费，无 '2026h'/'25h' 残留", () => {
    expect(stripAnsi("\x1b[?25h")).toBe("");
    expect(stripAnsi("\x1b[?2026h")).toBe("");
    expect(stripAnsi("a\x1b[?2026hb")).toBe("ab");
    expect(stripAnsi("\x1b[0;3H\x1b[?25h\x1b[0m")).toBe("");
  });

  it("CSI 完整语法：参数/中间字节先吃、终结字节收尾；无终结字节消费至串尾（禁残留污染）", () => {
    expect(stripAnsi("\x1b[1;31mred\x1b[0m")).toBe("red");
    expect(stripAnsi("\x1b[2J\x1b[Hcleared")).toBe("cleared");
    expect(stripAnsi("x\x1b[12")).toBe("x"); // 截断的 CSI：参数被吞至串尾
  });

  it("OSC：BEL(0x07) 终结与 ST(ESC\\) 终结；未终结消费至串尾", () => {
    expect(stripAnsi("\x1b]0;window title\x07ok")).toBe("ok");
    expect(stripAnsi("\x1b]2;title\x1b\\ok")).toBe("ok");
    expect(stripAnsi("\x1b]0;未终结尾部")).toBe("");
  });

  it("DCS/APC/PM/SOS 至 ST 终结；单字符 ESC 序列丢弃；串尾孤立 ESC 丢弃", () => {
    expect(stripAnsi("\x1bP1;2qdata\x1b\\ok")).toBe("ok"); // DCS
    expect(stripAnsi("\x1b^privacy\x1b\\ok")).toBe("ok"); // PM
    expect(stripAnsi("a\x1b=b")).toBe("ab"); // 单字符 ESC =
    expect(stripAnsi("abc\x1b")).toBe("abc"); // 串尾孤立 ESC
  });

  it("普通文本原样保留（含中文/数字/换行/标点）", () => {
    expect(stripAnsi("中文 123\nnext | line")).toBe("中文 123\nnext | line");
  });
});

/* ───── hasRealContent（v0.2.6 教训：逐字符 isLetterOrNumber + CJK 区间） ───── */

describe("hasRealContent：内容判定", () => {
  it("【源用例14】抗心跳：纯 CSI/私有标记串（转轮+心跳控制帧）→ false", () => {
    expect(hasRealContent("\x1b[?2026h\x1b[0;3H\x1b[?25h\x1b[0m")).toBe(false);
  });

  it("【源用例17/20/21】转轮帧剥离后为标点/符号 → false（逐字符判定的教训所在）", () => {
    expect(hasRealContent("\x1b[2K\r-")).toBe(false);
    expect(hasRealContent("\x1b[2K\r|")).toBe(false);
    expect(hasRealContent("\x1b[3;6H\x1b[?25h")).toBe(false);
  });

  it("纯退格符/空白/标点 → false", () => {
    expect(hasRealContent("\b")).toBe(false);
    expect(hasRealContent("  \t\n")).toBe(false);
    expect(hasRealContent("···")).toBe(false);
    expect(hasRealContent("——……")).toBe(false);
  });

  it("【源用例20】CJK 与字母数字 → true（中文必须算真实内容）", () => {
    expect(hasRealContent("会话已停止 · interrupted")).toBe(true);
    expect(hasRealContent("调研")).toBe(true);
    expect(hasRealContent("step 1")).toBe(true);
    expect(hasRealContent("42")).toBe(true);
    expect(hasRealContent("ＡＢ全角")).toBe(true);
  });

  it("【源用例15/16 协议面】真实推进文字 → true（是否'有新步进'由 runner 据此判活）", () => {
    expect(hasRealContent("running ... step progress text 5")).toBe(true);
    expect(hasRealContent("filler output line without markers 0123")).toBe(true);
  });
});

/* ───── stripInjectionEcho（源：GoalRunner::stripInjectionEcho 逐行剔除） ───── */

describe("stripInjectionEcho：注入回显剥离", () => {
  it("【源用例22·e2e 回归】注入契约回显（含 [GOAL-DONE] 字样）剥离后 parseProgress 不产生 done", () => {
    const contract = buildContract("目标Z", ["true"]);
    const echoed = contract; // 终端把注入文本原样回显
    // 不剥离必误判（v0.2.5 修复前的一启动即 Verifying 缺陷，钉死病灶）
    expect(parseProgress(echoed).done).toBe(true);
    // 剥离后干净
    const cleaned = stripInjectionEcho(echoed, [contract]);
    const p = parseProgress(cleaned);
    expect(p.done).toBe(false);
    expect(p.steps.length).toBe(0);
    expect(p.plan).toBeUndefined();
  });

  it("【源用例5 协议面】验收失败重发文案回显（含'完成后再次输出 [GOAL-DONE]'）剥离后 done=false", () => {
    const refeed =
      "验收未通过：1 个断言失败\n请分析失败原因，修正后继续执行，完成后再次输出 [GOAL-DONE]。";
    const cleaned = stripInjectionEcho(`噪声前缀\n${refeed}\n噪声后缀`, [refeed]);
    expect(parseProgress(cleaned).done).toBe(false);
  });

  it("逐行剔除抗换行重排：注入文本每行(≥6 字符)片段全移除；<6 字符行不动（C++ key.size()>=6 同语义）", () => {
    const injected = "第一行注入内容较长\n短行\n第二行注入内容也长";
    const cleaned = stripInjectionEcho(
      "前缀 第一行注入内容较长 中缀 短行 保留 后缀 第二行注入内容也长",
      [injected],
    );
    expect(cleaned.includes("第一行注入内容较长")).toBe(false);
    expect(cleaned.includes("第二行注入内容也长")).toBe(false);
    expect(cleaned.includes("短行")).toBe(true);
  });

  it("空注入清单/空注入串原样返回（C++ isEmpty skip 同语义）", () => {
    expect(stripInjectionEcho("abc", [])).toBe("abc");
    expect(stripInjectionEcho("abc", [""])).toBe("abc");
  });

  it("【源用例19 组合语义】注入回显剥离后，真实 AI 输出的步骤与完成标记完好（feed 顺序契约：先剥离再解析）", () => {
    const contract = buildContract("完成任务", ["true"]);
    const real = "[GOAL-STEP 1/2] 步骤一 | 推荐方案: A\n[GOAL-DONE] 全部完成";
    const p = parseProgress(stripInjectionEcho(`${contract}\n${real}`, [contract]));
    expect(p.steps.length).toBe(1);
    expect(p.steps[0]?.title).toBe("步骤一");
    expect(p.done).toBe(true);
  });
});
