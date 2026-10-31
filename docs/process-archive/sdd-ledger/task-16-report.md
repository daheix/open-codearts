# Task 16 报告 — 监督状态机（T3-03）

- **Status: DONE**
- Commit: `7c2c629fe0`（BASE `b73ae61ff`）
- 文件：`plugins/codearts-bridge/src/core/goal/runner.ts`（新建，843 行 ≤1000）；`plugins/codearts-bridge/test/runner.test.ts`（新建，618 行）

## 0. 派发偏差说明（首要事项）

**task-16-brief.md 文件在派发时不存在**（`.superpowers/sdd/2026-10-31-.../` 目录下只有 task-1..15）。本实施以以下三源重建任务书，语义一致：

1. 计划卡 Task 16 全文（`docs/superpowers/plans/2026-10-31-codearts-integration-opencode-implementation-plan.md` L469-503：Files/Interfaces/规则/Step1 九条测试清单逐字采用）；
2. progress.md 中 Task 16 派发裁定记录（R-rn1~R-rn5 + 携带指针，逐条落入实现与头注）；
3. 主控 prompt 中的背景与全局约束。

## 1. 实现内容

### 1.1 GoalRunner（spec §6.3.2 监督状态机，语义源 goalrunner.cpp/retryengine.cpp v0.2.6）

- **纯 tick（R-rn1）**：时间唯一来源 `deps.clock`；`tick(): Promise<GoalState>` 由调用方驱动（生产循环宿主 T3-05）。零 `setTimeout/setInterval`（grep 取证）。信号消费经 `transport.observe` **事件泵**（无定时器）：tick 入口先 `quiescePump()` 排空已送达信号再决策。
  - quiesce 判据：泵挂起态（`pumpParked`）下一整轮微任务无新消费（`feedCount` 不变）→ 排空。正确性依据：信号 push 的唤醒反应在 tick 调用前已入微任务队列，FIFO 保证可达（实现期发现的首版缺陷：只等"挂起"即返回，导致已 resolve 未消费的信号迟到决策之后——10 用例红的根因，已修并保留注释）。
- **并发串行化（R-rn2）**：`tick/resume/stop` 经互斥 Promise 队列串行；`pause()` 为同步原子相位翻转（接口即 `pause(): void`），且 tick 内**逐 await 点复查相位**（alive 检查后、重启 stop/start 之间、验收注入前），`pause 后并发 tick 不产生注入` 专测钉死（停滞已到期条件下触发，若串行化失效必然注入）。
- **策略（R-rn3，全部经 `thresholds` 可配，默认对齐 spec §6.3.2）**：
  - 停滞：`now-lastProgressAt ≥ stallSeconds` **且** `now-lastActiveAt ≥ stallSeconds`（C++ `noProg && chatStopped` 双条件）→ 注入轻量继续指令（`CONTINUE_PROMPT` 承载，【/goal 继续】文案自 C++ continuePrompt 移植；一次/窗口，重复 tick 不重复注入）；
  - 错误重试（RetryEngine 逐条移植）：首次立即、连续失败间隔 `retryCapSeconds` 封顶（不随次数增长）、**无上限不放弃**、连续 ≥10（`RETRY_WARN_THRESHOLD`，C++ 写死参数）发 `goal.warning{reason:"consecutive-errors"}` 且不停止；
  - strikes：nudge/重启各 +1、真实步进复位 0；`≥ thresholds.strikes` 发 `goal.warning{reason:"no-progress"}` **仅告警不终止**；
  - done 双过：`[GOAL-DONE]`（剥离回显+守卫后）→ tick 内执行 `verifyRun` 逐条验收（argv 空白切分；首败即停）→ 全过 `complete`；fail → 注入 C++ refeed 文案（`验收未通过：<out>\n请分析失败原因…再次输出 [GOAL-DONE]`）继续；verify 空清单 → 自报即完成（与 buildContract 空验收省略验收块对称）。
  - fatal：**仅 transport 显式 error 信号 + refusal 分类** → `blocked`（等人工）+ `goal.error{fatal:true}`；output 正文中 refusal 词样沿 C++ 一律重试（防方案描述误判中断，专测钉死该分歧）。resume 从 blocked 恢复。
  - 进程死：tick 查 `alive=false` → 审计 `goal.restart` → `stop+start` 重建 → 有进度注入 `buildResumeContract`（doneSteps=去重排序 steps；totalSteps 缺省近似口径=task-15 M61 复述），无进度重发全文契约（C++ forceRestart 判据）。
