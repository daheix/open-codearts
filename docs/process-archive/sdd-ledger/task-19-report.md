# Task 19 报告：插件目标工具与回呼（T3-06）

- **Status: DONE**
- Commit: `f736a61216`（`codearts-bridge(T3-06): 目标工具与回呼 — 守护代理/显式不可用错误/终态通知`）
- 分支：`codearts-bridge`（worktree e5785e）；BASE `ef26e2394b`

## 一、实现内容

### 1. 文件组织（偏离任务书 Files 清单，已登记依据）
任务书 Files 仅列 `src/server.ts` + `test/goal-tools.test.ts`。实测 server.ts 已 730 行，叠加六工具 + 薄代理 + 回呼轮询（约 +500 行）将突破 **单文件 ≤1000 行** 仓库铁律 → 按 **T1-05 upgrade.ts 独立成文件的既有主控裁决先例**（Task 5 Ruling："保持单文件 ≤1000 铁律……逻辑落新文件"），目标域实现独立成 `src/goal-tools.ts`，server.ts 仅做装配（+88 行 → 818 行）。文件归属裁决已在 goal-tools.ts 头注与 server.ts R-t6 注释登记。

### 2. 薄代理内核（R-g1/R-g2）— `daemonRequest` 唯一出口
- **鉴权**：每次调用读 `<stateDir>/daemon-token`（路径唯一真相 = `daemon.ts daemonTokenPath`，零第二真相源），`Authorization: Bearer <token>`；POST 附 `Content-Type: application/json`；10s 超时（`AbortSignal.timeout`）。
- **2xx** → JSON 原样返回（透传载荷）。
- **非 2xx 结构化错误体** `{error:{code,message,remediation?}}` → 原样构造 `BridgeError`，经 server.ts R-t1 出口三字段**零改写**落 content —— 501 `GOAL_HOST_DISABLED`（含 remediation）同路径透传 ✓。
- **fetch 失败（ECONNREFUSED/超时）** → `DAEMON_UNAVAILABLE`，remediation 含 `codearts-bridge daemon` 启动指引；**不自动启动守护**（启动接线属 T3-07，裁定 R-g2）。
- **token 缺失（ENOENT）** → `DAEMON_UNAVAILABLE`（守护从未启动——token 由守护首启生成，文件缺失即不可用，属不可达口径）；其他读错误 → `FS_READ_FAILED`；空文件 → `DAEMON_TOKEN_INVALID`（与守护侧同码同义）。
- **响应非 JSON / 错误体形态非法 / POST /goals 响应缺 goalId** → 新错误码 `DAEMON_RESPONSE_INVALID`（显式报错禁猜，已登记 errors.ts 开放 string 约定）。

### 3. 六工具（`createGoalTools`，全部薄代理、不设权限门——spec §6.5 权限清单仅列 upgrade/repair/hygiene，与 codearts_run 同口径）
| 工具 | 守护端点 | 要点 |
|---|---|---|
| `codearts_goal_start` | POST /goals | objective/verify/workdir/maxRounds/autoNudge 透传；**R-g4**：`initiatedBy: ctx.sessionID` 随 body 透传（守护 `parseCreateInput` 仅取已知键、未知字段前向容忍——读码实证，无需降级路径）；成功后本地登记 `goalId→sessionID`（回呼通知目标）；响应缺 goalId 显式报错 |
| `codearts_goal_status` | GET /goals/:id | goalId 经 `requireValidGoalId`（与守护同源白名单，路径穿越拒绝面单一真相） |
| `codearts_goal_list` | GET /goals | 数组载荷透传 |
| `codearts_goal_logs` | GET /goals/:id/logs?cursor=&limit= | cursor 非负整数/limit 正整数显式校验；参数缺省时无 query 串 |
| `codearts_goal_control` | POST /goals/:id/control | action 三值白名单（pause/resume/stop），非法 TOOL_INPUT_INVALID 且零网络请求 |
| `codearts_daemon_status` | GET /health | 健康载荷透传；不可达 → `DAEMON_UNAVAILABLE` + 启动指引（显式，不静默假装） |

### 4. 回呼轮询（R-g3，**尽力通知，非投递保证**——头注与工具描述均已写明）
- `createGoalCallbackLoop` + `defaultGoalPollLoop`：生产 setInterval 30s（`GOAL_POLL_INTERVAL_MS` 唯一真相）+ **unref**（不悬挂测试/卸载）；**tick 返回 Promise**（可等待宿主能 await 单轮；default loop 自带 .catch 框架级兜底日志）。
- **setup 注册、unload 清理**：buildPlugin.setup 末尾装配；cleanup 恒返回（registration 缺席也摘定时器）。
- **快照对比、恰好一次**：`goalId→告警级别` Map，级别单调升级才通知；分级 终态(complete/stopped)=3 > blocked=2 > strikes≥cfg.thresholds.strikes=1 > 无=0。首见即终态且为本实例发起 → 通知（覆盖 goal_start 后 30s 内快完成路径）；其余首见仅记基线（防插件重载后对历史终态目标刷屏）。
- **通知通道**：`ctx.session.synthetic({sessionID, text})`（宿主 session 域缺失 → 无通道，显式语义）；文本含 objective/goalId/rounds 供会话续查。
- **失败路径全部"仅审计不阻塞"**：发起会话未知/无通道 → `goal.notify-skipped` 审计；synthetic 抛错 → `goal.notify-failed`（warn）不重试；轮询失败/响应非数组 → `goal.poll-failed`（warn）下轮重试；审计写失败 → stderr 结构化留痕（禁静默吞错）。
- **零通知对象优化**：会话表空（本实例未发起任何目标）→ 跳过网络轮询（显式语义注释；空闲 opencode 实例零守护流量）。
- **审计词表登记**（appendInstallAudit）：`goal.notify` / `goal.notify-failed` / `goal.notify-skipped` / `goal.poll-failed`。

