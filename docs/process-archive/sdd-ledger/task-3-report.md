# Task 3 报告：安装状态探测（T1-03）

**Status: DONE**（commit `b63accad8b`，分支 `codearts-bridge`，BASE `6b4179fa`）

## 实现内容

| 文件 | 行数 | 内容 |
|------|------|------|
| `src/core/errors.ts` | 31 | `BridgeError extends Error`：`code`（UPPER_SNAKE，开放 string 便于后续任务增列）+ 可选 `remediation`（中文指引）+ `cause` 透传 |
| `src/core/fsx.ts` | 51 | `sha256File(path)`：node:crypto 流式哈希（R-b 唯一实现）；任何读取失败 → `BridgeError("FS_READ_FAILED")` 含路径与原因 |
| `src/core/install.ts` | 410 | `probeInstall(cfg, deps?)`、`Exec`/`ExecResult` 注入接口、`createNodeExec`（10s 超时/1MiB 输出上限，超限显式报错）、`InstallStatus`/`PinState`/`PinnedRecord`、路径派生函数（binPathOf/pinnedJsonPath/codeartsCliJsonPath，T1-04/05 复用） |
| `test/fixtures/install-fixtures.ts` | 146 | `makeInstallFixture(root, kind)`：任务书五形态 + `unpinned`（R-a）；fake exec 记录调用参数；哈希统一经 fsx.sha256File 计算（零重复实现） |
| `test/install.test.ts` | 364 | 28 用例（含真实 `/bin/sh` exec 端到端 2 例） |
| `test/fsx.test.ts` | 65 | 4 用例（小/空/大文件/ENOENT，oracle 用 createHash 独立计算） |

### 主控裁定落实

- **R-a 钉版状态显式化**：`InstallStatus.pinState: "unpinned" | "consistent" | "drift"` 三态 + `pinned?: PinnedRecord`；`drift` 保留为便捷字段（=pinState==="drift"）。未钉版（pinState=unpinned, drift=false）与已钉一致（consistent）可区分，测试专项断言。漂移口径：已钉时二进制缺失/哈希不符 → drift；版本仅"可解析且不等"参与判定（exec 失败致版本未知不算版本漂移，version=undefined 单独呈现）。
- **R-b fsx 提前**：`src/core/fsx.ts` 仅 `sha256File`；fixtures 钉版哈希也经它计算，全仓库无第二处文件哈希实现（测试 oracle 的 createHash 属测试侧独立校验）。
- **R-c autoupdate**：`<installDir>/../codearts_cli.json`；文件缺失/键缺省 → `autoupdateFlag=undefined`（显式未知）；JSON 解析失败、顶层非对象、字段类型非法 → `BridgeError("AUTOUPDATE_INVALID")`。外来文件其他键不校验（只检目标字段，已注释非兜底）。
- **R-d probe 语义**：业务态全部字段化（缺失/坏哈希/无法执行/版本不符均不抛业务错）；非 ENOENT FS 错误 → 抛（`FS_STAT_FAILED`/`FS_READ_FAILED`，消息含 path+reason）；路径存在但非常规文件 → `FS_PATH_NOT_FILE` 显式抛（备份路径同样处理，不静默当 backupValid=false）。`--version` 解析 `/^\d+\.\d+\.\d+/m`（stdout 优先 stderr 兜扫）；exec 失败/非零退出 → version=undefined。
- **R-e 隔离**：exec 全注入 fake；真实 exec 仅两处且只跑 `/bin/sh` 脚本（0644 无执行位用例验证 EACCES→version=undefined）；FS 落点全在插件 `.tmp/install-test/`、`.tmp/fsx-test/`，beforeEach 重建 afterAll 清理，零触碰真实 HOME。
- **backupValid 语义**（文档化于头注）：存在且非空常规文件；有钉版时须哈希与钉版一致（修复源强校验）；空备份/哈希不符 → false。`backupPath` 命名契约 `codearts.bak-<钉版版本 ?? 解析版本 ?? "unknown">`，占位名纯信息性不参与行为（backupValid/present 承载真实状态）。

## TDD 证据

- **RED**：`bun test test/install.test.ts test/fsx.test.ts` → `0 pass / 2 fail / 2 errors`（`Cannot find module '../src/core/fsx'`——模块未实现，符合预期）。
- **GREEN 迭代 1**：实现后 `26 pass / 6 fail`——根因单一：fixture `--version` 输出写成 `codearts 26.10.9`（版本不在行首），与 R-d 规定的行首解析正则不符；修 fixture 输出契约（行首版本串）。
- **GREEN 迭代 2**：`31 pass / 1 fail`——真实 exec 端到端用例脚本内容覆盖 fixture 二进制致哈希失配；修正为按当前部署真实哈希重写钉版记录。
- **GREEN 终态**：`bun test` → **54 pass / 0 fail / 182 expect()**（既有 server 4 + config 18 + 新增 fsx 4 + install 28），复跑两次稳定；`bun run typecheck` → rc=0 零错误；单文件最大 410 行 ≤1000。