- **判停滞增量口径（R-rn4）**：双口径并行（C++ feed 判活段移植）——① 文本指纹：`stripAnsi(raw).trim()` 非空且变化 → 刷新活动基线；② 批次密度：3s 窗口 ≥12 信号 → 刷新。各有专测（重绘欺骗：逐次消费 5 次相同重绘、基线纹丝不动；fast output：12 块同文本布 1.2s 内、仅批次口径续命）。
- **feed 顺序契约（R-rn5，protocol.ts 头注）**：`normalizeReceived → stripInjectionEcho(最近注入, 上限 6 条) → parseProgress → 守卫作废 done`（`now < deafUntil` 时 `prog.done=false`，错误检测不受守卫——C++ 同语义）。注入统一入口：留痕 → 开 `echoGuardMs` 守卫窗 → 审计 `goal.inject` → transport.inject → 复位三计时。
- **移植件**：`classifyModelError`（六类模式表逐条对照 goalprotocol.cpp，C++ `\\b` 即 TS 正则 `\b`；表序=首匹配优先，ECONNREFUSED 因此命中 network 非 refusal；`429`/`timeout=` 子串/负向前瞻语义与源一致不"修复"）；`normalizeReceived`（TS 适配：不重编码——传输层已 UTF-8 解码，仅清理未配对代理为 U+FFFD）。
- **构造校验（显式报错）**：goalId/objective 空 → `GOAL_STATE_INVALID`；终态 phase 构造 → `GOAL_STATE_INVALID`；verify 非空无 verifyRun → `GOAL_VERIFY_RUN_MISSING`（fail-fast）。审计事件面（spec §6.3.3）：start/inject/retry/warning/restart/resume/pause/stop/complete/verify/error。

### 1.2 有意分歧（均入头注 + 本报告登记）

| # | 分歧 | 依据 |
|---|---|---|
| 1 | C++ 把 nudge/重启计入 RetryEngine 连续失败；TS 拆分为错误重试计数（≥10 告警）与 strikes 循环保护（≥thresholds.strikes 告警）两条独立线 | spec §6.3.2 参数表分列 |
| 2 | normalizeReceived 不做 Latin1→UTF-8 还原（Qt 通道特性），改为清理未配对代理 | TS 传输层 StringDecoder 已 UTF-8 解码 |
| 3 | fatal/blocked 仅由 error 信号 + refusal 触发；output 正文 refusal 一律重试 | 任务书 fatal 分支 + C++ 无 blocked 的折中，防正文误判中断 |
| 4 | 进程死重建立即执行（C++ 等 60s 等 UI 重建） | 桥接传输 start 即就绪；TUI 就绪门属传输宿主层（T13 真机发现留档） |
| 5 | 信号计时刻 = 消费时刻（deps.clock），非产生时刻 | FakeTransport.at 为调用序刻度（types.ts 注）；tick 驱动的必然结果，测试已按此口径 |

## 2. TDD 证据

