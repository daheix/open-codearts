# Task 7 实施报告：hygiene 治理（T1-07）

- **Status**: DONE
- **Commit**: `03af4add9c` — `codearts-bridge(T1-07): hygiene 治理 — dumps 清理/WAL checkpoint/日志轮转，dry-run 与执行清单一致`
- **日期**: 2026-10-31

## 一、实现内容

在 `src/core/health.ts`（393→860 行，≤1000 达标）末尾新增 T1-07 hygiene 治理段，导出：

| 符号 | 说明 |
|------|------|
| `HygieneAction` | `{kind:"purge-dumps";files:string[]} \| {kind:"wal-checkpoint"} \| {kind:"rotate-logs";keep:number}`（任务书接口原样） |
| `planHygiene(cfg, opts)` | 纯只读 dry-run：返回动作清单，不写审计、不改任何文件。规则：① purge 仅列 log 目录内（递归）mtime 早于 now−olderThanDays 的 `dump-*.heapsnapshot`（路径升序，确定性清单）；② WAL 在场且非零 → wal-checkpoint；③ kernel-*.log 数 > logsKeep → rotate。只列"有活可干"的动作 |
| `applyHygiene(cfg, actions, opts?)` | 按序执行动作 + 写一条 `hygiene.apply` 审计（`audit/install.jsonl` 同一流），返回 `{applied, auditId}`（`hy-<ts>-<hex>`）；中途失败先尽力写 `result=failed` 审计再原样上抛（T1-05 评审教训：失败留痕不掩盖主错误） |
| `HygienePlanOptions` / `HygieneApplyOptions` | `olderThanDays?` / `logsKeep?` / `kernelDataDir?`（R-hy5：经 opts 传参，默认 `~/.codeartsdoer/cli-data`，不扩展 BridgeConfig） |
| `HYGIENE_DEFAULT_OLDER_THAN_DAYS=30` / `HYGIENE_DEFAULT_LOGS_KEEP=20` | R-hy2 默认参数常量 |

### 主控裁定逐条落实

- **R-hy1（WAL checkpoint）**：`bun:sqlite` `new Database(dbPath)` → `PRAGMA wal_checkpoint(TRUNCATE)`；校验返回行形态（缺失/非法 → `WAL_CHECKPOINT_FAILED`）、`busy≠0`（TRUNCATE 未达成）→ `WAL_CHECKPOINT_BUSY`；打开失败 → `WAL_CHECKPOINT_FAILED`（cause 保留）。**前置守卫**：db 缺失 → `WAL_DB_MISSING`（`new Database` 会静默创建空库，绝不允许"对缺失库做 checkpoint"变成凭空造库的静默副作用）；db 非常规文件 → `FS_PATH_NOT_FILE`。
- **R-hy2（默认参数/轮转范围）**：默认 30 天/保留 20 个；rotate 仅 log 目录顶层 `kernel-*.log`（与 `scanKernelLogs` 同口径），按 mtime 降序保留最近 keep 个；`experience-*.log` 等异构日志不参与（有测试钉死）。
- **R-hy3（purge 边界守卫）**：名单校验（basename 必须 `dump-*.heapsnapshot` → 否则 `HYGIENE_TARGET_INVALID`）+ **realpath 解符号链接** + **`path.relative` 前缀双重校验**（必须严格位于 realpath(logDir) 内 → 否则 `HYGIENE_PATH_ESCAPE`，绝不删除）；目标失踪（plan→apply 竞态）→ `HYGIENE_TARGET_MISSING` 显式报错不静默跳过（清单执行语义）。
- **R-hy4（清单一致性）**：purge 按"清单执行"——apply 实际删除清单与 plan 清单逐条一致（测试逐一断言，且审计 `purged` 字段与 plan 清单排序后全等）；rotate 因动作只携带 keep，按"重枚举执行"（扫描间隙被删者按不存在计，与 scanKernelLogs 同语义）；plan 不写审计（有测试断言 audit 文件不存在）。
- **R-hy5**：plan/apply 均经 opts 接受 `kernelDataDir`；任务书 apply 双参签名扩展为可选第三参（裁定明确要求 apply 也接受）。
- **参数校验**：`olderThanDays`/`logsKeep`/`keep` 须非负整数 → 否则 `HYGIENE_OPT_INVALID`（禁静默截断/钳位）；未支持动作 kind → `HYGIENE_ACTION_UNKNOWN`（防静默跳过）。

