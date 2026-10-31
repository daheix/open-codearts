### Task 13: `codearts_run` 工具与 M2 验收（T2-05）

**Files:**
- Modify: `src/server.ts`；Create: `test/run-tool.test.ts`

**Interfaces:**
- Produces：`codearts_run({ prompt, session?, timeoutMs? })`：`transport` 由配置选择（auto：有 AK/SK→structured，否则→pty）；`context.progress({status})` 每 2s 或每信号批次更新；`context.signal` 触发 `stop()`；返回 `{ session, summary, signals: n, auditId }`；审计 `run.start/run.exit`。
- Consumes: T2-01~T2-04、T1-08 权限模式。

- [ ] **Step 1: 写失败测试**（fake 传输 + fake ctx）：
  - `auto 选择逻辑：aksk 存在->structured；缺失->pty；并在返回值中说明所选模式与原因`
  - `progress 至少被调用一次且含状态文本；signal abort -> stop() 被调`
  - `错误路径：transport 报 retryable 错误 -> 工具返回可重试标记与摘要（不静默重试——重试属目标引擎职责）`
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: M2 验收**：`bun test` 全绿 + `typecheck`；PTY 真机冒烟：用 `script` 宿主对真实 codearts 注入一轮并捕获输出（记录到任务说明；不要求完成对话）
- [ ] **Step 6: Commit**：`codearts-bridge(T2-05): codearts_run 工具 — auto 传输选择/进度/取消/显式错误，M2 全绿`

---

## M3 · 目标引擎

