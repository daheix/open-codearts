# Task 23 报告：真机验收（T4-02）

- 执行：实施子代理（主控会话派发），2026-10-31 17:33–17:47
- 工作区：`/home/wsc/.local/share/opencode/worktree/e5785e/codearts-bridge`（分支 codearts-bridge，HEAD c5df019a1d）
- 结论：**DONE_WITH_CONCERNS → 实质为 BLOCKED（缺陷修复裁决）+ 验收判据部分达成**；恢复链路证据完整，但真机全流程未走通，根因已定位为 4 个产品代码缺陷（未私改，待主控裁决）。

---

## 1. 前置检查结果（Step 0）

| 检查项 | 结果 | 证据 |
|---|---|---|
| `systemctl --user is-active codearts-bridge` | ✓ active（16:14:28 起，MainPID 502400） | step0_precheck.log |
| `codearts-bridge status`（CLI=bun src/cli.ts status） | ✓ ok / version=dev / actives=0 | step0c_cli_status.log |
| `~/.codeartsdoer/installers/bin/codearts --version` | 初检失败（文件缺失，仅存 codearts.bak-26.10.9）→ **硬链接还原后 26.10.9** | step0d/0e_wrapper_fix.log |
| token（`~/.codearts-bridge/daemon-token`） | ✓ 存在（600 权限） | step0_precheck.log |
| 传输形态 | pty-script（守护自报：未检测到 AK/SK → pty；tmux 不可用 → script） | journal 16:14:28 |

环境修复说明：wrapper（`installers/codearts`）exec `bin/codearts`，该 ELF 被改名（10-30 20:20 → .bak-26.10.9）。以 `ln`（硬链接，无副本）还原 wrapper 预期路径；纯环境修复，不涉仓库代码，可随时 `rm bin/codearts` 回退。

## 2. 真机小目标全流程（Step 1，PTY 模式）

### 2.1 创建
- 带 verify 的 POST /goals → **HTTP 错误**：`GOAL_VERIFY_RUN_MISSING`（"目标声明了 1 条验收命令但未注入 verifyRun"）。根因：生产装配 `src/cli.ts daemonCommand` 构造 GoalHost 未传 `verifyRun`（daemon-goals.ts:131 声明为可选、:448 透传 undefined）。
- 该次调用**留下半成品目标文件**（saveGoal 先于 roster，rosterGoal 构造 runner 抛错，createGoal 未回滚）——已取证移除（step1a_halfcreated_goal_debris.json）。此文件若留存，会在守护重启时触发缺陷④崩溃循环。
- 改用无 verify 目标 → 成功：`gmvw7jb86-e2736735`，objective 按任务书原文，workdir=`.tmp/acceptance/workdir/`（预创建），maxRounds=8。

### 2.2 注入与轮询
- goal.start + goal.inject(contract) 审计入册；session=script-1；TUI 进程树实测：`/usr/bin/script -qefc '~/.codeartsdoer/installers/codearts' /dev/null`(577837) → `installers/bin/codearts`(577838)——经官方 wrapper 启动（修复环裁定①生效，实证）。
- **契约注入被传输层拒绝**（17:37:18，首 tick 即失败）：
  `goal.error tick-failed "注入文本含换行符（长度=357），与两段式提交契约冲突"`
  buildContract() 产出多行契约文本，pty-script.inject() 按两段式提交契约拒绝多行（INJECT_TEXT_MULTILINE）。随后 6× goal.retry(server)。
- **真实模型回合未发生**（契约从未送达 TUI；配额风险因此未触发，符合 prompt 最小化约束）。
- 30s 间隔轮询 4 次（poll_timeline.log）：phase 恒 active、rounds=1、strikes=0→无进展。

### 2.3 目标完成验收
- **未完成（如实记录）**：workdir 终态为空，hello-bridge.txt 不存在。目标在演练中被 stop 终止（见 §4）。

## 3. 中断演练 A：杀会话进程（Step 2）

