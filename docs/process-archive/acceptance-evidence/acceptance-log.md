# Task 23 真机验收（T4-02）证据台账

时间：2026-10-31 17:33–17:47（Asia/Shanghai）
环境：worktree `e5785e`（分支 codearts-bridge，HEAD c5df019a1d）
生产守护：systemd user unit `codearts-bridge`，bun 直启本 worktree `src/cli.ts daemon`，127.0.0.1:4577

## 0. 前置检查（step0_*.log）
- systemctl --user is-active → **active**（16:14:28 起，MainPID 502400）
- 守护启动日志：目标域传输 pty-script（**未检测到 AK/SK → pty**；tmux 不可用 → script）
- `codearts-bridge status`（bun src/cli.ts）→ ok/version=dev/actives=0
- **环境异常修复**：wrapper `~/.codeartsdoer/installers/codearts` 指向 `bin/codearts`，该文件缺失（仅存 `codearts.bak-26.10.9`，10-30 20:20 ELF）。已用硬链接还原 `bin/codearts`（ln，无副本），复验 `--version` → **26.10.9**。此为环境修复，非仓库代码改动。

## 1. 真机小目标（step1_*.log, poll_timeline.log）
- POST /goals（含 verify 1 条）→ **HTTP 错误 GOAL_VERIFY_RUN_MISSING**：生产 GoalHost 装配（cli.ts daemonCommand）未接线 verifyRun；半成品目标文件已落盘（取证 step1a_halfcreated_goal_debris.json 后移除——该文件会使守护重启崩溃，见缺陷③）。
- 改无 verify 目标 → `gmvw7jb86-e2736735` 创建成功；goal.start + goal.inject(contract) 审计；session script-1；TUI 进程 script(577837)+bin/codearts(577838)。
- **注入从未成功**：17:37:18 goal.error tick-failed "注入文本含换行符（长度=357），与两段式提交契约冲突"（buildContract 多行 vs script 传输 INJECT_TEXT_MULTILINE 两段式契约冲突）；随后 6× goal.retry(server)。
- 真实模型回合未发生（契约未送达 TUI）；workdir 终态空，hello-bridge.txt **未创建**（目标未完成，如实记录）。

## 2. 演练 A：杀会话进程（drillA_*.log, step1_audit_full.json）
- 17:39:47 kill -9 精确目标（usr/bin/script + bin/codearts；括号模式避免误伤守护/自身），杀后复核为空。
- **17:39:51 goal.restart(session-died)**：死亡检测 4s ✓（≤2min 达标）。
- 但重建失效：transport.start(ref) 收到死 ref → SESSION_NOT_ALIVE "会话已结束，拒绝操作：id=script-1"（其 remediation 即指明应 start 不带 ref）→ 5s 周期重启风暴（restart→tick-failed 循环，strikes 52 @pause 时），从不 spawn 新进程。

## 3. 控制三连（control_triple.log）
- pause ✓：phase=paused；pause 后 ~19s 内 strikes 52→53 仅 +1（风暴停止实证；对比风暴期 +1/5s）。
- resume ✗：HTTP 结构化报错 SESSION_NOT_ALIVE（死会话目标 resume 永久失败，仅 stop 可达终态）——设计缺口，如实记录。
- stop ✓：phase=stopped（rounds=2, strikes=53），终态出册，GET 读盘一致。

## 4. 演练 B：杀守护（drillB_*.log）
- 17:45:18 systemctl --user kill --signal=KILL → activating(auto-restart)。
- **重启即崩溃循环**：journal（restart counter 5→8+）`BridgeError: 未知会话引用：kind=pty id=script-2` at pty-script.ts:265 requireSession ← alive:421 ← state.ts:445 reconcileLocked —— 新进程内存 sessions 表为空，alive() 对未知 ref 应返回 false 却抛错 → goals.start 失败 → exit 1 → systemd 无限拉起。**生产守护在存在活跃目标时被杀 = 永久下线**。
- 陈旧 pidfile 清除正常（每轮日志可见）。
- 恢复动作（主控知情范围内最小处置）：取证后移除本次验收创建的目标 debris（drillB_goal2_state_debris.json / goal1_stopped_terminal_debris.json 已存 .tmp）→ 17:46:22 守护自动恢复 active，对账 resumed=0 blocked=0，/health ok。

## 5. structured 对照（step6_aksk_workdir.log）
- akskFile 默认 `<stateDir>/config.env` → **不存在**；守护自报"未检测到 AK/SK 凭据 → pty"。**AKSK_MISSING 豁免成立**，未执行真实模型回合（不烧配额）。

## 6. 清场（step7_final_check.log）
- 无残留 TUI 进程（pgrep 空）；守护 active/health ok/actives=0；/goals 空。
- git：无本任务代码改动；`.codeartsdoer/package.json`、`opencode.json` 为既有 WIP（未触碰）。

## 缺陷清单（发现即报，未私改）
1. **[高] 生产 verifyRun 未接线**（cli.ts daemonCommand → new GoalHost 无 verifyRun）：带 verify 的 POST /goals 在生产必失败，且产生"半成品"目标文件。
2. **[高] 契约注入与 script 传输两段式契约冲突**：buildContract 多行文本被 INJECT_TEXT_MULTILINE 拒绝 → pty-script 生产形态下任何目标的首个契约都无法送达 TUI；且 injectPrompt 先改状态/审计后传输，注入被拒仍留下 injected 指纹与 rounds+1（状态失真）。
3. **[严重] 死会话重启风暴**：runner.restartLocked 把死 ref 传回 transport.start(ref)；pty-script.start 对 closed 会话抛 SESSION_NOT_ALIVE → 5s 周期 restart→tick-failed 死循环，不 spawn 新进程，仅告警不升级（strikes≥10 仅 warning）。
4. **[严重] 守护重启崩溃循环**：pty-script.alive() 对未知 ref 抛 SESSION_UNKNOWN（pty-script.ts:421→265）；reconcile（state.ts:445）在 daemon 重启后必然遇到未知 ref → goals.start 抛错 → systemd 崩溃循环，生产永久下线。alive 契约应为"未知/已死 → false"。
5. **[中] 死会话目标 resume 永久失败**（控制三连实测），仅 stop 可达终态。