### 5. server.ts 装配
- `TOOL_NAMES` 扩至 12（既有 server.test.ts 逐名精确断言自动覆盖新集合，全绿）。
- `ToolDeps` 增 4 注入缝：`daemonFetch`（六工具与轮询共用，测试 fake 绝不联网）、`goalSessions`（buildPlugin 显式单实例下发，杜绝工具/轮询各持一份）、`goalPollLoop`（测试手动驱动，绝不真等 30s）、`goalPollIntervalMs`。
- `ToolCtxLike` 改为 export（goal-tools.ts 类型复用，type-only import 无运行时环）。
- status 工具 transport.note 措辞更新为如实状态（目标域已接入守护 HTTP；run 常驻通道仍未接入）。

## 二、TDD 证据

- **RED**：先写 `test/goal-tools.test.ts`（15 用例）→ `bun test test/goal-tools.test.ts` → `error: Cannot find module '../src/goal-tools'`（0 pass / 1 fail）。
- **实现后迭代**：首轮 11 pass / 4 fail —— 根因①：tick 以 `void pollOnce()` 启动即忘，手动测试 loop `await fire()` 等不到单轮完成 → 改为 tick 返回 Promise（生产 default loop 的 .catch 兜拒绝）；根因②：自带用例"session 缺失→仅审计"与会话表空早退优化相抵 → 重写用例为语义精确形态（表非空但 goalId 不在表 → notify-skipped/session-unknown）。
- **GREEN**：15/15 pass；全量 `bun test` **422 计数（421 pass + 1 skip）/ 0 fail / 1946 expect**（BASE 407=406+1skip，+15 新用例，存量零回归）；`bun run typecheck` **零错误**。

## 三、文件清单

| 文件 | 变更 | 行数 |
|---|---|---|
| `plugins/codearts-bridge/src/goal-tools.ts` | 新建（六工具+薄代理+回呼轮询） | 702 |
| `plugins/codearts-bridge/src/server.ts` | 修改（装配/TOOL_NAMES/ToolDeps/cleanup） | 818 |
| `plugins/codearts-bridge/test/goal-tools.test.ts` | 新建（15 用例） | 504 |

全部 ≤1000 行 ✓。提交仅含 `plugins/codearts-bridge`；工作区根 `opencode.json`/`.codeartsdoer/package.json` 的既有本地改动未触碰、未提交 ✓。

## 四、自审发现（已处理）
1. **块注释内 `goal_*/daemon_status` 的 `*/` 提前终止注释**（编译错误）→ 改"goal_* 与 daemon_status"。
2. **tick 启动即忘**使可等待性丢失（见 TDD 根因①）→ tick 返回 Promise，测试 loop 与生产 loop 两种宿主语义均正确。
3. **轮询响应非数组**（守护契约破坏）原本会以 TypeError 逃逸到框架 catch → 补显式 `Array.isArray` 守卫 + `goal.poll-failed` 审计（禁猜形）。
4. **会话表空早退**与用例语义冲突（见 TDD 根因②）→ 保留早退（空闲实例零网络），用例改为精确语义。
5. status 工具 transport.note"尚未接入"措辞在 T3-06 后不再如实 → 已更新。

## 五、遗留问题/担忧（不阻塞，供后续任务）
1. **goal_start 后插件重载**（opencode 重启）→ 本地 goalId→sessionID 映射丢失，该目标的终态/告警不再通知（尽力通知口径的既定边界，审计有 goal.notify-skipped 不留痕——映射丢后连 skipped 也不产生，因首见即基线）。若需跨重载通知，后续可把映射持久化到 stateDir（登记，未做——YAGNI，任务书未要求）。
2. **daemon_status 依赖 token 文件在场**：token 文件被外力删除而守护仍在跑的边缘场景会误报 UNAVAILABLE（/health 本免鉴权）；属配置损坏场景，显式报错可接受，已注释说明。
3. **轮询失败逐次审计**：守护长期不在时 install.jsonl 每 30s 一条 warn（约 500KB/天）；未做连续失败去重（裁定只要求"失败仅审计不阻塞"，最小实现）；后续可在 hygiene/守护侧治理。
4. **通知只覆盖本实例发起的目标**：跨 opencode 实例的通知不在本轮范围（守护侧通知通道属后续演进空间）。
5. GoalHost 生产装配（守护进程内挂载）仍归 T3-07——插件侧已按 501 GOAL_HOST_DISABLED 透传显式暴露该状态。

## 六、验收对照（任务书/裁定逐条）
- Step1 测试两条指定路径 ✓（goal_start 代理 POST 返回 goalId；连接失败 → DAEMON_UNAVAILABLE 且 remediation 含启动命令；终态后 synthetic 恰一次；session 缺失仅审计）。
- R-g1 ✓（薄代理/透传/501 原样含 remediation）；R-g2 ✓（DAEMON_UNAVAILABLE+启动指引、不自动启动）；R-g3 ✓（30s/setup 注册/unload 清理/快照对比/synthetic/失败仅审计/"尽力通知非投递保证"注释）；R-g4 ✓（initiatedBy 透传，守护容忍已读码实证并测试断言 body 含该字段）。
- 全局约束 ✓：无静默 fallback（一切失败显式错误/审计/stderr）；BridgeError 结构化；中文注释；≤1000 行；bun test 全绿 + typecheck 零错误；提交格式与范围符合合同。