| 时点 | 事件 | 证据 |
|---|---|---|
| 17:39:47 | `kill -9` TUI 双进程（精确锚定：`usr/bin/[s]cript` + `bin/[c]odearts$` 括号模式，避免误杀 cmdline 含 "codearts-bridge" 的守护与自身）；杀后 pgrep 复核为空 | drillA_kill.log |
| 17:39:51 | **goal.restart(session-died)** —— 死亡检测 **4 秒**（≤2min 达标 ✓） | step1_audit_full.json seq10 |
| 17:39:51 起 | **重建失效**：`goal.error tick-failed "会话已结束，拒绝操作：id=script-1"`，此后每 5 秒 restart→tick-failed 循环（重启风暴），strikes 以 +1/5s 攀升（pause 时已达 52），**始终不 spawn 新 TUI 进程** | 同上 seq11~40+，drillA_recheck.log |

根因（未私改）：`runner.restartLocked`（runner.ts:487-489）`transport.stop(ref)` 后把**死 ref 原样**传回 `transport.start(cfg, ref)`；pty-script.start 对 closed 会话抛 `SESSION_NOT_ALIVE`，其 remediation 自述"script 宿主会话不可复活；请新建会话（start 不带 ref）"——调用方违约。次生观察：strikes≥thresholds(10) 仅 goal.warning 告警不升级，风暴无自愈路径。

**演练 A 判定：死亡检测达标；"重建续跑至完成"未达成（缺陷③）。**

## 4. 控制三连（Step 4，对风暴中的目标 #1 执行）

| 动作 | 结果 | 证据 |
|---|---|---|
| pause | ✓ phase=paused；之后 ~19s 内 strikes 52→53 仅 +1（对比风暴期 +1/5s，实证注入停） | control_triple.log |
| resume | ✗ HTTP 结构化报错 `SESSION_NOT_ALIVE id=script-1`——死会话目标 resume 永久失败（缺陷⑤；报错透明度符合 BridgeError 契约，但功能不可达） | 同上 |
| stop | ✓ phase=stopped（rounds=2, strikes=53），终态出册；GET /goals/:id 读盘一致 | 同上 |

## 5. 中断演练 B：杀守护（Step 3）

- 17:45:06 创建目标 #2 `gmvw7t5su-ffc6e2e7`（无 verify，maxRounds=4），bootstrap 成功：session=script-2，TUI 582111/582113 在场（drillB_bootstrap.log）。
- 17:45:18 `systemctl --user kill --signal=KILL codearts-bridge` → systemd 进入 auto-restart。
- **重启即崩溃循环（最严重缺陷④）**：journal（restart counter 5→8+，drillB_journal.log）：
  `BridgeError: 未知会话引用：kind=pty id=script-2 at requireSession (pty-script.ts:265) ← alive (pty-script.ts:421) ← reconcileLocked (state.ts:445)`
  守护重启后进程内存 sessions 表为空，磁盘目标状态的 session ref 必然未知；pty-script.alive() 对未知 ref 抛错而**不是返回 false** → reconcile 上抛 → goals.start 失败 → daemon exit 1 → systemd 无限拉起。**生产守护只要磁盘存在活跃（active/paused）目标，被杀后即永久下线。**
- 附带验证 ✓：陈旧 daemon.pid 清除正常（每轮重启日志可见）；systemd Restart 策略工作正常。
- 恢复处置（最小、可审计）：TUI 孤儿进程已自清（pgrep 空）；取证后移除本次验收创建的两个目标 debris（drillB_goal2_state_debris.json、goal1_stopped_terminal_debris.json 留证）→ 17:46:22 守护自动恢复 active，日志"启动对账完成：resumed=0 blocked=0"，/health ok（drillB_recovered.log）。

**演练 B 判定：systemd 拉起 ✓、崩溃根因定位 ✓、对账机制存在但被缺陷④击穿；"对账后目标恢复"未达成。**

## 6. structured 对照（Step 6）——AKSK_MISSING 豁免成立

- akskFile 默认 `<stateDir>/config.env` → `~/.codearts-bridge/config.env` **不存在**（ls 实证）。
- 守护启动自报：`目标域传输：pty-script（auto：未检测到 AK/SK 凭据 → pty…）`（journal 17:46:22）。
- 按任务合同："AK/SK 缺失则记录 AKSK_MISSING 证据即完成本项"。**未执行 `codearts run --format json` 真实回合**（不烧用户配额）。结论：structured 传输未被真机验收，PTT（pty-script）形态已验收（含缺陷）。

## 7. 清场核验（Step 7）

