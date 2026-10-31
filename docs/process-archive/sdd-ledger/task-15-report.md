# Task 15 报告：完成协议移植（T3-02）

- **Status**: DONE
- **Commit**: `b73ae61ff0` `codearts-bridge(T3-02): 完成协议移植 — 契约/步骤解析/回显守卫/ANSI 边界，对齐 22 用例语义`
- **验证**: `bun test` 332 计数（331 pass + 1 skip）/ 0 fail / 1461 expect（基线 296 全保留，本任务新增 36）；`bun run typecheck` rc=0

## 1. 实现内容

`plugins/codearts-bridge/src/core/goal/protocol.ts`（349 行，**零 import 纯函数模块**，裁定 R-pg2）：

| 导出 | 源语义 |
|------|--------|
| `GOAL_PLAN_MARK` / `GOAL_DONE_MARK` | C++ parse 的 `\[GOAL-PLAN\]` / `\[GOAL-DONE\]` 字面 |
| `CONTINUE_PROMPT = "继续完成剩余任务"` | v0.2.6 续跑语义统一：会话活着只发轻量继续，不重发全文契约 |
| `ECHO_GUARD_MS = 3000` | C++ `GoalRunner::kEchoGuardMs` 移植；窗口判断由调用方注入时刻表达（`nowMs - injectedAtMs < ECHO_GUARD_MS`），本模块不碰时钟（R-pg2） |
| `buildContract(objective, verify: string[])` | `contractPrompt` 模板逐字搬运；验收命令多条逐行（C++ 单条的 TS 扩展）；空/全空白清单省略验收块（同 C++ `trimmed().isEmpty()`） |
| `buildResumeContract(state)` | `resumePrompt` 模板逐字搬运；`totalSteps` 缺省时以已知最大完成步号近似（注释声明仅为文案近似，权威进度在 T3-03 runner） |
| `parseProgress(text)` | `parse` 正则逐条搬运（步骤行正则同源、合法性校验 `tot>0 && 1≤n≤tot` 同语义、内部先 stripAnsi）；plan 提取为 TS 侧新增（见分歧表） |
| `stripInjectionEcho(text, injected)` | `GoalRunner::stripInjectionEcho` 逐条搬运：按行拆分（跳空行）、trim 后 ≥6 字符片段全量移除（`QString::remove` 语义）、短行不动 |
| `hasRealContent(text)` | v0.2.6 教训：先 stripAnsi 再逐码点判定——ASCII 字母数字快路径 + CJK 四区间显式收录 + `\p{L}\p{N}` 兜全（等价 `QChar::isLetterOrNumber`） |
| `stripAnsi(text)`（测试子弹要求导出） | 状态机逐分支搬运：CSI 参数/中间字节（0x20-0x3F，**含 `?` 私有标记**）先吃再吃终结字节（v0.2.6 修复）、OSC BEL/ST、DCS/APC/PM/SOS、单字符 ESC、串尾孤立 ESC |

文件头注钉死**调用方顺序契约**（对齐 C++ `GoalRunner::feed`，T3-03 必须遵守）：剥离回显 → 解析 → 守卫窗口内作废 done。

## 2. 22 用例对照表（源：`test_goalrunner.cpp`，测试名以【源用例N】标注）

