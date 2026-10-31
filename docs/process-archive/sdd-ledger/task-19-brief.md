### Task 19: 插件目标工具与回呼（T3-06）

**Files:**
- Modify: `src/server.ts`；Create: `test/goal-tools.test.ts`

**Interfaces:**
- Produces：`codearts_goal_start/status/list/logs/control`（经 `daemonUrl` HTTP）；`codearts_daemon_status`（未运行→安装/启动指引，显式）；回呼：插件轮询 30s，目标终态/告警→`ctx.session.synthetic`（尽力通知，失败仅审计）。
- Consumes: T3-05 API、T1-08 工具模式。

- [ ] **Step 1: 写失败测试**（注入 fake fetch）：
  - `goal_start 代理 POST 并返回 goalId；daemon 拒绝（连接失败）-> BridgeError(DAEMON_UNAVAILABLE, remediation 含启动命令)`
  - `回呼：终态事件后 synthetic 被调用一次；session 缺失->仅审计`
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: Commit**：`codearts-bridge(T3-06): 目标工具与回呼 — 守护代理/显式不可用错误/终态通知`