- 无真实 TUI 残留进程（`pgrep usr/bin/[s]cript` / `bin/[c]odearts$` 均空）。
- 守护 active、/health ok、actives=0；`GET /goals` = `[]`。
- 证据保留 `.tmp/acceptance/`（24 文件）+ 台账 `.tmp/acceptance-log.md`；`.tmp` 不入库。
- git：本任务零代码改动，无提交（HEAD 保持 c5df019a1d）；`.codeartsdoer/package.json`、`opencode.json` 改动为既有 WIP（任务书已裁定 dev 接线不得提交，未触碰）。
- 操作记录：`操作记录/codearts-bridge真机验收T4-02-2026-10-31-操作日志记录.md`（未入库，是否随库提交由主控裁定——本任务提交范围仅限 plugins/codearts-bridge）。

## 8. 缺陷清单（发现即报，全部未私改，待主控裁决）

| # | 严重度 | 缺陷 | 位置 | 影响 |
|---|---|---|---|---|
| ④ | **严重** | 守护重启崩溃循环：alive() 对未知 session ref 抛 SESSION_UNKNOWN 而非返回 false | pty-script.ts:421→265；state.ts:445 | 存在活跃目标时守护被杀=生产永久下线（演练 B 实证） |
| ③ | **严重** | 死会话重启风暴：restartLocked 将死 ref 回传 transport.start(ref)，script 传输拒绝复活 | runner.ts:487-489；pty-script.ts:287-291 | 会话死亡后无法重建续跑，5s 周期空转（演练 A 实证） |
| ② | 高 | 契约多行注入与 script 两段式提交契约冲突；且 injectPrompt 先改状态/审计后传输，注入被拒仍留 injected 指纹与 rounds+1 | runner.ts:817-834（injectPrompt）；protocol.ts buildContract；pty-script.ts:322 | pty-script 生产形态下任何目标契约都无法送达 TUI（首 tick 实证）；状态失真 |
| ① | 高 | 生产 GoalHost 装配未接线 verifyRun | cli.ts daemonCommand（:196 附近） | 带 verify 的 POST /goals 生产必失败，且遗留会击穿④的半成品目标文件 |
| ⑤ | 中 | 死会话目标 resume 永久失败（仅 stop 可达终态） | runner.resume 路径 | pause 后不可恢复，控制面降级 |

## 9. 验收判据逐条勾选（task-23-brief Step 1–5 + 裁定降级判据）

| 判据 | 结果 | 说明 |
|---|---|---|
| Step 1 真机小目标（PTY）：轮次/注入/完成验收/审计摘录 | ◐ 部分 | 创建/引导/审计/轮询链路真机实证 ✓；契约注入被拒（缺陷②），目标未完成，hello-bridge.txt 未创建 ✗ |
| Step 2a kill -9 会话 → 自动重建续跑至完成 | ◐ 部分 | 死亡检测 4s ✓；重建不发生（缺陷③）✗ |
| Step 2b kill -9 守护 → systemd 拉起 + 对账续跑 | ◐ 部分 | systemd 拉起 ✓；对账机制存在但崩溃循环（缺陷④），目标未恢复 ✗ |
| Step 3 structured 冒烟 / AKSK_MISSING 标注 | ✓ | 未配置 AK/SK（config.env 不存在 + 守护自报），豁免成立，如实标注 |
| 控制三连（合同附加） | ◐ | pause ✓ / stop ✓ / resume ✗（缺陷⑤） |
| 恢复链路证据完整（裁定降级判据） | ✓ | 死亡检测、重启检测、对账路径、崩溃根因、恢复操作全程留证（.tmp/acceptance/ 24 文件 + 台账） |
| 验收判据核对（spec §10.1） | ✓ | 本报告 §9 + 台账 |
| Commit | ✓（零代码变更） | 摘要进操作记录（Step 5 合同路径）；无 plugins/codearts-bridge 代码改动，无可提交内容 |

## 10. 修复建议（供主控裁决参考，未实施）

1. 缺陷④：pty-script.alive() 对 SESSION_UNKNOWN 返回 false（与 tmux 形态对齐"探测语义"），reconcile 即可走重建/blocked 路径。
2. 缺陷③：restartLocked 对 script 形态 start 不带 ref（传输契约 remediation 已明示），或 transport 层对死 ref 自愈为新会话。
3. 缺陷②：buildContract 输出经两段式提交适配（首行+提交分离），或 injectPrompt 改为传输成功后再落状态/审计。
4. 缺陷①：daemonCommand 装配缺省 verifyRun（如 Bun.$/child_process 执行 verify 数组），或 parseCreateInput 对 verify 非空显式拒绝（禁半成品落盘）。
5. 修后回归：本次 .tmp/acceptance/ 的演练脚本（poll.sh + 步骤日志）可复用为回归脚本骨架。

