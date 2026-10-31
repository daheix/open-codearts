# Task 5 报告：受控升级（T1-05）

**Status: DONE**
**Commit: `26734d6cf7` — codearts-bridge(T1-05): 受控升级 — 注入式 Fetcher、同数据集暂存、失败零损坏矩阵、single-flight**

---

## 1. 实现内容

### 1.1 `src/core/upgrade.ts`（新建，518 行；R-up1 落新文件）

**接口面（任务书契约 + 裁定增列，无多余导出）**：

| 导出 | 语义 | 裁定依据 |
|------|------|----------|
| `Release { version; url; hash }` | 官方 release-info 字段 | R-up7 |
| `Fetcher { latest(); download(url, dest) }` | 物料获取抽象；测试注入 fake 绝不联网 | R-up7 |
| `httpFetcher` | 真实实现：release-info（响应实测形状 `{result:{version,url,hash}}`，逐字段显式校验 → `RELEASE_INVALID`）+ OBS 下载（`Readable.fromWeb` 流式落盘，不整读入内存；失败清半写包体） | R-up7 |
| `defaultExtract(exec, pkg, destDir)` | `tar -xzf`（经注入 Exec 离线）；非零退出/spawn 失败 → `EXTRACT_FAILED`（stderr 摘要限长 400 仅防日志超长，注释注明） | R-up8 |
| `UpgradeDeps { fetcher?; exec; extract? }` | 任务书 deps + 可选 extract 注入（R-up8 显式登记的偏差） | 任务书 + R-up8 |
| `UpgradeResult { from; to; sha256; stagingDir; auditId }` | `from`=旧可解析版本/`"unknown"`/`"none"` | R-up9 |
| `upgradeInstall(cfg, deps, opts?)` | 受控升级主流程 | R-up2..R-up9 |

**成功路径（R-up9，测试钉死审计步骤顺序）**：
`release → staging(含同数据集断言) → download → hash → extract → layout → self-check → deploy → verify → backup → fsync` + 最终 `upgrade.done`（含 from/to/sha256/auditId），auditId=`upg-<ts>-<6hex>`，与 repair 的 `rep-` 族区分，共用 `install.jsonl` 单一审计流。

**关键设计裁决（均注释依据）**：
- **同数据集断言前置到下载前**：R-up2 要求"部署前"断言，实现放在 staging 创建后、下载前——同为本轮部署前，且免去白下载数十 MB 才失败的浪费（fail-fast）；
- **部署顺序：脚本先、二进制后**——最后一步才动关键件，脚本部署失败时旧二进制原位不动；
- **旧版转备份在复验通过后才落地**（R-up9 字面顺序）：部署前先把旧二进制快照进暂存（同数据集 copy），复验通过再 copyDeploy 成 `codearts.bak-<旧版本>`——**升级失败的运行绝不在 binDir 留下任何新文件**（零损坏面只收不放）；
- **single-flight**（R-up4）：模块级标志在 async 函数体首个 await 前同步检查+置位（并发窗口确定），finally 释放；多进程互斥显式划归 T3-04 状态层（注释登记）；
- **布局识别**（R-up5）：候选 `bin/codearts`/`agentkernel`/`codearts` 首个 ELF 魔数常规文件；可选脚本=提取根目录 `codearts` 且 `#!` 开头、**非二进制本身**（同件消歧有专测）；全无 → `PACKAGE_LAYOUT_INVALID`；
- **钉版不回写**：R-up9 收尾语义不含 pinned.json，升级后以 `probeInstall` 的 drift 口径如实呈现（install.ts 相应注释已校准）。

**错误码清单**（全部 BridgeError + 中文 remediation）：`ALREADY_RUNNING` / `RELEASE_VERSION_MISMATCH` / `STAGING_CROSS_DEVICE` / `HASH_MISMATCH` / `EXTRACT_FAILED` / `PACKAGE_LAYOUT_INVALID` / `PACKAGE_BINARY_INVALID` / `PACKAGE_VERSION_MISMATCH` / `UPGRADE_VERIFY_FAILED`（本文件新增）；`RELEASE_INVALID` / `RELEASE_INFO_FAILED` / `DOWNLOAD_FAILED`（httpFetcher）；FS_* 复用 fsx/install 既有码。