## 二、TDD 证据

- **RED**：先写 `test/hygiene.test.ts`（18 用例），运行 `bun test test/hygiene.test.ts` → `SyntaxError: Export named 'HYGIENE_DEFAULT_LOGS_KEEP' not found … 0 pass / 1 fail`（实现未存在的红）。
- **GREEN**：实现后聚焦测试 `18 pass / 0 fail`（76 expect）。中途一次失败为 rotate 用例测试侧 mtime 期望写错（kernel-d/kernel-b 才是最新两个），修正断言后全绿——实现语义（按 mtime 保留最近）正确。
- **全量**：`bun test` → **133 pass / 0 fail（115 既有 + 18 新），562 expect，2.70s**；`bun run typecheck`（tsc --noEmit）零错误。

## 三、测试清单（test/hygiene.test.ts，隔离于 `.tmp/hygiene-test/`，钩子清理）

1. purge plan：仅列到期转储（递归含子目录；未到期/非转储不入选；无多余动作）
2. plan 纯只读：不创建 stateDir/audit、清单内文件不删除
3. 默认参数（R-hy2）：21 天转储不清理、第 21 个日志触发轮转（keep=20）
4. purge apply 清单一致性：逐一删除、未入选者保留、审计 purged 与 plan 全等
5. 空目录：plan=[]；apply([]) 仅记审计
6. wal-checkpoint：**保持连接 A 打开使 WAL 处于非自愈态**（钉死"显式 PRAGMA 起效"而非打开时自动恢复）→ apply 后 WAL 趋零、数据完整（A 可读 + 只读重开可读）+ 审计含 checkpoint 结果
7. db 缺失 → `WAL_DB_MISSING` 且断言 db 文件未被静默创建
8. 非 SQLite 垃圾文件 → `WAL_CHECKPOINT_FAILED`
9. rotate：按 mtime 保留最近 2 个、其余删除、异构日志原位、审计 rotated/rotatedCount 准确
10. 日志数 ≤ keep → 无轮转动动作
11. 越界（log 外）→ `HYGIENE_PATH_ESCAPE` 且文件保留
12. **符号链接外逃** → realpath 拦截 `HYGIENE_PATH_ESCAPE`、外部目标未删
13. 名单不符（log 目录内非 heapsnapshot）→ `HYGIENE_TARGET_INVALID`
14. 目标失踪（plan 后 rm）→ `HYGIENE_TARGET_MISSING`
15. 非法 opts（负数/非整数/非数字）→ `HYGIENE_OPT_INVALID`（plan 与伪造 rotate 动作双向）
16. 未知动作 kind → `HYGIENE_ACTION_UNKNOWN`
17. fixture 自检（时间戳生效）

## 四、文件清单

- 修改：`plugins/codearts-bridge/src/core/health.ts`（+470/−3，860 行 ≤1000）
- 新增：`plugins/codearts-bridge/test/hygiene.test.ts`（449 行，18 用例）

## 五、自审发现与处置

1. **rotate 测试首跑失败**：测试侧 mtime 期望与注释不符（实现正确）→ 修正断言，非实现缺陷。
2. **测试真实性加固**：WAL 用例特意保持一条空闲连接，使 fixture 不处于"热 WAL 自愈"状态——若实现漏写 PRAGMA，打开时自动恢复不会替它通过测试。
3. **失败审计的取舍**：失败路径审计写入为尽力而为（写失败不掩盖主错误），与 `fsx.cleanupTmp`/`fsyncDir` 既有纪律同构，代码注释已标明依据（T1-05 评审教训）。
4. **YAGNI 核查**：未加 dry-run 开关、未接 server 工具层（属后续任务）；plan/apply 未复用 `walkDirBytes`（其只聚合字节不产路径，purge 需路径+mtime，独立收集器更直白且不改动 T1-06 既有语义）。
5. **行数与格式**：health.ts 860 行 ≤1000；本任务未改 C++，无需 clang-format。