## 自审发现

1. 初版测试自身两处笔误（noexec 用例内容与断言矛盾、缺 mkdir 导入）在 RED 阶段即修正，未进入实现。
2. fixture 版本输出未按 R-d 行首契约是唯一实现期返工点，根因是 fixture 先于正则口径编写；已在 fixture 注释中钉死"版本串位于行首"契约。
3. `detectVersion` 对 exec 抛错返回 undefined 系 R-d 明文裁定的状态化语义（非吞错），注释标注依据；spawn 层错误在 createNodeExec 层原样 reject，两层职责分离。
4. 备份目录型异常（存在但是目录）选择显式抛而非 backupValid=false：与 R-d"异常态不静默"一致，测试覆盖。

## 遗留问题 / 担忧

- **T1-04 接口提示**：`backupName` 规则 `钉版版本 ?? 解析版本 ?? "unknown"` 在"未钉+bin 缺失"时产生 `codearts.bak-unknown` 信息性占位（backupValid 必为 false）；若 T1-04 ensureBackup 需要不同的候选备份扫描策略（多备份字典序取新），建议届时扩展而非改本语义。
- pinned.json 写入方尚不存在（T1-04/05 落地）；本任务 fixtures 的 `writePinnedFile` 即格式契约参考（`{version, sha256}`，version 全匹配 `\d+\.\d+\.\d+`，sha256 64 位十六进制大小写不敏感、比较前归一化小写）。
- createNodeExec 输出按 UTF-8 chunk 拼接，多字节字符跨 chunk 理论上可能截断（--version 输出为 ASCII 版本串，实际无影响）；若 T2 传输层复用该原语处理非 ASCII 输出，需换 StringDecoder。

## 提交

- `b63accad8b` codearts-bridge(T1-03): 安装状态探测 — 五类 fixture、钉版/哈希/备份/autoupdate 全量状态

---

## 修复环第 1 轮（2026-10-31，接手实施者）

**I1（Important）**：`createNodeExec` stderr 溢出被静默截断——stderr 处理器累计字节后仅 `if (bytes <= max) stderr += …`，从不触发 `EXEC_OUTPUT_OVERFLOW`；与头注承诺的"stdout+stderr 合并计数超限 → BridgeError + SIGKILL"不符。stdout 小、stderr 超限时命令"正常"完成且 stderr 被悄悄截断，违反"禁静默截断/禁静默兜底"铁律；且该原语将被 T2 复用，会掩盖真实失败。

### 改动

| 文件 | 改动 |
|------|------|
| `src/core/install.ts` | 两流同构修复：抽公共 `withinLimit(chunk)`（合并计数 + 超限 `overflowFail()`→`settleFail(EXEC_OUTPUT_OVERFLOW)`，与 stdout 原路径共享单次 settle 守卫与 SIGKILL），stdout/stderr 两个 data 处理器统一走它；超限后 chunk 一律不拼接。错误消息明确标注"stdout+stderr 合并计数"。净增 8 行（410→418，≤1000）。 |
| `test/install.test.ts` | 新增恢复性用例：`stderr 溢出（stderr 输出超过 maxOutputBytes）→ 抛 EXEC_OUTPUT_OVERFLOW 且进程被强制终止`——`/bin/sh` fixture（`printf 16 字节 >&2; sleep 0.5; touch 标记`，maxOutputBytes=8），断言错误码之外以标记文件验证进程被 SIGKILL（未被终止则残留语句 ~0.5s 后写出标记；等待 1.2s 确认无标记）。 |

### TDD 证据（RED → GREEN）

- **RED**（旧实现下新用例）：`bun test test/install.test.ts` → `28 pass / 1 fail`，失败形态 `expect(err).toBeInstanceOf(BridgeError)` 收到 `null`——stderr 溢出后命令"正常"完成（正是 I1 缺陷形态）。
- **GREEN**：修复后 `bun test test/install.test.ts` → **29 pass / 0 fail / 98 expect()**；全量 `bun test` → **55 pass / 0 fail / 185 expect()**（既有 stdout 溢出、正常完成、超时路径全绿，行为无回归）；`bun run typecheck` → rc=0。

### 提交

- 本轮修复：`codearts-bridge(T1-03): 修复评审发现 — createNodeExec stderr 溢出与 stdout 同构（合并计数→EXEC_OUTPUT_OVERFLOW+补测试） — I1`