### 1.2 `src/core/fsx.ts`（156→179 行）

`fsyncDir(dir)`（R-up6）：只读打开目录 fd → fsync → close（Linux 允许 O_RDONLY 打开目录）；失败显式 `FS_WRITE_FAILED`；部署与备份的 rename 后对 `<installDir>/bin`（及脚本所在 `<installDir>`）调用。

### 1.3 `src/core/install.ts`（821→824 行，R-up1"净增最小"）

仅三处加 `export`（`statOrEnoent` / `detectVersion` / `appendInstallAudit`）+ 注释校准（钉版写入方说明）；零行为变更。

### 1.4 测试（新增 21 用例：`test/upgrade.test.ts` 623 行 + `test/fixtures/fake-release.ts` 175 行）

- **happy path**：结果契约、二进制/脚本替换+mode 0755、备份内容、binDir 零垃圾（无 deploy-tmp/无 .delete）、download/extract/exec 调用记录（exec 恰 3 次：旧探/自检/复验）、暂存清理、审计 11 步顺序+done 字段+零损坏基线 oldSha256 入审计；
- **Review-Focus-2**：`<stateDir>/tmp` symlink 至真实异数据集（/tmp/opencode，前提自检 st_dev 确异，失效则显式失败）→ `STAGING_CROSS_DEVICE` 且旧二进制逐字节不变、下载零发生；
- **零损坏矩阵**（R-up3）：哈希不匹配 → `HASH_MISMATCH`（前后哈希断言）；解压注入失败 → `EXTRACT_FAILED`（原因保留）；binDir 只读注入 copyDeploy 失败 → `FS_WRITE_FAILED`+EACCES，旧二进制原位、无残留（finally 还原权限）；复验版本不符 → `UPGRADE_VERIFY_FAILED`；
- **Review-Focus-5**：single-flight 门控并发（手工 latest 门 + latestCalled 时序栅栏，确定性窗口）→ 第二个 `ALREADY_RUNNING`；结束后标志释放可串行再升；
- **布局**：候选优先级/agentkernel 回落/ELF-脚本同件消歧/全无 → `PACKAGE_LAYOUT_INVALID`；
- **自检**：无版本标记 → `PACKAGE_BINARY_INVALID`；版本不符 → `PACKAGE_VERSION_MISMATCH`；
- **opts.version**：不符 → `RELEASE_VERSION_MISMATCH`；一致 → 正常升级；
- **defaultExtract**：本地 ustar+gzip 构建（纯 node:zlib，不 spawn tar）+ **真实 tar 进程**解压逐字节+ELF 魔数验证；损坏包 → `EXTRACT_FAILED`；
- **fsyncDir**：既有目录解析；不存在 → `FS_WRITE_FAILED`；
- **分支覆盖**：备份已存在不覆盖（result=exists）/ 无旧安装 from=none / 旧版无版本标记 from=unknown+备份跳过。

fixtures 纪律：content-driven fake exec（按目标文件内容回答 --version，与调用顺序解耦）；全部离线。

## 2. TDD 证据

**RED**（实现前）：
```
$ bun test test/upgrade.test.ts
error: Cannot find module '../src/core/upgrade'
 0 pass | 1 fail | 1 error
```

**GREEN**（实现后聚焦）：
```
$ bun test test/upgrade.test.ts
 21 pass | 0 fail | 109 expect() calls
```

**全量 + 类型**（最终）：
```
$ bun test
 103 pass | 0 fail | 395 expect() calls — Ran 103 tests across 5 files [2.46s]
$ bunx tsc --noEmit → TYPECHECK_OK
```
基线 82 测全绿保持（82 → 103，新增 21，零回归）。中间仅修 2 处类型错误（pipeline 改 `node:stream/promises` 版；fixtures 补 Fetcher 类型导入），无逻辑返工。

## 3. 文件清单