## 六、遗留问题/担忧

- **busy≠0 分支无并发测试**：`WAL_CHECKPOINT_BUSY` 需要真实并发读者长事务才能稳定触发，单进程测试无法可靠构造；实现为显式抛错+审计可查，留待 M2 托管进程接入后补集成验证。
- **plan→apply 竞态下 purge 采取显式报错**（清单执行语义，裁定倾向"显式可测试"）：调用方需重跑 plan+apply；若未来出现高频竞态场景，可考虑在 M2 上层加一次自动重试（属上层编排策略，未在本任务引入）。
- `rotate-logs` 的 `keep=0` 为合法值（删光全部内核日志）——语义上显式允许，调用方（M2 工具层）应对该值加确认门槛。

---

## 七、修复轮 1（2026-10-31，评审发现 I1/M27/M28）

**更正说明（原"六、遗留问题"第 1 条）**：原表述"busy≠0 分支……单进程测试无法可靠构造"**不成立**——评审已实证：连接 A `BEGIN`+未提交 `SELECT` 持读事务时，另一连接 `PRAGMA wal_checkpoint(TRUNCATE)` **确定性**返回 `{busy:1,log:3,checkpointed:3}` 且 WAL 字节不变；A `COMMIT` 后再 checkpoint → `busy:0`、WAL→0。该分支可确定性构造，本轮已补两连接回归测试。

### 改动

| 项 | 内容 | 位置 |
|----|------|------|
| I1 | 新增两连接 busy 回归测试：①A 持未提交读事务 → apply 抛 `WAL_CHECKPOINT_BUSY`（BridgeError 含 code）且 WAL 字节不变（未误报成功）；②A `COMMIT` 后重跑 → 成功、WAL 趋零、数据完整；并断言审计恰两条（failed 含错误码 + ok） | `test/hygiene.test.ts`（wal-checkpoint 组，+44 行） |
| M27 | 失败审计补 `rotatedCount: rotated.length`，与成功路径 schema 对齐（下游消费同一解析器无需双口径） | `health.ts:847` |
| M28 | 删除恒真自比较断言（`realpath(x)` 与自身比较，零验证价值；该用例价值在 mtime 断言，保留）及随之无用的 `realpath` 导入 | `test/hygiene.test.ts:447` |

### TDD 证据（含 I1 反证）

1. **测试先行**：先写 busy 用例，跑聚焦测试 → 1 pass（实现已有 busy 判定，预期直接 GREEN）。
2. **反证（本地临时变体，未提交）**：将 `health.ts:726` 的 `if (row.busy !== 0)` 临时改为 `if (row.busy !== 0 && false)`（即移除 busy 判定），重跑 → **用例失败**（`UnreachableError: reached unreachable code`，apply 在 TRUNCATE 实际 busy 时未抛错）——证明该测试对 busy 判定的缺失必然红，非恒绿装饰。随后原样恢复实现，grep 确认 `row.busy !== 0` 唯一处完好在位。
3. **终验**：聚焦 `bun test test/hygiene.test.ts` → **19 pass / 0 fail（86 expect）**；全量 `bun test` → **134 pass / 0 fail（572 expect，3.54s）**；`bun run typecheck`（tsc --noEmit）零错误；`health.ts` 861 行 ≤1000。

### 提交

`codearts-bridge(T1-07): 修复评审发现 — WAL busy 分支两连接回归测试 + 失败审计 schema 对齐 + 删除恒真断言 — I1/M27/M28`

### 遗留更新

原"六、遗留问题"第 1 条已由本轮测试闭环，余两条（plan→apply 竞态上层重试策略、`keep=0` 确认门槛）维持原状，属 M2 工具层职责。