| # | 源用例 | 协议面落点（protocol.test.ts） | 语义落点 |
|---|--------|-------------------------------|----------|
| 1 | 启动即下发契约并落盘断点 | buildContract 含目标/验收命令/[GOAL-PLAN]/[GOAL-DONE]/自主推进条款 | 契约=protocol；落盘=T3-03 |
| 2 | 步进标记推进进度 | 步骤行解析 n=1/title=调研（不含推荐方案）+ plan 行内清单提取 | protocol |
| 3 | 收到 GOAL-DONE 进入验收核验 | `[GOAL-DONE]` 置 done=true；无标记 false | 标记=protocol；验收编排=T3-03 |
| 4 | 判据双过→100% | 验收命令独立随契约下发；done 仅由标记字面产生 | 双过编排=T3-03 |
| 5 | 判据不过→注入失败原因继续 | "验收未通过…再次输出 [GOAL-DONE]" 文案回显剥离后 done=false | refeed 注入=T3-03 |
| 6 | 模型错误永久重试 | ——（classifyModelError 不在本任务接口，随 T3-03 runner 移植） | T3-03 |
| 7 | 会话死亡→Recovering 断点续跑 | buildResumeContract：断点续跑头/目标/进度 x/y/重列 [GOAL-PLAN]/[GOAL-DONE] | 状态机=T3-03 |
| 8 | 断点文件损坏重置 | ——（FS/状态机，无协议面） | T3-03 |
| 9 | 看门狗 60s 无输出强制续跑 | ECHO_GUARD_MS/CONTINUE_PROMPT 常量钉死 | 计时=T3-03 |
| 10 | 'info timeout' 识别重试 | ——（同 #6） | T3-03 |
| 11 | Driving 阶段出错也重试 | ——（同 #6） | T3-03 |
| 12 | 含 timeout 的进度标记不误判 | 步骤行照常解析（title="配置请求 timeout 参数"），进度优先语义的协议面 | 优先级编排=T3-03 |
| 13 | 中断→restart 后看门狗兜底 | 同 #7（resume 契约面） | 计时=T3-03 |
| 14 | 抗心跳：纯转轮/控制帧仍判停滞 | `ESC[?2026h…ESC[0m` 串 hasRealContent=false（v0.2.6 回归）+ 无 '2026h' 残留 | protocol 核心 |
| 15 | Driving 无新 GOAL-STEP 90s 判卡 | filler 文字 hasRealContent=true 且解析零标记 | 判活=T3-03 |
| 16 | 真实输出变化不打断长步骤 | "running … text 5" hasRealContent=true、零标记 | 判活=T3-03 |
| 17 | 静态重绘+无进展判停 | `ESC[3;6H ESC[?25h` → stripAnsi=""、hasRealContent=false | protocol 核心 |
| 18 | 停续=发'继续完成剩余任务'非全文契约 | CONTINUE_PROMPT 逐字 = "继续完成剩余任务"，不含"目标契约"/验收块 | 注入决策=T3-03 |
| 19 | 自愈闭环（ESC→继续→恢复→往复） | ECHO_GUARD_MS=3000 + 组合用例（回显剥离后真实步骤/完成标记完好） | 循环=T3-03 |
| 20 | 新 TUI 空闲重绘文字仍能续跑 | "会话已停止 · interrupted" hasRealContent=**true**（诚实钉死：该函数判定的是"真实文字"，重绘防骗靠 runner 变更检测——语义不假装） | 变更检测=T3-03 |
| 21 | 转轮高频输出不打断 | `ESC[2K\r-` / `ESC[2K\r\|` → false（标点非字母数字） | protocol 核心 |
| 22 | 不把自身注入回显当 AI 完成（e2e） | 契约回显剥离后 done=false/steps=0/plan=undefined；**不剥离必误判 done=true（病灶钉死）** | protocol 核心 |

任务书 Step1 五条测试子弹全部覆盖（#1/#2/#22/#14-17/#14 组）。

## 3. TDD 证据

- **RED**：`bun test test/protocol.test.ts` → `error: Cannot find module '../src/core/goal/protocol'`，0 pass / 1 fail。
- **GREEN**：实现后同命令 → **36 pass / 0 fail**（98 expect）。
- **变异验证**（证明测试真实咬合）：把 CSI 参数区从 `0x20-0x3F` 改为 `0x30-0x3E`（重新引入 v0.2.6 的 `ESC[?` 私有标记残留 bug）→ **32 pass / 4 fail**（正中私有标记回归组）；复原后 36 pass。第一次变异尝试（`0x30-0x3F`）未致红——该变异只影响中间字节区（0x20-0x2F），测试未覆盖且现有用例不依赖，如实记录不掩盖。
- **全量**：`bun test` 332 计数 / 0 fail；`bun run typecheck` rc=0。

## 4. 文件清单

- 新增 `plugins/codearts-bridge/src/core/goal/protocol.ts`（349 行）
- 新增 `plugins/codearts-bridge/test/protocol.test.ts`（296 行，36 用例）
- 均远低于单文件 ≤1000 行门禁；提交只含 `plugins/codearts-bridge`，未触碰 `opencode.json`（已裁定 dev 接线）与 `.codeartsdoer/package.json`（他人既有改动）。

