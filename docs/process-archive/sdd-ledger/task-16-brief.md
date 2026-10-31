### Task 16: 监督状态机（T3-03）

**Files:**
- Create: `src/core/goal/runner.ts`；Create: `test/runner.test.ts`

**Interfaces:**
- Produces：
```ts
export type GoalPhase = "active" | "paused" | "blocked" | "complete" | "stopped";
export interface GoalState { goalId: string; objective: string; verify: string[]; phase: GoalPhase; rounds: number; steps: number[]; strikes: number; injected: string[]; lastProgressAt: number; session?: SessionRef; auditId?: string; }
export interface RunnerDeps { clock: { now(): number }; transport: CodeartsTransport; audit(e: object): void; log(e: object): void; thresholds: BridgeConfig["thresholds"]; verifyRun?(cmd: string[]): Promise<{ok:boolean; out:string}>; }
export class GoalRunner {
  constructor(init: GoalState, deps: RunnerDeps);
  tick(): Promise<GoalState>;                  // 纯 tick；测试用假时钟推进
  pause(): void; resume(): Promise<GoalState>; stop(): Promise<GoalState>;
  state(): Readonly<GoalState>;
}
```
- 规则（spec §6.3.2）：停滞 60s→注入 `CONTINUE_PROMPT`；错误（signal t=error 且 retryable）→重试（无次数上限，间隔 60s 封顶，连续≥10 告警）；进程死→`stop+start` 重建+`buildResumeContract`；strikes≥3 告警不终止；done+verify 双过→complete；paused 不 tick 注入。
- Consumes: T3-02 协议、T2-01 FakeTransport。

- [ ] **Step 1: 写失败测试**（假时钟 + FakeTransport 脚本；每条=一个回归用例）：
  - `stall: 无新信号推进 60s -> 注入 CONTINUE_PROMPT（一次）；再 60s 无进展 -> 再注入`
  - `fast output: 3s 内 >=12 块 -> 不打断（不注入）`
  - `重绘欺骗：文本重复重绘不刷新 lastProgressAt（指纹=文本变化量+步骤推进）`
  - `error retryable: 立即重试；连续失败 -> 退避 60s 封顶；10 次后告警事件（不停止）`
  - `error fatal: 转 blocked（等人工），审计原因`
  - `process death: alive=false -> 重建会话 + buildResumeContract 注入（断点续跑）`
  - `strikes: 连续 3 次恢复无进展 -> strike>=3 告警；此后仍继续重试`
  - `done double-pass: done 标记 + verifyRun ok -> complete；verify fail -> 注入失败原因继续`
  - **Review-Focus-5**：`pause 与 tick 并发：pause 后并发 tick 不产生注入（串行化断言）`
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: Commit**：`codearts-bridge(T3-03): 监督状态机 — 停续/无限重试/进程死续跑/双过验收/strikes/并发串行化`

