# Task 21 报告：M3 故障矩阵（T3-08）

**Status**: DONE
**Commit**: `a2458e2e69` — `codearts-bridge(T3-08): M3 故障矩阵 — 八格全过，永不挂起语义闭环`
**日期**: 2026-10-31
**工作区**: `/home/wsc/.local/share/opencode/worktree/e5785e/codearts-bridge`（分支 `codearts-bridge`）

---

## 1. 交付物

| 文件 | 动作 | 行数 |
|------|------|------|
| `plugins/codearts-bridge/test/matrix.test.ts` | 新增 | 850（≤1000 铁律 ✓） |

只增不改：既有 455 计数测试零改动，无既有模块修改，无缺陷上报（未触发 BLOCKED 分支）。

## 2. 矩阵逐格结果表

| 格 | 场景 | 用例 | 结果 | 关键断言（R-mx2 最低集合） |
|----|------|------|------|------|
| 1 | 模型错误连续重试 | 连续 4 次 server 类错误 → 无限重试 → 第 5 信号恢复 → complete | ✓ | 终态 complete/rounds=5/actives=0；injections=5（重试全为全文契约）；审计 retry×4（kind=server、consecutive 1..4）；无 fatal |
| 2 | 网络类错误注入 | error 信号 ECONNRESET/ETIMEDOUT/fetch failed ×3 → 恢复 → complete | ✓ | 终态 complete/rounds=4；retry kind 序列 [network, timeout, network] 对齐 classifyModelError 模式表；无 fatal |
| 3 | 杀回合进程 | alive=false → 重建会话 + 断点契约 → 续跑完成 | ✓ | 终态 complete；injections[1] 含【/goal 断点续跑】且 ref.id 复用；snapshot meta alive=true；审计 goal.restart(reason=session-died)、goal.start 恰 1 次 |
| 4 | 杀守护 | daemon.stop → 同 stateDir 重建 → reconcile → 续跑完成（幂等） | ✓ | stderr 摘要 resumed=1；断点契约恰一次、原文契约全生命周期恰 1 次（**不双注入**）；B 首轮 sweep 零新增注入；rounds=2/strikes=1（对账同口径）；goal.start 恰 1 次；goal.restart(reason=reconcile-session-died) + goal.inject(kind=reconcile-rebuild)；complete |
| 5 | opencode 服务重启 | 插件 setup 重跑（实例 1 unload → 实例 2 setup） | ✓ | 实例 1 loop stopped、fire 零请求；实例 2 goal_start 恢复可用（POST /goals 捕获、Bearer=守护 token 同 stateDir、R-g4 会话绑定登记）；守护不受影响：health actives=1、停滞续跑照常、目标跨重载驱动至 complete |
| 6 | 回显防护 | 注入含 [GOAL-DONE] 的契约回显 | ✓ | 双层不误判：守卫窗口内 done 作废 + 窗外整段回显被 stripInjectionEcho 剥离（verify 零调用、零误注入、phase 恒 active）；真实申报恰一次 complete（审计 complete 计数=1） |
| 7 | 双过验收 | 自报 done + verify 首败 → 继续；再申报 + verify 过 → complete | ✓ | 首败后 phase 仍 active、rounds=2；refeed 注入含"验收未通过"+失败全文+[GOAL-DONE]；verify ok 序列 [false, true]；inject kind 序列 [contract, verify-fail]；complete |
| 8 | pause/resume/stop 三连击 | 活跃目标上即时生效 | ✓ | pause 后 sweep 零注入；resume 注入 CONTINUE_PROMPT 恰 1 次；stop 终态出册（actives=0、alive=false、再 control 409 GOAL_TERMINAL_STATE）；审计 pause→resume→stop 顺序齐备；**泄漏断言**：stop 后观察槽已释放（observe 不抛 OBSERVER_ACTIVE 且流立即终止） |

## 3. 测试结果与证据

```
bun test test/matrix.test.ts        → 8 pass / 0 fail（连续 5 轮复跑全绿，无 flake）
bun test（全量）                    → 462 pass + 1 skip（tmux 真机条件跳过）/ 0 fail，21 文件 463 计数
bun run typecheck                   → tsc --noEmit 零错误
单文件行数                          → 850 ≤ 1000 ✓
```

- 提交内容隔离：`git add plugins/codearts-bridge` 仅含 `test/matrix.test.ts`；工作区根 `opencode.json` 本地改动（已裁定 dev 接线）未触碰、未提交。
- 台架构成（R-mx1）：全部复用既有基建——FakeTransport（T2-01）、注入时钟、手动 TickLoop（daemon-goals.test.ts 模式）、goal-tools.test.ts 插件模式（fake DaemonFetcher + ManualPollLoop + CapturedTool）；守护矩阵走真实 HTTP（createDaemon + GoalHost，127.0.0.1:0 内核随机端口）；全程零网络、零真实 HOME 触碰（stateDir 一律 `.tmp/matrix-test/`，afterAll 清理）。