| 文件 | 变更 | 行数 |
|------|------|------|
| `plugins/codearts-bridge/src/core/upgrade.ts` | 新建：受控升级全量逻辑 | 518 ✓≤1000 |
| `plugins/codearts-bridge/src/core/fsx.ts` | 修改：+fsyncDir | 179 ✓≤1000 |
| `plugins/codearts-bridge/src/core/install.ts` | 修改：3 处共享导出+注释校准（净增 3 行） | 824 ✓≤1000 |
| `plugins/codearts-bridge/test/upgrade.test.ts` | 新建：21 用例 | 623 ✓≤1000 |
| `plugins/codearts-bridge/test/fixtures/fake-release.ts` | 新建：fake Fetcher/物料/content-driven exec/ustar 构建 | 175 ✓≤1000 |

提交：`26734d6cf7`（5 files changed, 1355 insertions, 5 deletions）。

## 4. 自审发现

1. **死代码自纠**：初稿 `oldSha256` 计算后未使用——已改为写入 release 审计步骤（零损坏基线可对账，法证价值），并补测试断言。
2. **与任务书的偏差（裁定覆盖，显式登记）**：① 逻辑落新文件 `upgrade.ts`（R-up1），任务书 Files 栏"Modify: install.ts"仅保留共享导出；② deps 增列可选 `extract`（R-up8 要求可注入解压，任务书 deps 字面未含，为可选增列不破坏契约）。
3. **YAGNI 把关**：删去初稿的 `productionDeps` 便捷出口（无调用方）；`parseRelease`/`identifyLayout`/`fileStartsWith` 保持模块私有；未导出 `RELEASE_INFO_URL`（需要时随 status 工具任务再加）。
4. **静默兜底排查**：仅存的三处 `catch(() => undefined)` 均为失败路径资源/垃圾清理且注释注明（finally 暂存回收、httpFetcher 半写包体、fsyncDir 关闭回收），主错误一律照常上抛——与 T1-04 cleanupTmp 同纪律，非行为兜底。
5. **测试真实性**：跨设备用例用真实 st_dev（symlink→异数据集）+ 前提自检（前提失效显式失败）；默认解压器走真实 tar 进程；content-driven exec 使版本断言与调用顺序解耦。

## 5. 遗留问题/担忧

1. **失败终态无审计标记**：R-up9 仅规定成功路径写 `upgrade.done`；失败路径只有已完成的步骤级 `upgrade.step`（含 auditId 可串联），无显式 `upgrade.failed` 终态条目。守护/工具层若需"失败可见性"，届时按裁定增补（本轮严格按契约实现，未擅自扩约）。
2. **多进程并发升级不在本任务范围**：single-flight 为进程内语义；守护进程唯一化（T3-04）落地前，理论上两个独立进程可同时升级——审计流可事后对账，属既定分层边界。
3. **`fsyncDir` 依赖 Bun 对目录 fd 的 fsync 实现**：本机 Bun 1.4.2 + Linux 实测通过（happy path 与专项用例覆盖）；换运行时需留意（用例会第一时间暴露）。
4. **跨设备用例的本机耦合**：依赖 /tmp 与仓库异数据集（本机 ZFS 实况，前提自检兜底）；换机若同设备，用例显式失败提示改用其他异设备对——测试前提问题，非实现缺陷。
5. **httpFetcher 未做真网测试**（按裁定测试全离线）：响应形状校验逻辑有单测等价覆盖（形状分支在 parseRelease），真机冒烟留给计划中的联网任务。

---

## 6. 修复环第 1 轮（2026-10-31，评审发现 I1/I2）

**Status: DONE** — 改动集中在 `src/core/upgrade.ts`（523→617 行）与 `test/upgrade.test.ts`（626→699 行）；`fsx.ts` 未改（既有 `copyDeploy` 即可承载回滚）。

### 6.1 I1：补 `upgrade.start` / `upgrade.fail` 审计（spec §8）

