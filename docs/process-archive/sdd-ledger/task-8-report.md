# Task 8 报告：M1 工具接线与验收（T1-08）

**Status: DONE** · 提交 `b13e72fae1`（codearts-bridge 分支）· 全量 156 测试绿 + typecheck 零错误 + 真实 opencode 会话活验通过

---

## 1. 实现内容

### 1.1 `src/server.ts` 重写（72 行骨架 → 619 行正式接线，R-t6 ≤1000 红线内）

五个 M1 工具全部接线到 T1-02~T1-07 模块，本文件只做**参数归一 → 权限门 → 调 core → 结构化返回**的薄编排，无业务判断：

| 工具 | 编排链 | 权限门（R-t2） |
|------|--------|----------------|
| `codearts_status` | `probeInstall` + `readAksk` + `collectHealth` 摘要 + 传输/守护 M2 占位 | 无（只读） |
| `codearts_repair` | 权限门 → `probeInstall` 幂等检查 → `repairInstall` → `ensureBackup` | `["install"]` |
| `codearts_upgrade` | 权限门 → `upgradeInstall`（fetcher/extract 可注入） | `["install"]` |
| `codearts_health` | `collectHealth` 快照原样返回 | 无（只读） |
| `codearts_hygiene` | `planHygiene`（只读）→ `apply=true` 时权限门 → `applyHygiene(同一条计划)` | 仅 apply：`["state"]` |

### 1.2 主控裁定逐条落点

- **R-t1（错误以 content 返回）**：`wrapTool` 统一出口——成功 `{content:[JSON摘要, 人类简报]}`；`BridgeError` → `{error:{code,message,remediation?}}`；未知异常 → `code:"INTERNAL"`、`message:String(e)` 并尽力写 `tool.internal-error` 审计警告（审计失败不掩盖结构化错误，与 upgrade.ts 失败审计同纪律）。全程零裸异常外抛。
- **R-t2（权限门）**：`assertManagePermission` 先于任何执行；`action:"codearts.manage"`、`resources`/`save` 同列（repair/upgrade→`["install"]`、hygiene→`["state"]`）、`source:{type:"tool",messageID,id}`（字段名依 `@opencode/plugin` 2.2.3 `dist/promise/permission.d.ts` 实测）。被拒 → 捕获断言错误 → `PERMISSION_DENIED` content 返回、不执行（裁定优先于宿主 rethrow 建议，代码有注释依据）；permission 域缺失 → `PERMISSION_GATE_UNAVAILABLE` 显式报错，禁静默旁路。
- **R-t3（repair 幂等）**：健康口径 = `present ∧ pinState≠drift ∧ backupValid` → `already-healthy` 结构化结果（非错误）；显式 `fixAutoupdate` 请求在幂等路径同样生效（`fixAutoupdateFlag` 自 T1-08 起从 install.ts 共享导出，独立审计），修复路径原样透传给 `repairInstall`；无备份 → `BIN_MISSING_NO_BACKUP` + remediation 四要素以 content 返回。
- **R-t4（组合场景）**：验收测试含"`.delete` 残局 + 有效备份 → repair 成功"，断言恢复后 `sha256===钉版哈希` + `auditId/^rep-/` + 审计行 `kind=repair result=restored`。
- **R-t5（本地 dev 接线不提交）**：worktree `opencode.json` plugin 数组追加绝对路径（不动既有两项）；热重载日志与活调用证据见 §4/§5；该文件改动**未提交**。
- **R-t6（文件组织）**：server.ts 619 行 < 800，未拆分。
- server.ts 的 **throw 守卫保留**（缺 `ctx.tool.transform` 显式拒绝加载，修复环 I1）。

### 1.3 装配与可测试性

