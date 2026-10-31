### Task 21: M3 故障矩阵（T3-08）

**Files:**
- Create: `test/matrix.test.ts`

**Interfaces:**
- Consumes: 全部 M3。

- [ ] **Step 1: 写矩阵测试**（daemon+插件层，FakeTransport/可控注入；每格为独立用例）：
  1. 模型错误（连续 retryable）→不停止直至完成（fake 第 5 次成功）
  2. 网络类错误注入（ECONNRESET/timeout 事件）→同上
  3. 杀回合进程（alive=false）→重建+断点续跑→完成
  4. 杀守护（stop+重新 start）→reconcile→续跑→完成（幂等断言）
  5. opencode 服务重启（插件重载：setup 重跑）→守护不受影响，工具恢复可用
  6. 回显防护（PTY 脚本注入含 `[GOAL-DONE]` 回显）→不误判
  7. 双过验收（自报 done + verify 命令失败→继续；再成功→complete）
  8. pause/resume/stop 在活跃目标上即时生效
- [ ] **Step 2: 全部通过**：`bun test` 全绿 + `typecheck`
- [ ] **Step 3: Commit**：`codearts-bridge(T3-08): M3 故障矩阵 — 八格全过，永不挂起语义闭环`

---

## M4 · 落地

