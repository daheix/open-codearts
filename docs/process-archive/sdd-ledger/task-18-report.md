# Task 18 报告：守护-目标对接（T3-05）

- **Status**: DONE
- **Commit**: `ef26e2394b` — `codearts-bridge(T3-05): 守护目标 API — 全流程/控制/日志分页/多目标隔离 — R-dg1~R-dg5 落地`
- **Base**: `ce8a360bf2`（T3-04）
- **测试**: 全量 `bun test` 407 计数（406 pass + 1 skip + **0 fail**，1839 expect）；`bun run typecheck` 零错误；新套件连续 3 次全量跑稳定（无竞态抖动）。
- **行数纪律**: daemon.ts 625 / daemon-goals.ts 533 / runner.ts 894 / state.ts 530，全部 ≤1000。

## 1. 实现内容（对照裁定逐条）

### R-dg1 构造与循环
- 新文件 `src/daemon-goals.ts`：`GoalHost` 为目标域宿主，`createDaemon(cfg, hooks?, goals?)` 第三参挂载。
- `POST /goals`：`parseCreateInput` 全字段显式校验 → 构造 `GoalState`（goalId 生成 `g<clock36>-<8hex>`，匹配 state.ts 白名单）→ `saveGoal` → **以落盘状态（同一字节）构造 GoalRunner** 入册 → `loop.wake()` 事件驱动首驱 → 响应 `{goalId}`。
- tick 循环宿主：`TickLoop` 抽象 + `defaultTickLoop(intervalMs)`（生产缺省 setInterval，`GOAL_SWEEP_INTERVAL_MS=5000` 命名常量；unref 防测试悬挂；并发 sweep 合并）。runner 保持 R-rn1 纯 tick（零内嵌定时器），本模块是唯一定时器宿主；测试注入手动循环逐 sweep 驱动。
- 启动装配 `GoalHost.start()`：reconcile（真实 `reconcile(stateDir, {transport, cfg, clock})`）→ `loadGoals` → 以落盘状态 roster active/paused 目标（双 roster 守卫防 OBSERVER_ACTIVE）→ 启动 sweep。`DaemonHooks.reconcileOnStart` 缝保留：挂载 goals 时透传为对账实现替换（测试缝），未挂载时旧路径兼容。
- 其余端点：`GET /goals`（磁盘真相摘要列表，objective 截 ≤120 字）、`GET /goals/:id`（在册实时优先、否则读盘）、`GET /goals/:id/logs`、`POST /goals/:id/control`；`GET /health` 增 `actives`（spec §7.2）；未挂载 GoalHost 时 `/goals*` 显式 **501 GOAL_HOST_DISABLED**（禁静默假装功能存在）。

### R-dg2 控制语义
- pause=phase 翻转（runner 同步原子；其后 sweep 对非 active 不注入，专测钉死）；resume=注入继续（CONTINUE_PROMPT 断言）；stop=终态并移出循环名册。
- 即时生效：control 端点 await runner 动作 → `saveGoal` → 审计队列冲刷后才响应（测试零等待断言）。
- blocked 目标：pause 显式 409 `GOAL_PHASE_INVALID`（在册与非在册同一裁决；runner 的 pause 本身容忍 blocked→paused 翻转，宿主层收紧为显式拒绝）；resume/stop 经宿主归一 paused 构造后由 runner 原生语义落实（瞬态 paused 不落盘，头注登记）。
- 错误映射：BridgeError code → HTTP 状态（GOAL_NOT_FOUND→404、GOAL_TERMINAL_STATE/GOAL_PHASE_INVALID→409、GOAL_INPUT/BODY/ACTION/ID/CURSOR/LIMIT_INVALID→400、其余 500），`remediation` 全量透出。

### R-dg3 日志分页
- 磁盘审计流（`<stateDir>/audit/<goalId>.jsonl`）顺序稳定分页：seq=1 基行号（与 appendAudit 的 auditId 序号同源同序）；`cursor`=已读最大 seq（含），返回升序页 + `nextCursor`（本页最大 seq；空页=原 cursor，越界空页专测）；limit 缺省 200、上限 1000（超限显式 400，禁静默钳位）；审计行损坏显式 `AUDIT_LOG_CORRUPT`（禁静默跳行）；goal 无审计（ENOENT）=合法空页。

### R-dg4 多目标隔离
- 每目标独立 `{runner, 审计队列(Promise 链), 会话}`；sweep 逐目标串行 tick，单目标 tick 异常 → stderr + `goal.error(kind=tick-failed)` 审计、目标保留待下轮（其余目标不受影响）；状态落盘按 JSON 串变化检测节流（写失败照常显式报错）。专测：A 驱动到 complete 与 B pause/resume 全程互不影响。

### R-dg5 携带指针
- ① **autoNudge 接线**：`GoalState.autoNudge?`（逐目标覆盖，持久化）+ `RunnerDeps.autoNudge?`（宿主解析生效值 = 覆盖 ?? cfg.autoNudge 传入）；false 时 runner 停滞看门狗整体跳过（不注入、不累计 strikes）——专测双路径（cfg=false 静默 / 逐目标=true 注入 CONTINUE）。
- ② **ReconcileDeps 增可选 clock（M72）**：reconcile 全部时刻取 `deps.clock?.now() ?? Date.now()`（缺省墙钟=独立调用方生产语义，风格同 loadConfig 缺省 env）；GoalHost.start 始终传与 runner 同源时钟——专测断言对账刷新的 lastProgressAt == 假时钟值（非墙钟 ~1.7e12）。
- ③ **pidfile（M69）**：`<stateDir>/daemon.pid`（0600）——O_EXCL（"wx"）独占创建防并发双启竞态；已存在且 pid 活（kill(0) 不抛 / EPERM）→ `DAEMON_ALREADY_RUNNING` 显式拒绝；ESRCH 陈旧 → 覆写留痕；本进程残留 → 覆写；内容非法 → `DAEMON_PIDFILE_INVALID` 不代删（头注决策）。stop 仅当内容为自身 pid 才清除；清除失败 stderr 可见不阻断停止（残留按陈旧语义下次启动自愈，显式登记非静默）。

