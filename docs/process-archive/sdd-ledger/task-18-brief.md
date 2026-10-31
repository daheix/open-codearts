### Task 18: 守护-目标对接（T3-05）

**Files:**
- Modify: `src/daemon.ts`；Create: `test/daemon-goals.test.ts`

**Interfaces:**
- Produces（完成 spec §7.2 API）：
  - `POST /goals { objective, verify?, workdir?, maxRounds? }` → 建 GoalState+启动 tick 循环（setInterval 5s + 事件驱动）→ `{ goalId }`
  - `GET /goals`、`GET /goals/:id`、`GET /goals/:id/logs?cursor=`、`POST /goals/:id/control { action }`
- Consumes: T3-03/T3-04、T2-01（transport 注入以便测试）。

- [ ] **Step 1: 写失败测试**（daemon + FakeTransport + 假时钟驱动）：
  - `start -> status 到 complete 全流程（fake 完成脚本）`
  - `control pause -> phase=paused 且不再注入；resume -> 注入继续；stop -> 终态`
  - `logs 分页：cursor 前进、顺序稳定`
  - `并发 start 两个目标互不影响（独立状态隔离）`
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: Commit**：`codearts-bridge(T3-05): 守护目标 API — 全流程/控制/日志分页/多目标隔离`