- **RED**：`bun test test/runner.test.ts` → `Cannot find module '../src/core/goal/runner'`（0 pass / 1 fail）；实现后首跑 **22 pass / 10 fail**（quiesce 竞态根因 + 测试时序两处，见 §4）。
- **GREEN**：`bun test test/runner.test.ts` → **32 pass / 0 fail / 128 expect**。
- **全量**：`bun test` → **364 计数（363 pass + 1 skip）/ 0 fail / 1589 expect**（基线 332：331+1skip，净增 32 用例）。
- **typecheck**：`bun run typecheck` → rc=0（过程中修复 4 处 TS2551：漏声明 `lastProgressAt` 字段——bun 运行时不查、tsc 拦截，typecheck 门禁有效性的实证）。
- **行数红线**：runner.ts 843 / runner.test.ts 618，均 ≤1000。

## 3. 测试清单（32 用例，对应任务书 Step1 九条 + 扩展）

任务书九条全部落地并有对应用例名：stall 一次/再注入 ✓、fast output ≥12 块不打断 ✓、重绘欺骗 ✓、error retryable 立即/60s 封顶/≥10 告警 ✓、error fatal blocked ✓、process death 断点续跑 ✓、strikes≥3 告警继续 ✓、done 双过/verify fail 注入 ✓、Review-Focus-5 pause 并发 tick ✓。扩展：构造校验 5、引导与对账重锚 2、步进行含"超时"不误判 1、output refusal 不 blocked 1、回显守卫剥离双层 2、classifyModelError 表与 \b 边界 2、normalizeReceived 1、rounds/injected 上限 1。

## 4. 实施中发现并修复的问题

1. **quiescePump 首版竞态（真缺陷）**：只等泵"挂起"即返回，但挂起≠已消费——已 resolve 的信号在决策之后才 feed，10 用例红。修复：feedCount + 挂起态下一整轮微任务无新消费方判排空（注释含 FIFO 正确性论证）。
2. **测试时序两处（测试侧）**：① "消费时刻=计时刻"下，fast output 静默窗从消费时刻起算（实现头注分歧 5，测试按此校准）；② 重绘用例重构为逐条消费（一次性消费的多条相同重绘在宏观上等效一次刷新，逐次消费才能真正钉死"feed 跑了 5 次基线不动"）。
3. **对账重锚分支遗漏**：预置会话 + injected 空的恢复场景缺重锚注入，补 tickLocked 第 5 步（会话在场 && injected 空 → 重发契约/断点契约），供 T3-04 对账复用。

## 5. 自审结论

- **完整性**：任务书九条测试、R-rn1~R-rn5、携带指针（feed 顺序契约/增量口径/移植件）全部落地；接口与计划卡逐字段一致（GoalState/RunnerDeps/GoalPhase/方法签名）。
- **禁兜底**：无静默 fallback——构造校验显式抛、观察通道异常审计上抛（`goal.error{kind:"observe-channel"}`）、verifyRun 缺失 fail-fast、终态误操作显式 `GOAL_TERMINAL_STATE`。
- **YAGNI**：公开面仅任务书接口 + 两个移植函数 + `cfg?`（见 §6 缺口）；未加任何计划外方法。
- **测试真实性**：全部经 injections/audits/state 断言外部可观测行为，无同义反复；并发用例构造了"停滞已到期"的最强前提（串行化失效必红）。

## 6. 接口缺口与遗留问题（供主控/T3-04/T3-05）

