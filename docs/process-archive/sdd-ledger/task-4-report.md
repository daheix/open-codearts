# Task 4 报告：备份与自愈修复（T1-04）

**Status: DONE**
**Commit: `9fff0cd7e8` — codearts-bridge(T1-04): 备份与自愈 — 原子写/同数据集检查/copy 部署/显式错误分支/autoupdate 修正**

---

## 1. 实现内容

### 1.1 `src/core/fsx.ts`（新增三个原语，文件 51→156 行）

| 原语 | 语义 | 裁定依据 |
|------|------|----------|
| `sameDevice(a, b): Promise<boolean>` | `stat` 两路径比较 `st_dev`；任一路径不存在 → `BridgeError(FS_STAT_FAILED)`（显式，禁止静默假定同/异设备） | 任务书接口 |
| `atomicWriteFile(p, data: string \| Uint8Array, mode?)` | 同目录 `.<名>.atomic-tmp-<rand>`（`wx` 独占创建）→ 写全 → `fh.sync()` → 显式 `chmod`（给定 mode 时，umask 无关）→ `rename`；失败清理 tmp、目标原状 | R-fx2 |
| `copyDeploy(src, dst, mode = 0o755)` | 同目录 `.<名>.deploy-tmp-<rand>` **流式**拷贝（不整读入内存，安装二进制可达数十 MB）→ 显式 `chmod` → fsync → `rename`；失败时旧文件原位、tmp 清理、`FS_WRITE_FAILED`（含 src/dst/errno）。rename 发生在同目录（同文件系统），天然满足"禁止跨文件系统 rename" | R-fx1 |

写侧错误统一 `BridgeError(FS_WRITE_FAILED)` + errno 原因码 + cause 保留，与既有 `FS_READ_FAILED/FS_STAT_FAILED` 命名对齐。

### 1.2 `src/core/install.ts`（扩展，文件 418→821 行）

- **`repairInstall(cfg, exec, opts?: { fixAutoupdate?: boolean })`**（R-fx4）：
  1. `fixAutoupdate=true` 时**先**关停 autoupdate（止血优先：即便恢复失败也不再被自动升级破坏；独立审计、幂等）；
  2. 备份发现：① `<bin>.bak-<期望版本>`（期望版本=钉版版本，未钉版取当前二进制 probe 版本）→ ② 扫描 `codearts.bak-*`（排序，去重）；
  3. 逐候选校验（`validateBackupCandidate`：非空常规文件 + 哈希 vs 钉版口径（无钉版无比对基准，与 T1-03 `backupValid` 同口径）+ `--version` 可执行可解析）；单候选 stat/读取失败按"该候选无效"记录并继续（枚举容错，全无效时汇总显式报错，无静默）；
  4. `copyDeploy` 原子替换部署（mode 0755）；
  5. 复验：哈希 vs（钉版 ?? 所用备份哈希）+ `--version` 可解析 → 不过则 `REPAIR_VERIFY_FAILED`（不谎报成功）；
  6. 审计 `kind:"repair"`（含 auditId）并返回 `RepairResult`。
- **错误分支**（显式、可编程分支）：
  - 无任何**真实存在**的候选 → `BIN_MISSING_NO_BACKUP`，remediation 含真实事故四要素：`.delete` 残留检查（升级流程"先改名后部署"残局）/ 官方安装包重装 / `codearts.bak-*` 备份手工回填指引 / 官方入口 `https://codearts.huaweicloud.com/portal/settings/cli-auth`；
  - 候选存在但含哈希不符（全无效）→ `BACKUP_INVALID_HASH`；
  - 候选存在但全因非哈希原因无效（空文件/非常规/不可执行）→ `BACKUP_INVALID`；
  - 部署后复验失败 → `REPAIR_VERIFY_FAILED`；
  - FS/权限失败 → `FS_WRITE_FAILED`（含路径与 errno）。
- **`ensureBackup(cfg, exec)`**（R-fx3）：备份源显式校验（存在+非空常规文件+`--version` 可执行+有钉版时哈希一致——**拒绝把漂移内容固化为备份**，`BACKUP_SOURCE_INVALID` 三种原因分立消息）；备份与当前二进制哈希一致 → 不重写（mtime 不变，审计 `up-to-date`）；缺失/失效 → `copyDeploy` 刷新 + 审计 `refreshed`。版本名 = 钉版版本 ?? 当前解析版本（源校验已保证可解析，`unknown` 占位名在此路径不可能出现）。
- **`fixAutoupdateFlag`**（内部函数，R-fx5）：parse → 仅改 `autoupdate` 字段（未知字段原样保留）→ `JSON.stringify(obj, null, 2) + "\n"` 经 `atomicWriteFile` 写回（保留原文件 mode，新建 0644）；解析失败/顶层非对象 → `AUTOUPDATE_INVALID` 且一个字节不动；文件缺失 → 视为空对象显式新建（审计 `before:null` 如实记录）；已是 false → 幂等不重写，审计 `already-off`。
- **审计**（R-fx6）：`<stateDir>/audit/install.jsonl` 追加写（先 `ensureStateDirs`）；`auditId = rep-<epoch 毫秒>-<6 位 hex>`；三类动作各一条（repair / ensure-backup / fix-autoupdate），字段含 `ts/kind/from/to/sha256/result/before/after` 视种类而定。

### 1.3 测试（`test/fsx.test.ts` 65→232 行；`test/install.test.ts` 382→618 行；新增 27 用例）

