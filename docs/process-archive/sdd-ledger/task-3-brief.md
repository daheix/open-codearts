### Task 3: 安装状态探测（T1-03）

**Files:**
- Create: `src/core/errors.ts`、`src/core/install.ts`；Create: `test/install.test.ts`、`test/fixtures/install-fixtures.ts`

**Interfaces:**
- Produces:
```ts
export class BridgeError extends Error { code: string; remediation?: string; }  // code 如 BIN_MISSING_NO_BACKUP
export interface InstallStatus {
  path: string; present: boolean; version?: string; sha256?: string;
  backupPath: string; backupValid: boolean;
  autoupdateFlag?: boolean; drift: boolean;   // drift: 版本/哈希与钉版记录不一致
}
export async function probeInstall(cfg: BridgeConfig): Promise<InstallStatus>;
```
- Consumes: `BridgeConfig`（T1-02）；fixture 工厂 `makeInstallFixture(dir, kind: "healthy"|"missing"|"only-delete"|"bad-hash"|"bad-version")`。
- 命令执行注入：`interface Exec { run(cmd: string[]): Promise<{code:number; stdout:string; stderr:string}> }`，测试用 fake（不真跑二进制）；`--version` 解析 `26.10.9`。

- [ ] **Step 1: 写失败测试** `test/install.test.ts`：
  - `healthy: present=true, backupValid=true, drift=false`
  - `missing-with-valid-backup: present=false, backupValid=true（供 repair 使用）`
  - `only-delete: present=false, backupValid=false, 且 probe 不抛错`
  - `bad-hash: drift=true`
  - `autoupdate flag 读取 codearts_cli.json；true 时 status 中如实呈现`
  - Review-Focus-1 断言：`missing 且无备份时 probe 返回状态而非抛错；后续 repair 才给结构化错误`（T1-04 落实错误分支）
- [ ] **Step 2: 跑测试确认失败**：`bun test test/install.test.ts` → FAIL
- [ ] **Step 3: 实现**（文件系统读 + Exec 注入 + 钉版记录 `<stateDir>/pinned.json`；探测逻辑对每种 fixture 给出上述字段）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit**：`codearts-bridge(T1-03): 安装状态探测 — 五类 fixture、钉版/哈希/备份/autoupdate 全量状态`