- **`upgrade.start`**：single-flight 置位成功后立即写（`{kind:"upgrade.start", auditId, installDir, requestedVersion}`）。**裁定歧义自主决策**：start 时点尚未联网，release 实际版本不可知（禁为审计提前拉取），故 start 携带 requestedVersion（`opts.version ?? null`），实际版本由紧随其后的 release 步骤审计承载——代码注释已注明该取舍。
- **`upgrade.fail`**：升级主体包入 try/catch，任何失败在 rethrow 前写 `{kind:"upgrade.fail", auditId, code, step, ...回滚细节}`，**原错误原样 rethrow 不变语义**；fail 审计写失败不掩盖主错误（`.catch(() => undefined)`，失败路径纪律同暂存清理，注释注明）。`step` 由贯穿主体的追踪变量提供（start/release/staging/…/done），回滚细节经 `failExtra` 并入同轮唯一 fail 事件（I2 的 rolledBack/snapshotPath 由此承载，避免双 fail 行）。ALREADY_RUNNING（并发第二调用者）在置位前抛出、无 auditId，不产生审计——语义正确（该调用者未开始升级）。

### 6.2 I2：verify 失败先回滚旧版快照（零损坏补洞）

- **①先回滚再抛**：复验失败时（破坏性 rename 已发生）有快照则 `copyDeploy(<staging>/old-codearts, binPath)` 恢复旧内容；无快照（from=none，部署前 binPath 不存在）则移除新部署件恢复"无二进制"原状——维持"失败不在 binDir 留新文件"前提。错误码/消息保持原语义，仅 remediation 如实反映回滚状态。
- **②回滚成功** → fail 审计 `{rolledBack:true}`（无快照场景附 `reason:"no-snapshot"`），暂存照常清理。
- **③回滚失败** → `ownsStaging=false` 保留暂存与快照（finally 不清理），fail 审计 `{rolledBack:false, snapshotPath, rollbackError}`，remediation 含快照路径供人工恢复。
- **快照条件放宽（裁定范围内的必要闭环，显式登记）**：部署前旧版快照条件从 `oldPresent && oldVersion!==undefined` 放宽为 `oldPresent`——否则 from=unknown（旧版无版本标记）场景复验失败时无快照可回滚，与 I2 要修的洞同型。备份落地条件保持 `oldVersion!==undefined`（备份命名需版本号），成功路径"备份在复验通过后才落地"顺序未动；既有"旧版无版本标记→备份跳过"用例原样绿。

### 6.3 测试（21→22 用例，4 处新断言）

| 用例 | 新断言 |
|------|--------|
| happy path | 审计全序列 = start→11×step→done；start.auditId=结果 auditId |
| 哈希不匹配 | upgrade.fail 行（code=HASH_MISMATCH、step=hash）且与 upgrade.start 同 auditId |
| 复验失败（改造） | 回滚后 bin/codearts 字节=旧版原样；fail 审计 rolledBack:true；暂存清理 |
| **新增**：回滚失败 | 注入"复验时点 binDir 置只读"（exec fake 第 2 次 binPath 调用 chmod 0555+版本不符）→ 回滚 copyDeploy 必 EACCES：暂存与快照保留、fail 审计含 snapshotPath、remediation 含快照路径 |

### 6.4 RED→GREEN 证据

**RED**（实现前，`bun test test/upgrade.test.ts`）：
```
18 pass | 4 fail | 107 expect() calls
```
4 fail 恰为新断言：happy 序列缺 start、hash 路径无 fail 审计、verify-fail 后 bin 仍为新内容（未回滚）、回滚失败分支暂存被清（未保留）。

**GREEN**：
```
$ bun test test/upgrade.test.ts → 22 pass | 0 fail | 130 expect() calls
$ bun test                     → 104 pass | 0 fail | 414 expect() calls（基线 103，+1 净增，零回归）
$ bunx tsc --noEmit            → TYPECHECK_OK
行数：upgrade.ts 617 / upgrade.test.ts 699 / fsx.ts 179 —— 均 ≤1000 ✓
```

### 6.5 提交

`codearts-bridge(T1-05): 修复评审发现 — 补 upgrade.start/fail 审计、verify 失败回滚旧版快照 — I1/I2`
