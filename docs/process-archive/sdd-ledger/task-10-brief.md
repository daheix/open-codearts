### Task 10: PTY 宿主 · script(1)（T2-02）

**Files:**
- Create: `src/core/transport/pty-script.ts`；Create: `test/transport-script.test.ts`、`test/fixtures/fake-codearts/fake-tui.sh`

**Interfaces:**
- Produces：
```ts
export function createScriptTransport(exec: { spawnPty(args: string[], env: NodeJS.ProcessEnv): PtyChild }): CodeartsTransport;
export interface PtyChild { pid: number; onData(cb: (chunk: string) => void): void; write(data: string): void; kill(): void; alive(): boolean; }
```
- 注入两段式：`write(text)` → 120ms → `write("\r")`（v0.2.6 教训：文本+回车同块会被当粘贴吞掉）。
- 日志信号源：tail `<KERNEL_DATA_DIR>/log/kernel-*.log` 增量，`service=` 行作为 output 信号补充（spec F5 信号优先级）；日志源不可用（无文件/轮转）不影响运行，来源可用性在 `snapshot.meta` 中如实标注。
- Consumes: T2-01 接口。

- [ ] **Step 1: 写失败测试**（`fake-tui.sh`：读到文本回显 `[RX:<text>]`；单独收到 `\r` 打印 `[ENTER]`；支持 `--scenario stall|error|exit`）：
  - `two-step submit: 断言 fake-tui 收到两次独立写入（文本与回车分离，120ms 间隔可注入时钟）`
  - `observe: 回显与 [ENTER] 依序成为 output 信号`
  - `log tail: fake-tui 向日志文件追加 service=om 行 -> observe 产出对应 output 信号；日志文件缺失 -> 来源标记不可用且不抛错`
  - `exit 场景：进程死后 alive()=false 且 observe 结束（不挂起）`
  - `stop: 调 kill 且 PID 回收`
- [ ] **Step 2~4: TDD 循环**（PTY 读取用 `script -qefc` 包装实跑 fixture；测试允许真实 spawn bash fixture，但禁止依赖网络）
- [ ] **Step 5: Commit**：`codearts-bridge(T2-02): script(1) PTY 宿主 — 两段式提交/信号化读取/请求级存活检查`