## 5. 语义分歧清单（R-pg1 要求逐条列明）

| 分歧 | 对齐理由 |
|------|----------|
| `parseProgress` 返回聚合 `{plan?, steps[], done}`，C++ `parse` 返回单标记 `GoalMarkers`（首个步骤行） | 任务书接口固定；C++ 有状态（Runner 逐 feed 增量），TS 无状态聚合，`steps[0]` 即 C++ 首匹配语义 |
| `plan?: string[]` 计划清单提取为 TS 新增（C++ 只判 hasPlan 布尔） | 任务书接口含 `plan?`；编号形似项（如"共 3.5 万"）理论可误判——已在代码注释声明 plan 为提示性字段，权威进度以 [GOAL-STEP] 为准 |
| steps 形状 `{n,title}` 不携带推荐方案（C++ 有 `recommendation` 字段） | 任务书接口固定；正则仍消费推荐方案尾巴，title 语义与 C++ group3 完全一致 |
| `buildContract` 验收为 `string[]` 多条，C++ 单 `acceptance` | 任务书接口固定；每条一行、句子主干逐字保留，空清单省略块与 C++ 空串语义对齐 |
| `buildResumeContract` 无"，最后完成：<标题>"从句（C++ resumePrompt 有） | 任务书 state 形状无 lastStepTitle；不虚构形状，进度从句逐字保留 |
| `continuePrompt`（完整模板）收缩为 `CONTINUE_PROMPT` 短语常量 | 任务书接口固定 + v0.2.6 裁定语义（会话活着只发这一句）；完整模板的"进度 x/y"上下文由 T3-03 决定是否拼装 |
| `normalizeReceived`（Latin1→UTF-8 双重编码修复）未移植 | C++ 特有：QTermWidget `receivedData` 以 fromLatin1 产出；bridge 传输层交出的是正确 UTF-8 字符串，编码规范化属传输层职责（如实测需要，落 T3-03/传输层，不假装在本模块） |
| `classifyModelError`（六类错误模式，含 `\\b` 词边界）未移植 | 不在本任务接口清单；消费方是 T3-03 重试引擎，随 runner 移植避免接口外溢。C++ 的 `\\b` 词边界转义教训（QStringLiteral 需 `\\b`）对 TS 正则字面量不适用，移植时按 TS 语法直写 |

## 6. 自审发现

- **完整性**：任务书接口 8 成员全数落地；另导出 `stripAnsi`（Step1 测试子弹要求可测）与 `ECHO_GUARD_MS`（语义补充明确要求 3s 守卫随迁）——均为任务书内要求，非接口蔓延。
- **纯函数**（R-pg2）：protocol.ts 零 import（grep 核验），无传输/FS/时钟；时间语义以常量 + 调用方注入时刻表达。
- **禁兜底纪律**：无静默 fallback；`plan` 缺省为 undefined 而非空数组（显式"未给出清单"语义）；步骤行非法（n/tot 越界）整体忽略为 C++ 同源校验而非掩盖。
- **测试真实性**：变异验证实证（见 §3）；【源用例22】特意先断言"不剥离必 done=true"钉死病灶，防实现退化为恒 false 的假绿。

## 7. 遗留问题/担忧

1. **T3-03 顺序契约**：`feed` 三步顺序（剥离→解析→守卫作废 done）已钉在 protocol.ts 头注与测试，runner 实现必须遵守，否则【源用例22】回归会以更隐蔽的时序形态复发（e2e 已实证过一次）。
2. **plan 提取的编号歧义**（"3.5 万"类）：提示性字段可容忍；若 T3-03 需要权威计划清单，应要求 AI 按"每步一行 N. 描述"输出（契约已如此约定）并以行锚定形态为主。
3. **stripInjectionEcho 跨行断词回显**：终端折行把注入行拦腰截断时逐行剔除失效——与 C++ 完全一致的已知边界，由 3s 守卫窗口兜住（两层防御均为 GUI 原语义，未新增自创机制）。
4. `classifyModelError`/`normalizeReceived` 的移植落点在 T3-03（见 §5），届时需把 22 用例中 #6/#10/#11 的重试语义与错误分类正则一并搬运对齐。
