### Task 15: 完成协议移植（T3-02）

**Files:**
- Create: `src/core/goal/protocol.ts`；Create: `test/protocol.test.ts`

**Interfaces:**
- Produces：
```ts
export const GOAL_PLAN_MARK = "[GOAL-PLAN]"; export const GOAL_DONE_MARK = "[GOAL-DONE]";
export const CONTINUE_PROMPT = "继续完成剩余任务";
export function buildContract(objective: string, verify: string[]): string;
export function buildResumeContract(state: { objective: string; doneSteps: number[]; totalSteps?: number }): string;
export function parseProgress(text: string): { plan?: string[]; steps: { n: number; title: string }[]; done: boolean };
export function stripInjectionEcho(text: string, injected: string[]): string;
export function hasRealContent(text: string): boolean;  // 逐字符 isLetterOrNumber + CJK 区间（v0.2.6 教训）
```
- 移植源：`/home/wsc/codeartsGUI/src/goalprotocol.cpp` 与 `tests/test_goalrunner.cpp`（22 用例语义逐条搬运）。
- Consumes: 无（纯函数）。

- [ ] **Step 1: 写失败测试**（用例名对齐 C++ 原语义）：
  - `contract contains objective, verify commands, [GOAL-PLAN]/[GOAL-DONE] 说明`
  - `parseProgress: 步骤行 "n/N … | 推荐方案: …" 解析；[GOAL-DONE] 置 done`
  - `echo guard: 注入文本回显（含 [GOAL-DONE] 字样）剥离后不产生 done`
  - `hasRealContent: 纯 CSI/私有标记/退格符 -> false；CJK/字母数字 -> true`
  - `stripAnsi 类边界：ESC[?25h 私有标记整体消费（v0.2.6 修过的 bug 回归）`
- [ ] **Step 2~4: TDD 循环**（对照 C++ 用例表逐条勾）
- [ ] **Step 5: Commit**：`codearts-bridge(T3-02): 完成协议移植 — 契约/步骤解析/回显守卫/ANSI 边界，对齐 22 用例语义`