- fsx：sameDevice 同目录 true / `/tmp` vs 仓库 `.tmp`（ZFS 双数据集，**前提自检**：先断言 st_dev 确实不同，前提失效则显式失败而非静默通过）/ 路径缺失显式报错；atomicWriteFile string+mode 0o667（umask 0002 下裸 open 只会得 0o665，0o667 通过即证明显式 chmod）/ Uint8Array 字节级 / 覆盖后无 `*.tmp-*` 残留 / **崩溃注入**（手工构造半写 tmp 残留模拟"写 tmp 后进程中断"→ 目标原状 + 后续写入照常成功）/ 只读目录失败注入（目标原状）；copyDeploy 哈希一致+mode 0755 / 自定义 mode / 覆盖替换无残留 / 源缺失 / 目标目录只读（Review-Focus-1 同源）。
- install：repair 从备份恢复成功（哈希+版本复验+auditId 格式+审计行字段+exec 恰好两次 [校验,复验]）；恢复后 `probeInstall` 复核 consistent（闭环）；only-delete → `BIN_MISSING_NO_BACKUP`（remediation 四要素逐项断言）；备份坏哈希 → `BACKUP_INVALID_HASH`；步骤②扫描旧版本名备份恢复（`RepairResult.from` 显式为扫描所得）；复验失败 → `REPAIR_VERIFY_FAILED`；只读 bin 目录 → `FS_WRITE_FAILED` 含路径+EACCES（Review-Focus-1）；fixAutoupdate true→false（未知字段保留、2 空格缩进+末尾换行、审计 before/after）/ JSON 损坏不动文件 / 缺省不执行；ensureBackup 刷新（mode 0755+审计 refreshed）/ up-to-date（mtime 不变）/ 二进制缺失 / 漂移内容拒绝固化。

## 2. TDD 证据

**RED**（写完测试、实现前）：
```
$ bun test test/fsx.test.ts test/install.test.ts
SyntaxError: Export named 'atomicWriteFile' not found in module '.../src/core/fsx.ts'
SyntaxError: Export named 'ensureBackup' not found in module '.../src/core/install.ts'
 0 pass | 2 fail | 2 errors
```

**GREEN 过程中的中间失败（真实缺陷修复）**：
```
(fail) only-delete（无任何备份）→ ... Expected: "BIN_MISSING_NO_BACKUP"  Received: "BACKUP_INVALID"
```
根因：候选①（期望版本命名）仅是"名字不存在"却被计入"候选存在"，导致 only-delete 残局误报 `BACKUP_INVALID`。修复：`reason === "missing"` 的候选不计入 `existingCount`——只有真实存在的候选文件全部无效才报"有备份但都坏"。

**GREEN**（最终）：
```
$ bun test
 82 pass | 0 fail | 284 expect() calls — Ran 82 tests across 4 files [2.25s]
$ bunx tsc --noEmit → TYPECHECK_OK
```
基线 55 测全绿保持（55 → 82，新增 27，零回归）。

## 3. 文件清单

| 文件 | 变更 | 行数 |
|------|------|------|
| `plugins/codearts-bridge/src/core/fsx.ts` | 修改：+sameDevice/atomicWriteFile/copyDeploy | 156 ✓≤1000 |
| `plugins/codearts-bridge/src/core/install.ts` | 修改：+repairInstall/ensureBackup/fixAutoupdateFlag/审计/候选校验 | 821 ✓≤1000 |
| `plugins/codearts-bridge/test/fsx.test.ts` | 修改：+3 组 describe（12 用例） | 232 ✓≤1000 |
| `plugins/codearts-bridge/test/install.test.ts` | 修改：+2 组 describe（15 用例） | 618 ✓≤1000 |

提交：`9fff0cd7e8`（4 files changed, 928 insertions, 17 deletions）。

## 4. 自审发现

1. **修复了一个测试驱出的真实边界缺陷**（候选存在性判定，见 RED/GREEN 中间失败）——`BIN_MISSING_NO_BACKUP` 与 `BACKUP_INVALID` 的分界现在是"是否存在真实候选文件"，与真实事故语义一致。
2. **隔离纪律保持**：所有 FS 落点在插件 `.tmp/`（beforeEach 重建 / afterAll 清理）；exec 全部 fake（真实进程测试仅既有 `/bin/sh` 用例）；未触碰真实 HOME 与主检出的无关 WIP。
3. **错误码增殖说明**：brief 只钉了 `BIN_MISSING_NO_BACKUP`/`BACKUP_INVALID_HASH` 两个码；实现中 `BACKUP_INVALID`（非哈希原因全无效）与 `REPAIR_VERIFY_FAILED`（复验失败）为必要新增——前者避免把"备份不可执行"误导为哈希错误，后者是裁定 R-fx4"复验"步骤的直接产物，均有注释与测试覆盖。
4. **YAGNI 把关**：`fixAutoupdateFlag` 保持模块内私有（brief 接口仅要求 `repairInstall` opts 形态）；未引入计划外导出；`cleanupTmp` 的 `catch(() => undefined)` 仅用于失败路径垃圾清理（主错误照常上抛），已注释说明非兜底。

## 5. 遗留问题/担忧

1. **`sameDevice(/tmp, repo .tmp)` 用例的本机耦合**：用例已内置前提自检（st_dev 相同则显式失败提示前提失效），换机器若 /tmp 与仓库同设备需改用其他异设备对——属测试前提问题，非实现缺陷。
2. **审计 jsonl 无文件锁**：多进程并发追加依赖 O_APPEND 单行原子性（Linux 本地 FS 满足）；T3-04 状态层若需跨进程强一致，届时统一加固（本任务单进程语义内无此需求）。
3. **复验对版本的口径**：哈希为内容身份（与 T1-03 漂移口径一致），复验要求"版本可解析"但不要求等于钉版版本——若未来要求强版本一致，需改 `REPAIR_VERIFY_FAILED` 判定并补测试（当前口径已在注释中显式声明）。
