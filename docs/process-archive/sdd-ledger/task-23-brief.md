### Task 23: 真机验收（T4-02）

**Files:**
- Create: `plugins/codearts-bridge/.tmp/acceptance-log.md`（证据记录，.tmp 不提交；完成摘要进操作记录）

- [ ] **Step 1: 真机小目标（PTY 模式）**：真实 codearts TUI + 一个可在 15 分钟内完成的小目标（含 verify 命令）；记录：轮次、注入、完成验收、审计摘录
- [ ] **Step 2: 中断演练**：目标进行中 `kill -9` 会话进程 → 自动重建续跑至完成；`kill -9` 守护 → systemd 拉起 + 对账续跑；全程录像/日志留证
- [ ] **Step 3: 若用户已配置 AK/SK**：structured 真机冒烟（`codearts_run` 一轮 + 小目标）；否则在报告中如实标注"未配置，PTY 已验收"（不虚报）
- [ ] **Step 4: 验收判据核对**（spec §10.1 M2/M3 判据逐条勾选）
- [ ] **Step 5: Commit**（无代码变更则记录摘要到操作记录任务）