---

## 11. 修复环第 1 轮（2026-10-31，5 缺陷一揽子修复——修复实施者接手原验收者会话）

裁定来源：主控对 §8 缺陷清单的逐条裁定（alive 布尔契约 / 死会话重建 / PTY 多行注入 / verifyRun 接线 / resume 重建）。实施与真机复验：2026-10-31 18:20–18:25，同 worktree（守护 ExecStart 直启本 worktree src/cli.ts，重启即加载修复代码）。

### 11.1 逐缺陷修复说明

**④[严重] alive() 布尔契约（守护重启崩溃循环）**
- 改动：`types.ts`（契约唯一真相源：alive 注明布尔查询语义）、`pty-script.ts`（alive 对未知/kind 不符 ref 返回 false，不再经 requireSession 抛 SESSION_UNKNOWN）、`pty-tmux.ts`（同款）、`structured.ts`（同款）、`fake.ts`（对齐基准同步：未知 ref → false）。
- 覆盖测试：transport-script/tmux/structured/fake 四套件各有"alive 布尔查询"专测；state.test.ts "④③ 跨守护重启（未知 ref）→ alive 判死 → 重建路径恢复"（守护崩溃循环回归断言）。
- 真机证据：演练 B——`systemctl --user kill --signal=KILL` 后 systemd **一次拉起**，journal `启动对账完成：resumed=1 blocked=0`，/health ok、actives=1，磁盘目标（session=script-2 未知 ref）对账重建，新 TUI 进程 604277/604278 spawn；5 分钟窗口 journal **0 条 BridgeError**（修复前：restart counter 5→8+ 崩溃循环，`BridgeError: 未知会话引用` at pty-script.ts:265）。

**③[严重] 死会话重启风暴（start 重建契约）**
- 改动：`types.ts` start 契约注明"已亡同名会话/跨守护未知 ref → 销毁残留并新建活会话，回传前自检 alive"（tmux 宿主既有同名重建语义升为全传输契约）；`pty-script.ts` start(ref) 重写（存活幂等 / 已亡或未知 → 同名重建：旧会话置 closed+唤醒+残余组杀，spawnSession 新建并自检 child.alive()，自检不过显式 PTY_START_FAILED；非法 ref 仍 SESSION_UNKNOWN；新会话 id 生成防碰撞）、`structured.ts` start(ref) 对 closed 会话重建（closed 复位+回合账清零+滞留信号清空，codeartsSessionId 保留续接）、`fake.ts` start 采纳未知 ref。runner.restartLocked 本就采纳 start 回传 ref（`st.session = ref2`），无改动。
- 覆盖测试：transport-script 重建细节/自检/跨守护采纳专测；runner.test.ts "③ 一次 restart 后不再连续 restart（时钟推进两 tick 断言，真实 script 传输+受控 child）"；state.test.ts 跨守护对账恢复。
- 真机证据：演练 A——kill -9 TUI 双进程后死亡检测→`goal.restart(session-died)` 恰 **1 次**（auditId -300），新 TUI 进程 602838/602839 立即 spawn，审计 1000 条扫描**零 tick-failed/零 observe-channel 错误**（修复前：5s 周期 restart→tick-failed 风暴，strikes 攀至 52+，从不 spawn）。

**②[高] PTY 多行注入 + 注入状态失真**
- 改动：`pty-script.ts`/`pty-tmux.ts` inject 删除 INJECT_TEXT_MULTILINE 拒绝分支——多行契约整块一次性写入（TUI 粘贴语义；tmux 为 send-keys -l 字面整块），独立 `"\r"`/Enter 提交（两段式时序保留）；回退开关（\n→空格扁平化）按裁定在两文件注释登记，触发条件=真机发现逐行提前提交截断。runner.ts injectPrompt 重排：留痕指纹+守卫窗先于字节上线（回显在 await 窗口到达前 stripInjectionEcho 指纹必须就位），传输拒绝→回滚 injected/rounds/守卫窗并显式上抛，审计与计时在成功后落（治理"注入被拒仍留指纹与 rounds+1"）。
- 覆盖测试：transport-script/tmux 多行注入形态专测；runner.test.ts "② 注入被传输拒绝 → 状态零失真"。
- 真机证据：目标 #1 创建后首 tick 多行契约（357+ 字符协议正文）注入成功——rounds=1 落账、审计仅 goal.start+goal.inject(contract)（对比 T23 17:37:18 `goal.error "注入文本含换行符（长度=357）"` + 6×retry）；随后模型真实回合发生（goal.retry(server) 流证明 TUI 收到契约并驱动模型 API 调用），无逐行截断迹象 → 不启用扁平化回退。

