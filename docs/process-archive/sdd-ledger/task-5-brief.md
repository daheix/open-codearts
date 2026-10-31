### Task 5: 受控升级（T1-05）

**Files:**
- Modify: `src/core/install.ts`；Create: `test/upgrade.test.ts`、`test/fixtures/fake-release.ts`

**Interfaces:**
- Produces:
```ts
export interface Release { version: string; url: string; hash: string; }   // 官方接口字段
export interface Fetcher { latest(): Promise<Release>; download(url: string, dest: string): Promise<void>; }
export const httpFetcher: Fetcher;   // 真实实现（ide.cn-north-4…/v1/release-info/latest + OBS 下载）
export interface UpgradeResult { from: string; to: string; sha256: string; stagingDir: string; auditId: string; }
export async function upgradeInstall(cfg, deps: { fetcher?: Fetcher; exec: Exec }, opts?: { version?: string }): Promise<UpgradeResult>;
```
- Consumes: T1-04 的 `fsx` 原语与 `ensureBackup`。

- [ ] **Step 1: 写失败测试** `test/upgrade.test.ts`（全部用 `fake-release.ts` 注入 Fetcher + fixture 二进制）：
  - `happy path: download->hash 校验->解压(fake tar: 实为 copy fixture)->同数据集暂存->copyDeploy->--version 验证->旧版转 bak->审计含 auditId`
  - **Review-Focus-2**：`staging 目录与 installDir 不同 st_dev -> BridgeError(STAGING_CROSS_DEVICE) 且不动现有安装`
  - `哈希不匹配 -> BridgeError(HASH_MISMATCH)，现有安装零变化（前后哈希断言）`
  - `解压失败（注入）-> 现有安装零变化`；`部署中断（注入 copyDeploy 失败）-> 原二进制仍在原位（零损坏断言）`
  - **Review-Focus-5**：`两个 upgrade 并发 -> 第二个 BridgeError(ALREADY_RUNNING)（single-flight）`
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（暂存强制 `<stateDir>/tmp/staging-<version>`；落地前 `sameDevice(staging, installDir)` 断言；步骤级审计 `upgrade.step`）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit**：`codearts-bridge(T1-05): 受控升级 — 注入式 Fetcher、同数据集暂存、失败零损坏矩阵、single-flight`