## 4. 实现要点与裁定落实

- **R-mx3（格 4 kill 语义）**：同 stateDir 重建（daemon-token/pidfile/目标状态全部落盘复用）。守护进程之死 ⇒ 传输观察泵随之消失，FakeTransport 以显式会话死亡模拟（`transport.stop(ref)` + 微任务排空等旧 pump 退出释放观察槽），与真进程死亡后观察者消失同构——因此走 reconcile **重建分支**（会话死 → start 复用 ref + 断点契约恰一次），这是恢复语义最强的一格。
- **R-mx2（观察者计数）**：FakeTransport 观察者为私有会话态、计数不外露（fake.ts 无公开查询面）；泄漏断言取可断言处——格 8 stop 路径（观察槽释放 + 观察流立即终止）。完成态观察泵保持存活属会话保活设计语义（非泄漏），已在测试头注登记。
- **格 4/1/2 的审计断言**：经公开 `GET /goals/:id/logs` 分页端点全量遍历读盘；sweep 路径的 appendAudit 为宿主队列**异步落盘**，断言经 `readLogsUntil` 有界写可见性等待（setImmediate 轮转 200 次，超限显式失败，绝不静默放过缺失事件）；control 路径响应前已冲刷无需等待。此等待是测试基建的写可见性处理，非业务兜底。
- **格 5**：插件实例 stateDir 指向守护 stateDir——daemon-token 真实在场（daemonRequest 唯一 token 源，与生产同构）；fetch 注入 fake 绝不联网。

## 5. 实施过程中发现的问题（均已在本任务文件内解决，未触及既有模块）

1. **插件工具注册名**：CapturedTool 的 `name` 是 `goal_start`（namespace 单列），非对外完整名 `codearts_goal_start`——首版用错名导致实例 2 工具查找失败，已按 goal-tools.test.ts 同口径改为 `goal_start`。
2. **审计写可见性竞态（非缺陷，测试面现象）**：sweep 路径审计经 makeAuditSink 异步追加，测试在读盘断言处偶发读到 complete 事件落盘前的快照（首轮 3 fail 的根因之一）。GoalHost.control 有 flush 契约而 sweep 无（设计如此：sweep 不阻塞在 FS 上）。以 readLogsUntil 有界等待解决；**不构成业务缺陷**——守护自身消费状态走内存 runner（GET /goals/:id 实时优先），审计流是事后取证面。
3. **格 4 的进程内观察者碰撞**：若会话仍存活就重建守护（同进程共享 FakeTransport），旧 runner 的观察泵仍持有会话观察槽，新 roster 的 startPump 会 OBSERVER_ACTIVE。真实生产中守护进程死亡即释放一切内存观察者，此碰撞仅在测试进程内模拟"杀守护"时出现——故按 R-mx3 采会话死亡模拟（与真进程死亡同构），并在头注登记机理。

## 6. 遗留问题 / 担忧

- **完成态观察泵常驻**：goal complete 后 runner 出册，但其观察泵保持 observe 直至传输会话死亡（设计语义：会话保活可续报）。对长期运行守护意味着终态目标的 observe 挂起态常驻（FakeTransport/真实传输均为事件驱动挂起，无轮询开销）。若后续要求终态即释放传输观察者，需在 GoalHost 出册时显式 runner 终止缝——登记待后续任务裁决，本任务按"只增不改"未动。
- **守护端无 per-goal 文件日志器**：runner 决策日志（goal.log）现走 stderr（T3-05 既有登记），矩阵未对 goal.log 内容做断言（审计流已覆盖关键事件面）。
- 格 5 的"守护不受影响"以守护矩阵台架（同进程 GoalHost + 手动 sweep）承载：真进程级守护（systemd 单元）不受 opencode 重启影响由 T3-07 的进程隔离保证，两层证据合并即闭环。

## 7. 合同核对

- [x] Step 1 矩阵测试：八格逐格独立用例（`test/matrix.test.ts`）
- [x] Step 2 全部通过：`bun test` 全绿（462 pass + 1 skip + 0 fail）+ `bun run typecheck` 零错误
- [x] Step 3 Commit：`a2458e2e69`（格式 `codearts-bridge(T3-08): 摘要 — 细节`，只 add `plugins/codearts-bridge`）
- [x] 保持既有 455 计数测试全绿（只增不改；无缺陷上报）
- [x] 主控裁定 R-mx1/R-mx2/R-mx3 逐条落实（依据写入文件头注）
