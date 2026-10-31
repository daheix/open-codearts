### Task 11: PTY 宿主 · tmux（T2-03）

**Files:**
- Create: `src/core/transport/pty-tmux.ts`；Create: `test/transport-tmux.test.ts`

**Interfaces:**
- Produces：`export function createTmuxTransport(cfg, exec): CodeartsTransport;`；会话命名 `codearts-<slug>`；`start` 幂等（已存在则重连）；`snapshot` 用 `capture-pane -p`。
- Consumes: T2-01；tmux 探测：`mkdirpx().available()`。

- [ ] **Step 1: 写失败测试**（注入 tmux 命令执行器 fake；`tmux` 不存在时覆盖显式错误）：
  - `tmux 缺失 -> BridgeError(PTY_HOST_UNAVAILABLE, remediation="sudo apt install tmux 或 ptyHost=script")`（不静默降级）
  - `start 幂等：new-session 已存在 -> list-sessions 命中 -> 重连不重建`
  - `inject: send-keys 序列 = [文本, Enter] 两次独立调用`
  - `kill-session 后 alive=false`
  - 有 tmux 环境（`which tmux`）时：标记 `describe.skipIf(!hasTmux)` 真机用例一套（attach 语义不测）
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: Commit**：`codearts-bridge(T2-03): tmux PTY 宿主 — 幂等重连/两段式注入/显式缺失错误/条件真机用例`

