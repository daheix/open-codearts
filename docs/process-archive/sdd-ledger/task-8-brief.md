### Task 8: M1 工具接线与验收（T1-08）

**Files:**
- Modify: `src/server.ts`；Create: `test/m1-acceptance.test.ts`

**Interfaces:**
- Produces（工具集，全部接线到 T1-02~T1-07）：
  - `codearts_status` → `probeInstall` + `collectHealth` 摘要 + 传输/守护占位信息
  - `codearts_repair({ fixAutoupdate?: boolean })` → 权限门 → `repairInstall` → `ensureBackup`
  - `codearts_upgrade({ version?: string })` → 权限门 → `upgradeInstall`
  - `codearts_health()` → `collectHealth`
  - `codearts_hygiene({ apply?: boolean, olderThanDays?, logsKeep? })` → 计划/执行（apply 走权限门）
  - 每个工具 `execute` 返回 `{ content }`：JSON 摘要 + 人类可读文本；错误以 BridgeError 结构化为 `content`（含 code/remediation），**不抛裸异常**。
- Consumes: M1 全部模块。

- [ ] **Step 1: 写失败测试** `test/m1-acceptance.test.ts`（fake ctx 捕获 editor，直调各 `execute`）：
  - `status 返回五类 fixture 的正确摘要（表驱动）`
  - `repair 在 only-delete 场景恢复成功且返回 auditId`；`无备份场景返回 code=BIN_MISSING_NO_BACKUP 且含 remediation 文本`
  - `upgrade 权限门：permission.assert 被调用的 action/resource 断言`
  - `hygiene apply=false 只返回计划；apply=true 走权限门且执行清单=计划清单`
  - 每个工具注册名与 namespace 精确断言（`status/repair/upgrade/health/hygiene`，namespace `codearts`）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现接线**（工具名不带前缀，由 namespace 组合；schema 用 JSON Schema 严格 `additionalProperties: false`）
- [ ] **Step 4: 全量验证**：`bun test`（M1 全部）+ `bun run typecheck`；随后在真实 opencode 会话里对五个工具做一次手工冒烟（记录命令与输出到任务说明）
- [ ] **Step 5: Commit**：`codearts-bridge(T1-08): M1 工具接线与验收 — 五工具+权限门+结构化错误，M1 全绿`

---

## M2 · 传输与运行