## 2. TDD 证据

- **RED**：先写 `test/daemon-goals.test.ts`（19 用例）→ `Cannot find module '../src/daemon-goals'`（模块不存在，0 pass）。
- **GREEN 迭代**：
  1. 实现 state/runner 接缝 + daemon-goals + daemon 接线 → 16/19；
  2. 隔离用例失败（A 未 complete）→ **最小复现追到 runner 层真缺陷**（见 §4-1）→ 修 quiescePump → 新增 runner 回归测试先红（steps 断言自身写错，修正语义后绿）；
  3. blocked-pause 409 缺口（宿主层只拦非在册路径）→ 补在册路径拦截 → 绿；
  4. pidfile 两处断言误用 message 含 code → 改断言 `BridgeError.code` → 全绿。
- 最终：全量 407 计数 0 fail，typecheck rc=0。

## 3. 文件清单

| 文件 | 变更 | 行数 |
|---|---|---|
| `src/daemon-goals.ts` | 新建：GoalHost/TickLoop/defaultTickLoop/parseCreateInput/审计队列 | 533 |
| `src/daemon.ts` | /goals* 路由 + 错误映射 + 请求体上限 + pidfile + health actives + 501 | 625 |
| `src/core/goal/runner.ts` | GoalState 增 workdir/maxRounds/autoNudge；RunnerDeps.autoNudge；停滞看门狗开关；**quiescePump 排空窗口修复** | 894 |
| `src/core/goal/state.ts` | ReconcileDeps.clock（M72）；导出 requireValidGoalId/auditFilePath；新可选字段形状校验 | 530 |
| `test/daemon-goals.test.ts` | 新建：19 用例（全流程/控制/阻断恢复/分页/隔离/对账/autoNudge/pidfile/501/校验/卫生） | 713 |
| `test/runner.test.ts` | 增 quiesce 同块连推 2 用例（回归钉死） | 658 |

## 4. 自审发现（重要度降序）

1. **【已修复·真缺陷】quiescePump 排空判据窗口不足（T3-03 遗留，集成测试实证）**：单轮 feedCount 采样在 async generator 唤醒管线（恢复→yield→泵续，实测 2~3 个微任务轮）未走完时误判"已排空"——同一同步块内连推的多信号会迟到 tick 决策之后（done 核验被推迟一轮 tick；信号不丢失）。生产影响：structured 传输缓冲突发多信号 + 定时 tick 同块时，反应延迟 ≤1 个 sweep 周期（5s），不悬挂。修复：连续 4 轮稳定窗口（覆盖管线深度+余量），`test/runner.test.ts` 2 个回归用例（同块步进+done 一次 tick 双过；同块 6 信号压力）钉死。
2. **【设计裁决】blocked 目标 control**：GoalRunner 构造守卫拒绝 blocked 初值（T3-03），宿主归一 paused 构造落实 resume/stop 语义（瞬态不落盘）；pause-on-blocked 显式 409（重复暂停无意义）。若主控认为应由 runner 原生承载，需 T3-03 侧开构造口子（代价小）。
3. **【范围裁决】生产 GoalHost 装配未接 CLI**：`createDaemon` 已支持挂载，但 `cli.ts daemon` 未构造真实传输（任务书 Files 仅列 daemon.ts；传输选型装配与 systemd 归 T3-07）。当前生产 CLI 启动的守护 `/goals*` 返回 501 结构化指引——显式而非静默。
4. **【登记】workdir/maxRounds 无消费者**：API 契约字段，持久化保留（禁静默丢弃用户输入）+ 形状校验；语义消费（会话工作目录/轮次上限熔断）留待后续任务，字段注释已登记。
5. **【登记·边缘】进程内 stop→start 且期间会话死**：reconcile 重建新会话后，在册 runner 仍持旧 ref，下一 tick 走 restartLocked 自建新会话 → reconcile 的新会话成孤儿（FakeTransport 无害；真实传输=一个泄漏 tmux 会话）。窄边缘（生产重启=进程级，无陈旧名册），GoalRunner 无 dispose API 故未在本任务扩接口；建议 T3-07 服务化时以"roster 随 reconcile 结果重建"消化。
6. 审计追加失败不掩盖已生效动作（stderr 结构化留痕，对齐 run.ts R-cr4 先例）；决策日志（RunnerDeps.log）走 stderr 结构化（守护暂无文件日志器）。

## 5. 遗留问题/担忧

- 无阻塞项。Minor：① `handleGoalRoute` 中 `/goals/`（尾斜杠）与 `/goals` 等价（常规 HTTP 语义，未专测）；② `defaultTickLoop` 的生产路径无直接测试（仅手动循环路径被测；unref/合并逻辑简单，T3-07 服务化时建议补一条定时驱动冒烟）；③ sweep 周期 5s 内多目标串行 tick 的最坏延迟未设上限（当前规模无关紧要，百级目标时再议分片）。
- 测试计数 386 → 407（+21：daemon-goals 19 + runner 2）；既有 386 全部保持绿色。