- `buildPlugin(deps)` 注入式装配：`configOverrides/exec/fetcher/extract/kernelDataDir/permission`；default 导出 = `buildPlugin()`（生产路径：config 走 env/默认值，permission 取宿主 `context.permission`）。
- opencode options 白名单键（`installDir/stateDir/akskFile/kernelDataDir`）→ 配置覆盖，优先级 deps > options > env > 默认值；类型不符显式抛（加载期响亮失败）。
- 输入归一助手（`optBoolean/optString/optNonNegativeInt`）非法类型 → `TOOL_INPUT_INVALID` 显式报错，禁静默截断/钳位。
- schema 全部 `additionalProperties:false`；五个工具名/namespace 精确为 `status/repair/upgrade/health/hygiene` + `codearts`。

### 1.4 install.ts 改动（唯一 core 触点）

`fixAutoupdateFlag` 私有 → 导出（+6 行注释说明）。依据：R-t3 健康短路路径需要在不走 `repairInstall` 的前提下响应显式 fixAutoupdate 请求（否则静默丢弃用户显式动作，违背仓库铁律）。与 T1-05"仅共享导出调整"先例同构。

## 2. 测试结果（TDD 证据）

- **RED**：`bun test test/m1-acceptance.test.ts test/server.test.ts` → `SyntaxError: Export named 'buildPlugin' not found`（0 pass / 2 fail），实现后先 3 fail（测试侧 fixture 口径问题，见 §6），修正后全绿。
- **GREEN**：`bun test` 全量 **156 pass / 0 fail**（基线 134 + 新增 22），882 断言；`bun run typecheck` 零错误。

### 新增 `test/m1-acceptance.test.ts`（22 用例）

- 注册精度：五工具名/namespace/schema 封闭性（fake ctx 捕获 editor）。
- `status`：六行表驱动（healthy/missing/only-delete/bad-hash/bad-version/unpinned）断言 present/version/pinState/drift/backupValid/autoupdateFlag/健康零值；AK-SK 存在性 + **凭据值绝不回显**断言。
- `repair`：R-t4 组合场景（.delete+备份→哈希+auditId+审计行）；already-healthy 幂等（零审计）+ 权限门字段精确断言；无备份→`BIN_MISSING_NO_BACKUP`+remediation；fixAutoupdate 透传×2（修复路径保留 `vendorExtra` 未知字段；健康路径不丢显式请求）；被拒→`PERMISSION_DENIED` 不执行。
- `upgrade`：happy path（fake fetcher/content-driven exec/注入 extract，断言 `from:"unknown"/to/sha256/auditId/^upg-/`）+ 权限门字段精确断言；被拒→fetcher 零调用、无 upgrade.start 审计。
- `hygiene`：apply=false 只返回计划（零权限调用、零审计、零删除）；apply=true 执行清单=计划清单（purge 删除/WAL busy=0/轮转 2/审计 hygiene.apply）；被拒→零删除零审计。
- `health`：fake cli-data → 快照字段逐项断言（db/wal/dumps/logs.bytes/lastErrors/kernelRssFromLog）。

## 3. 文件清单

| 文件 | 动作 | 行数 |
|------|------|------|
| `plugins/codearts-bridge/src/server.ts` | 重写 | 619 |
| `plugins/codearts-bridge/src/core/install.ts` | 仅导出 fixAutoupdateFlag | +6 |
| `plugins/codearts-bridge/test/m1-acceptance.test.ts` | 新建 | 628 |
| `plugins/codearts-bridge/test/server.test.ts` | 按新语义更新 | 129 |
| `opencode.json`（worktree） | **改动不提交**（R-t5 台账） | +1 |

## 4. 接线与日志证据（R-t5）

- `opencode.json`（worktree）plugin 数组追加 `"/home/wsc/.local/share/opencode/worktree/e5785e/codearts-bridge/plugins/codearts-bridge"`，既有 `./plugins/ohm-shim` 与 superpowers 未动。
- 热重载日志（`~/.local/share/opencode/log/opencode.log`）：

