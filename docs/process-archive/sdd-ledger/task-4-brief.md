### Task 4: 备份与自愈修复（T1-04）

**Files:**
- Create: `src/core/fsx.ts`；Modify: `src/core/install.ts`；Create/Modify: `test/fsx.test.ts`、`test/install.test.ts`

**Interfaces:**
- Produces:
```ts
// fsx.ts
export function sameDevice(a: string, b: string): Promise<boolean>;      // st_dev 比较
export async function atomicWriteFile(p: string, data: string | Uint8Array, mode?: number): Promise<void>; // 同目录 tmp+rename
export async function copyDeploy(src: string, dst: string, mode?: number): Promise<void>; // copy + fsync + chmod，禁 rename
export async function sha256File(p: string): Promise<string>;
// install.ts
export interface RepairResult { action: "restore-from-backup"; from: string; to: string; sha256: string; auditId: string; }
export async function repairInstall(cfg, exec: Exec, opts?: { fixAutoupdate?: boolean }): Promise<RepairResult>;
// 失败分支：BridgeError(code=BIN_MISSING_NO_BACKUP, remediation="官方安装包重装指引 + 升级入口链接")；BACKUP_INVALID_HASH
export async function ensureBackup(cfg, exec: Exec): Promise<void>;  // 备份缺失/失效则从当前有效二进制 copy 补齐
```
- Consumes: T1-03 的 `probeInstall`。

- [ ] **Step 1: 写失败测试**：
  - `fsx.test.ts`：`sameDevice(/tmp, <repo> .tmp) === false`（本机 ZFS 双数据集）；`copyDeploy 后目标哈希一致且 mode=755`；`atomicWriteFile 无半写（崩溃注入：写 tmp 后中断，目标仍完整）`
  - `install.test.ts` 新增：`repair: only-delete 场景从备份恢复成功（哈希+版本校验+auditId）`；`repair: 无备份 -> BridgeError(BIN_MISSING_NO_BACKUP) 含 remediation`；`repair: 备份坏哈希 -> BridgeError(BACKUP_INVALID_HASH)`；`ensureBackup: 缺失即补齐`；`repair fixAutoupdate: 显式动作把 true 修正为 false 并审计`
  - Review-Focus-1：`repair 对只读目录 -> 结构化 IO 错误含路径与原因`
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（审计写 `<stateDir>/audit/install.jsonl`：`{ts, kind:"repair", from, to, sha256, auditId}`）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit**：`codearts-bridge(T1-04): 备份与自愈 — 原子写/同数据集检查/copy 部署/显式错误分支/autoupdate 修正`

