### Task 17: 持久化与对账（T3-04）

**Files:**
- Create: `src/core/goal/state.ts`；Modify: `src/daemon.ts`；Create: `test/state.test.ts`

**Interfaces:**
- Produces：
```ts
export async function saveGoal(stateDir, s: GoalState): Promise<void>;   // atomicWriteFile
export async function loadGoals(stateDir): Promise<GoalState[]>;
export async function appendAudit(stateDir, goalId: string, e: object): Promise<string>; // 返回 auditId
export async function reconcile(stateDir, deps: { transport: CodeartsTransport }): Promise<{ resumed: string[]; blocked: string[] }>;
// reconcile：未终态目标 -> alive(session) 则续 tick；否则重建会话+断点契约；幂等（不双注入：以 injected 指纹去重）
```
- Consumes: T3-03 状态与 T1-04 fsx。

- [ ] **Step 1: 写失败测试**：
  - `atomic save/load 往返一致；损坏 JSON -> 标记该目标 blocked 并审计（不崩守护）`
  - `appendAudit 追加且顺序保持；并发追加不交错（单文件锁串行）`
  - **Review-Focus-4**：`reconcile 幂等：连续两次 reconcile 同目标 -> 第二次不注入（injected 指纹去重）`
  - `reconcile: 会话死 -> 重建+断点契约；重建失败 -> blocked+fatal 审计`
- [ ] **Step 2~4: TDD 循环**（守护接入：启动时 reconcile，周期 tick 集成测试在 T3-05）
- [ ] **Step 5: Commit**：`codearts-bridge(T3-04): 持久化与对账 — 原子状态/审计留痕/幂等恢复`

