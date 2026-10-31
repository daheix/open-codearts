### Task 7: hygiene 治理（T1-07）

**Files:**
- Modify: `src/core/health.ts`；Create: `test/hygiene.test.ts`

**Interfaces:**
- Produces:
```ts
export type HygieneAction = { kind: "purge-dumps"; files: string[] } | { kind: "wal-checkpoint" } | { kind: "rotate-logs"; keep: number };
export async function planHygiene(cfg, opts: { olderThanDays?: number; logsKeep?: number }): Promise<HygieneAction[]>;
export async function applyHygiene(cfg, actions: HygieneAction[]): Promise<{ applied: string[]; auditId: string }>;
```
- Consumes: T1-06 的采集；`bun:sqlite` 用于 WAL checkpoint。

- [ ] **Step 1: 写失败测试**：
  - `plan purge-dumps 仅列超过 olderThanDays 的 dump-*.heapsnapshot（dry-run 列表 = apply 实际删除清单，逐一断言）`
  - `wal-checkpoint: 预置含 WAL 的 sqlite 文件，apply 后 wal 尺寸显著下降且数据完整（重开可读）`
  - `rotate-logs: 保留最近 keep 个 kernel-*.log，其余删除（清单一致）`
  - `apply 记录审计 hygiene.apply（含删除清单）`
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: Commit**：`codearts-bridge(T1-07): hygiene — dumps 清理/WAL checkpoint/日志轮转，dry-run 与执行清单一致`