**①[高] 生产 GoalHost verifyRun 接线**
- 改动：`cli.ts` 新增导出 `execVerify`（child_process 直 exec、argv 数组、60s 超时 SIGKILL、输出截断 8000 字符、cwd 透传；非零退出/超时/spawn 失败一律 ok=false 且携带显式失败原因；cmd[0] 缺失显式抛 GOAL_VERIFY_CMD_INVALID）+ `DaemonCommandDeps.execVerify` 注入缝 + daemonCommand 装配 `verifyRun: deps.execVerify ?? execVerify`；`daemon-goals.ts` GoalHostDeps.verifyRun 签名扩为 (cmd, cwd?)，rosterGoal 逐目标绑定 cwd=g.workdir（RunnerDeps.verifyRun 签名不变）。
- 覆盖测试：service.test.ts 生产装配专测（daemonCommand 装配路径 POST /goals 带 verify → 200——修复前此处 500 GOAL_VERIFY_RUN_MISSING；done→fake execVerify cmd/cwd 逐字透传→complete；SIGTERM 优雅停止 rc=0）+ execVerify 真执行冒烟（echo/非零退出/命令缺失）；daemon-goals.test.ts 接线专测（cmd/cwd=workdir 透传、verify 未过→失败原因注入续跑）。
- 真机证据：真机目标均未带 verify（最小化模型配额消耗的裁定取舍）——①的生产接线证据为装配路径单测与 execVerify 真执行冒烟，如实记录。

**⑤[中] 死会话 resume 永久失败**
- 改动：`runner.ts` resumeLocked 前置 `transport.alive(session)` 检查——死会话先走 restartLocked（③ 路径：销毁残留→重建活会话→断点/全文契约注入）再返回 active；活会话维持原 continueText 注入。
- 覆盖测试：runner.test.ts "⑤ 死会话 resume：先按重建路径复活会话 → 注入续跑契约 → phase=active"。
- 真机证据：控制三连——pause ✓（phase=paused）→ 杀会话进程（paused 期间不自动重建=预期）→ resume ✓ **HTTP 200**（phase=active、rounds+1、strikes+1、新 TUI 进程 603565/603566、审计 `goal.resume` + `goal.restart(session-died)` 连续两条）；stop ✓（stopped 终态出册）。对比 T23：resume 返回 SESSION_NOT_ALIVE 永久失败。

### 11.2 复验环境与清场

- 守护：`systemctl --user restart codearts-bridge`（18:20:18 起，pty-script 形态，与 T23 同形态同 stateDir）。
- 目标 #1 `gmvw930qa-b7fa087c`：演练 A + 控制三连载体，终态 stopped（rounds=3 strikes=2）；目标 #2 `gmvw96ozf-b17cad98`：演练 B 载体，终态 stopped（rounds=3 strikes=1）；/goals 两目标均终态出册，无 TUI 残留进程。
- 证据：`plugins/codearts-bridge/.tmp/acceptance-fix1/`（restart/drillA/control_triple/drillB/final_check 等日志；.tmp 不入库）。
- 如实记录：模型真实回合发生且模型服务端持续 5xx（goal.retry(server) 流，与本次修复无关——T23 同样观察到 server 类错误）；两目标因此未完成（hello-bridge.txt 未创建），但任务合同要求的恢复链路（杀进程重建/杀守护对账/死会话 resume）全部实证。
- 提交：`plugins/codearts-bridge` 全部修复与测试一并入库（worktree 根 `opencode.json` 的 dev 接线 WIP 未触碰、未提交）。

### 11.3 回归与门禁

- `bun test`：474 pass / 0 fail / 1 skip（基线 462 → 净增 12 用例；18 个 RED 先行、实现后全绿）。
- `bun run typecheck`：0 错误。
- 单文件 ≤1000 行：最大 src/core/goal/runner.ts 920 行 ✓（其余 src 全部 <700）。