1. **RunnerDeps 增 `cfg?: BridgeConfig`（偏离计划卡，需主控确认）**：进程死重建需 `transport.start(cfg, ref)`，计划卡 RunnerDeps 无 cfg。缺省透传 undefined 由具体传输显式报错（不伪造配置）；生产宿主 T3-05 必注入 cfg 或闭包配置的 transport 适配。另注意：structured 传输 `start(ref)` 对终态会话抛 SESSION_NOT_ALIVE（T2-04），其重启语义需 T3-05 适配层映射（如全新 spawn + `--session` 续接）。
2. **PTY 回显复位重试计数的继承风险**：C++ feed 尾段"普通输出→notifySuccess"在 PTY 模式下会被自身注入回显触发（剥离后残渣仍算普通输出），可能清零连续错误计数；structured 模式无回显不受影响。沿 C++ 原语义移植未改，真机验证（T4-02）关注。
3. **验证 argv 空白切分不支持引号参数**（`bun test "a b"` 会切碎）——已注释登记，复杂命令由 T3-05 宿主执行器扩展。
4. **pendingVerify/pendingRetry 不持久化**：守护重启后丢失（done 申报需 AI 重报或对账层处理）——T3-04 reconcile 设计输入。
5. **sawStepMarker 不持久化**：重启后"有进度"判据退化为 steps.length>0；对账恢复后首个 [GOAL-STEP] 即重建。影响面小（resume-vs-contract 选择），T3-04 可评估入 state。
6. **autoNudge 配置（T1-02，默认 true）未接入 runner**：RunnerDeps 无此字段；false 语义（不自动续跑）需 T3-05 宿主侧实现（如不驱动 tick 或包一层）。
7. **pause 于 verify 进行中**：pass → complete 照常生效；fail → 注入延后至 resume 后重跑 verifyRun（验收命令会重复执行）——已注释，低风险。
8. **TUI 就绪门**：进程死重建立即注入，真实 PTY 若存在 TUI 自升级对话框等吞注入场景（T13 真机发现），需传输宿主层就绪门，非 runner 职责。

---

## 7. 修复环第 1 轮（2026-10-31，评审 I1）

### 7.1 发现（评审裁定逐字）

**I1（Important）：`classifyModelError` 丢失 C++ 内部 stripAnsi 预处理**。C++ `goalprotocol.cpp:118-120` 在匹配前 `const QString clean = stripAnsi(text)`；TS 版直接 `re.test(text)` 无内剥——真实 TUI 输出的转义序列落在错误词中间/交错时漏检（C++ 能检）；该偏差未入头注分歧表与本报告（原报告声称逐条对照），与同模块 parseProgress 内剥 ANSI 的自身约定不一致，属疏漏非设计。

### 7.2 修复内容

- `runner.ts` `classifyModelError`：函数内 `const clean = stripAnsi(text)` 后对 clean 匹配（stripAnsi 复用 protocol.ts 导出，已在本文件 import）；函数头注补 C++ 原语义引证（goalprotocol.cpp:118-120"同 parse：只剥离转义序列，不做编码规范化"）与漏检机理说明。模式表本身零改动（六类正则与表序逐字保留）。
- `test/runner.test.ts` 新增用例「ANSI 转义落在错误词中间/包裹时仍命中（对齐 C++ goalprotocol.cpp:118-120 内部 stripAnsi）」，双形式：
  - 包裹形式（裁定示例原样）：`"\x1b[?25l请求已超时\x1b[0m"` → timeout；
  - **交错形式（真 RED 检出点）**：`"请求已超\x1b[0m时\x1b[0m"` → timeout——转义序列把"超时"劈开，裸文本匹配必然漏检（旧实现返回 null），stripAnsi 后命中。仅包裹形式会立即绿（连续"超时"仍可裸匹配），交错形式才构成有效回归钉子，故两条并列。

### 7.3 TDD 证据（RED→GREEN）

- **RED**（实现前）：`bun test test/runner.test.ts` → **32 pass / 1 fail**，失败点即交错形式 `Expected: "timeout" / Received: null`（runner.test.ts:590）。
- **GREEN**（实现后）：`bun test test/runner.test.ts` → **33 pass / 0 fail / 130 expect**。
- 全量 `bun test` → **365 tests（364 pass + 1 skip）/ 0 fail / 1591 expect**（基线 364：363+1skip，净增 1 用例）。
- `bun run typecheck` → rc=0。
- 行数红线：runner.ts **849** / runner.test.ts **625**，均 ≤1000。
- 提交：`codearts-bridge(T3-03): 修复评审发现 — classifyModelError 补内部 stripAnsi（对齐 C++ 原语义）+ ANSI 包裹错误词用例 — I1`。
