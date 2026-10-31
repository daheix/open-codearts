### Task 6: 健康采样（T1-06）

**Files:**
- Create: `src/core/health.ts`；Create: `test/health.test.ts`

**Interfaces:**
- Produces:
```ts
export interface HealthSnapshot {
  rssBytes?: number;                 // 托管进程 RSS（来自注入的 PidProbe）
  dbBytes: number; walBytes: number; // cli-data/opencode.db(.wal)
  dumps: { files: number; bytes: number };   // dump-*.heapsnapshot
  logs: { bytes: number };
  lastErrors: string[];              // 最近 N 条 service=proxy-fetch|upgrade 错误摘要（含 ECONNRESET/timeout）
  kernelRssFromLog?: number;         // 解析 service=om "rssMB=…" 最近一条
}
export async function collectHealth(cfg, deps: { proc?: () => Promise<string> }): Promise<HealthSnapshot>;
```
- Consumes: T1-02 配置。

- [ ] **Step 1: 写失败测试**（fixture：假 cli-data 目录树 + 假 kernel 日志样本，含 `service=om "rssMB=525.64"` 与 `error fetch … ECONNRESET` 行）：
  - `sizes: db/wal/dumps/logs 字节数与文件数正确`
  - `kernelRssFromLog: 取最近一条 rssMB 并换算字节`
  - `lastErrors: 只收 ERROR 级、去重、最多 20 条、含 ECONNRESET 与 timeout`
  - `缺目录时不抛错（返回零值）`——注意：这是"容忍探测"而非掩盖（状态如实报告缺失）
- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现** → **Step 4: 通过**
- [ ] **Step 5: Commit**：`codearts-bridge(T1-06): 健康采样 — DB/WAL/转储/日志/内核自报 RSS/最近错误`