```
104531: timestamp=2026-10-30T22:41:07.724Z level=INFO msg="loading plugin"
        id=/home/wsc/.local/share/opencode/worktree/e5785e/codearts-bridge/plugins/codearts-bridge
        entrypoint=file:///…/plugins/codearts-bridge/index.ts
```

- `failed to load plugin` 对本插件为**零**（现存失败行均为无关的 ohm-shim/oh-my-openagent，改前即存在）。
- 本子代理会话工具目录热更新后出现完整 `codearts` 命名空间 5 工具（status/repair/upgrade/health/hygiene），描述与 schema 与实现一致。

## 5. 活调用尝试记录

| 工具 | 尝试 | 结果 |
|------|------|------|
| `codearts_status` | ✅ 已调 | **成功**：真实环境全字段（present=true version=26.10.9 pinState=unpinned backupValid=true autoupdate=false db=1.06GB dumps=6个/1.24GB logs=2.17GB lastErrors=20 kernelRss≈168MB AK/SK=未配置 transport M2 占位）；content[0] JSON + content[1] 中文简报双形态符合 R-t1 |
| `codearts_hygiene{apply:false}` | ✅ 已调 | **成功**：只读计划 `[purge-dumps×4, rotate-logs(keep=20)]`，与 status 的 walBytes=0 交叉一致（无 wal-checkpoint 动作）；未执行 apply（删除真实文件属用户决策） |
| `codearts_repair` / `codearts_upgrade` / `hygiene{apply:true}` | ⛔ 有意未调 | 均为改状态动作（会动真实安装/下载部署/删真实文件）；行为已由 22 个注入式验收测试覆盖；权限门被拒路径另有专项测试 |
| `codearts_health` | ⏭️ 未单独调 | status 内嵌同一 collectHealth 摘要已活验；单独调用为重复 ~14s 全量日志扫描，避免无谓负载 |

## 6. 自审发现

1. **测试侧三轮修正**（实现本身零改动）：upgrade 用例初版误用定值输出的 fixture exec（自检版本错配 → 改 content-driven exec）；hygiene plan 用例漏传 `logsKeep:1`（默认 20 → 3 条日志不产生轮转动作，core 行为本就正确）；health 用例初版误用 status 摘要字段名（快照契约是 `logs.bytes`/`lastErrors[]` 原样）。均属测试与契约口径对齐，非实现缺陷。
2. **语义取舍记录**：repair 的 ensureBackup 在修复成功后执行，若刷新备份失败会以结构化错误返回（修复本身已留审计，不掩盖也不谎报整体成功）——注释已写明。
3. **hygiene 的 plan 在权限门前计算**（只读）：与裁定"apply=true 走权限门"一致；plan→apply 间隙竞态由 applyHygiene 的清单执行语义（HYGIENE_TARGET_MISSING）显式暴露，T1-07 已有测试。
4. `SMOKE_TOOL_NAME` 常量保留于 config.ts（T1-01 占位口径"保持不变"），server.ts 改用 `TOOL_NAMES`；无遗留引用问题。

## 7. 遗留问题 / 担忧

- **真实环境健康数据触目**（活验顺手发现，非本任务范围）：dumps 6 个/1.24GB、logs 2.17GB、db 1.06GB；hygiene 计划已列出 4 个到期转储可清。建议主控在 M2 接入前评估是否执行一次真实 hygiene apply（用户决策）。
- **status/health 在真实环境约 14s/次**（全量日志扫描，health.ts 头注已记）：M2 增量扫描前，AI 调用方需知此耗时；工具 description 已写明。
- **权限门仅被注入式 fake 验证**：真实宿主弹窗/拒绝交互路径（permission.assert 的 deny 语义）未在真实会话触发（本会话 permission=allow 且未调管理工具）；T4-01 正式接入时建议补一次真实拒绝演练。
- `opencode.json` 的插件条目按裁定**未提交**，合并时需排除该文件改动；T4-01 定正式接入方式（绝对路径仅本 worktree 生效）。