## 12 终审修复波（2026-10-31，合并前 Final Review 2 Important + 2 文案）

### 12.1 修复项与落实

- **F1（Important）会话 raw 缓冲封顶（内存要求③桥接侧收口）**：
  - shared.ts 新增唯一真相源：`SESSION_RAW_CAP_BYTES = 512*1024`、`CappedTailBuffer`
    （块列表累积 + 整块丢弃 + 边界块码点粒度裁剪——永不劈开代理对/多字节字符；
    字节口径统一 `Buffer.byteLength(utf8)`）、`capRawTail`（无状态一次性封顶，
    tmux capture 快照用，与 CappedTailBuffer 单次 append 同一实现路径）。
  - 三传输一致接入：structured（`rawBuf` 替换 `raw: string`，三处累积点
    message.part/error/原文 output + 回合退出 detail 全走 `append`）；pty-script
    （onData chunk 走 `append`；同名重建仍全新缓冲起步——重建清零逻辑不变）；
    pty-tmux（snapshot 即时 capture 经 `capRawTail` 尾封顶；pane 全量仍由 tmux
    history 持有，只收口桥接侧内存）。
  - 丢弃非静默：三传输 `snapshot().meta.rawDroppedBytes` 如实计数（structured/
    script 为会话生命期累计——跨回合不重置、stop 重建留痕不丢，维持现状口径；
    tmux 为本次捕获丢弃量）。
  - 测试（RED 先行，三传输各一，fake 豁免）：注入 600KB+ 尾标输出 →
    `Buffer.byteLength(raw) ≤ 512KB` 且 `endsWith(尾标)`、`rawDroppedBytes`
    精确对账（累积总量 − cap）。
- **F2（文案）**：`goal-tools.ts` `DAEMON_START_REMEDIATION` 生产常驻指引改为
  "请执行 `codearts-bridge service install`（systemd user service + 每分钟 watchdog）"，
  删除"由后续任务交付"过时表述（T3-07 已交付）。
- **F3（文案）**：`codearts_goal_start` schema `maxRounds` 描述改为
  "目标轮次上限（持久化记录；守护消费为路线图项）"——如实表述，不夸大为已生效强制上限。
- **F4（README 两处表述）**：
  - "内存每回合归零" → 限定为"**codearts 内核**内存每回合归零（回合=独立进程）；
    桥接侧会话缓冲有 512KB 封顶与丢弃计数"。
  - "监督引擎带 TUI-ready 门后再注入" → "停滞重试保障最终递达（实测第 5 轮递达）；
    TUI-ready 门为路线图增强"。
  - **位置偏差如实登记**：任务书写"worktree README"，但两处表述经全 worktree
    检索仅存在于**公开仓库 README**（`/home/wsc/wsc/open-codearts/README.md`
    第 24/158 行；worktree `plugins/codearts-bridge/README.md` 为开发文档，无此二句）。
    按修复意图在表述真实所在处落实（公开仓库已本地提交；是否推送 origin/main 留主控裁定）。
    worktree 侧同口径收口：structured.ts 文件头"内核内存每回合归零"已限定并注明
    桥接侧 512KB 封顶（随本次提交入库）。

### 12.2 验证证据

- RED 先行：3 个新封顶用例实现前全红（`3 fail / 84 pass`，失败点均为
  `toBeLessThanOrEqual(512*1024)` 不满足——实证修复前 raw 无界累积）。
- 聚焦传输测试：structured/script/tmux/fake 四文件 `105 tests / 0 fail`。
- 全量：`bun test` **478 计数（477 pass + 1 skip）/ 0 fail**（基线 475 → 净增 3）；
  `bun run typecheck` 0 错误。
- 单文件 ≤1000 行：最大 `test/transport-tmux.test.ts` 785 行 ✓（src 最大
  goal-tools.ts 710 行）。

### 12.3 改动面

- `src/core/transport/shared.ts`（F1 助手唯一真相源 + 头注范围更新）
- `src/core/transport/structured.ts` / `pty-script.ts` / `pty-tmux.ts`（F1 接入 + 头注）
- `src/goal-tools.ts`（F2/F3）
- `test/transport-{structured,script,tmux}.test.ts`（+3 封顶用例）
- 公开仓库 `/home/wsc/wsc/open-codearts/README.md`（F4 两处，独立提交）
