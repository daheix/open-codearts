# Task 17 报告：持久化与对账（T3-04）

- **Status: DONE**
- **Commit: ce8a360bf2** `codearts-bridge(T3-04): 持久化与对账 — 原子状态/审计留痕/幂等恢复 — createDaemon 增启动对账缝`
- **BASE: 48c7db34**（T3-03 完成态）

## 1. 实现内容

### 1.1 `src/core/goal/state.ts`（新建，501 行）

| 接口 | 实现 | 裁定依据 |
|------|------|---------|
| `saveGoal(stateDir, s)` | 写侧同构结构校验（`GOAL_STATE_INVALID`）→ `atomicWriteFile`（同目录 tmp+rename+fsync，T1-04 原语）；并发写同目标=最后 rename 获胜（随机临时件名） | R-st1 |
| `loadGoals(stateDir)` | 返回 **`LoadedGoals {goals, corrupted}`**（裁定改型，见 §4）；逐文件 读→JSON.parse→结构校验；内容损坏 → **审计先行（`state-corrupt` fatal，含路径+200 字符截断 preview）→ 覆写为 blocked 最小态（objective 空串，禁编造）→ corrupted 诊断**；复载幂等（blocked 标记态合法，不再重报）；goals 目录缺失（ENOENT）=首启空态；**容错面仅限单文件内容损坏，FS 级故障显式上抛** | R-st1 |
| `appendAudit(stateDir, goalId, e) → auditId` | 追加 `<stateDir>/audit/<goalId>.jsonl`；**per-file Promise 链互斥锁**（同 GoalRunner.enqueue 模式）防并发交错；锁内读现有行数定 seq → `auditId=<goalId>-<seq>`（1 基严格单调无空洞）；行格式 `{...e, auditId}\n`；写后 `fh.sync()` | R-st2 |
| `reconcile(stateDir, deps{transport, cfg?}) → {resumed, blocked}` | 见 §1.2 | R-st3/R-st4 |

辅助设计（头注"显式决策登记"逐条注明依据，非兜底）：
- **goalId 白名单** `^[A-Za-z0-9][A-Za-z0-9._-]*$` 且 ≤128 字符（`GOAL_ID_INVALID`）：goalId 直接参与文件路径构造，白名单是路径穿越的显式拒绝面；文件名派生 id 非法的垃圾文件仅出诊断（无法安全落盘/审计），不崩守护。
- 结构校验容忍未知多余字段（前向兼容，显式决策）；必需字段缺失/错型一律判损坏。
- blocked 最小态 `objective: ""`：不可从损坏文件伪造目标文本；驱动面由 `GoalRunner` 构造校验（objective 非空）天然拦截。

### 1.2 reconcile 判定流（R-st3 幂等 + R-st4 重锚）

前置：**per-stateDir Promise 链互斥**（并发/重入 reconcile 序列化）+ loadGoals（损坏目标直接进 `blocked`）。

| 目标形态 | 动作 | 审计 |
|---------|------|------|
| 终态 / paused / blocked | 不触碰、不入列表（人工管辖；自动复活 paused 违背人工暂停语义） | — |
| active 无 session | 跳过（首 tick `bootstrapLocked` 自举） | — |
| active 会话活 + injected 空 | **R-st4 重锚**：注入契约（steps>0 → `buildResumeContract`，否则 `buildContract`，判据与 `runner.tickLocked` 第 5 步同源）→ 落盘指纹 + rounds+1 + lastProgressAt 刷新 | `goal.inject(kind=reconcile-reanchor)` |
| active 会话活 + 指纹在场 | 不重发；入 resumed（**连续两次 reconcile 的第二次走此路径 → 不注入**） | — |
| active 会话死 | `transport.start(cfg, 旧ref)` 重建（复用旧 ref，与 runner.restartLocked 同语义）→ 注入断点契约 → injected 重置为该契约（**新会话清旧指纹**，runner bootstrapLocked 注释登记的期待）+ rounds+1 + strikes+1（同 restartLocked 口径，阈值告警属 runner 域）→ 入 resumed | `goal.restart(reason=reconcile-session-died)` + `goal.inject(kind=reconcile-rebuild)` |
| 重建失败 | **仅传输阶段失败**降级：phase=blocked 落盘 + fatal 审计 + 入 blocked；状态层 FS 故障显式上抛（禁把 FS 故障伪装成目标 blocked） | `goal.error(kind=reconcile-rebuild-failed, fatal)` |

**幂等机制双保险（Review-Focus-4）**：① injected 指纹去重（活会话路径）——注入前契约文本/指纹已落盘，第二次 reconcile 必走"指纹在场→不重发"；② per-stateDir 互斥——并发两次 reconcile 序列化，第二次 loadGoals 读到第一次已落盘的指纹。死会话两次重建各自注入属**合法**（每次注入进入全新会话，非重复注入同一对话）——该语义边界已在头注与测试注释注明。

**审计只记已完成动作**：start+inject 成功后才落 restart/inject 两条事件；中途失败仅落 rebuild-failed 一条（不预写"已重启"的假事实）。

### 1.3 `src/daemon.ts`（修改，300 行）

- **R-d6 启动对账缝**：`createDaemon(cfg, hooks?: DaemonHooks)`，`hooks.reconcileOnStart?(stateDir)` 在 token 就绪后、**listen 之前**调用恰一次；抛错 → start 显式拒绝（状态层坏不带病服务）；结果摘要走 stderr（与既有 server 错误输出同通道）。
- 钩子**缺省不注入**：守护自身无传输可构造，伪造默认传输即兜底（禁止）；真实传输接线属 T3-05（`reconcileOnStart: (sd) => reconcile(sd, { transport })`）。
- 既有 16 个 daemon 测试零改动全绿（`createDaemon(cfg)` 向后兼容）。

## 2. TDD 证据

- **RED**：`bun test test/state.test.ts` → `Cannot find module '../src/core/goal/state'`，0 pass / 1 fail（模块缺失）。
- **初版实现后**：17 pass / 4 fail —— 其中 **2 个真缺陷被测试证伪**：
  1. `auditId` 断言失败暴露"审计先于动作"的假事实（start 失败仍预写 goal.restart 事件）→ 改为动作成功后审计，失败仅落 rebuild-failed；
  2. 审计 reason 不含路径不自定位（`JSON Parse error: Expected '}'` 无从溯源）→ reason 携带 `path=<file>` 前缀。
  另 2 fail 为 daemon 钩子未实现（预期红）。重构时进一步把 catch 收窄为仅传输阶段（FS 故障上抛）。
- **GREEN**：21/21 pass（95 expect）；全量 `bun test` 386 计数（385 pass + 1 skip + 0 fail，基线 365 + 新 21）；`bun run typecheck` 零错误。

## 3. 测试清单（test/state.test.ts，21 用例）

saveGoal/loadGoals：往返一致（含 session/auditId/injected/steps）｜goals 缺失空态｜损坏 JSON 三断言（blocked 落盘+fatal 审计+诊断、有效目标不受累、复载不重报）｜结构非法同损坏路径｜非法文件名仅诊断不落盘不审计｜save 拒绝路径穿越与非法形状。
appendAudit：auditId 顺序分配与多目标隔离｜30 并发不交错（seq 无重复无空洞、逐行合法 JSON）｜拒绝 null/数组事件与非法 goalId。
reconcile：**Review-Focus-4 重锚幂等（两次 reconcile 恰一次注入）**｜并发两次互斥仍一次｜指纹在场不重发｜死会话有进度→重建+断点契约（复用旧 ref/injected 重置/rounds/strikes/双审计）｜死会话无进度→全文契约｜重建失败→blocked+fatal 审计｜终态与人工态四相不触碰｜损坏目标进 blocked｜无会话跳过。
daemon 钩子：start 调用恰一次且参数=cfg.stateDir｜钩子抛错 start 显式拒绝｜缺省钩子无操作可启动。

## 4. 接口偏差与显式决策登记（供主控确认）

1. **loadGoals 返回型改型**：任务书简化签名 `Promise<GoalState[]>` → `Promise<LoadedGoals>`（`{goals, corrupted}`）——主控裁定 R-st1 原话"加载器返回有效目标+blocked 诊断列表"为准。
2. **ReconcileDeps 增可选 `cfg?`**：重建 `transport.start` 透传，与已裁定接受的 `RunnerDeps.cfg?` 同款接口缺口（缺省 undefined 由具体传输显式校验，禁伪造配置）。
3. **reconcile 契约选择用 hasProgress 判据**而非 R-st3 字面的恒 `buildResumeContract`：无进度死会话发 resume 契约会产出"已完成 0/0 步"病态文案；与 runner.restartLocked 对齐（同判据同文案）。
4. **paused/blocked/无会话目标不触碰**：R-st3 说"未终态目标"，按语义收窄——paused/blocked 属人工管辖，自动重建/注入违背其语义；已在头注登记。
5. **重建清 injected 后仍会注入本次契约**：死会话两次 reconcile 各注入一次属合法（全新会话需要契约），幂等不变量约束的是"同一对话不双注入"。
6. **审计事件新增 kind 值**：`state-corrupt` / `reconcile-reanchor` / `reconcile-rebuild` / `reconcile-rebuild-failed`（沿用 runner 的 `goal.*` 事件词表）。
7. goalId 白名单约束（生成方 T3-05/T3-06 需产出匹配 id）。

## 5. 自审结论（完整性/质量/YAGNI/测试真实性）

- 完整性：任务书 4 接口 + daemon Modify + Review-Focus-4 专测全部落地；R-st1~R-st4 逐条入头注与代码注释。
- 质量：全 BridgeError 结构化（新增码 GOAL_ID_INVALID/GOAL_STATE_INVALID/AUDIT_EVENT_INVALID/AUDIT_APPEND_FAILED）；无 try-catch 吞错返默认、无静默截断；单文件行数 state.ts 501 / daemon.ts 300 / 测试 447，均 ≤1000；中文注释、裁定依据就地标注。
- YAGNI：未实现审计读取器/审计轮转/goal 删除（无任务书依据）；锁表键数以目标数为上界（已注明）。
- 测试真实性：断言全部落 FS 重读与 FakeTransport 注入留痕，无自证循环；RED→GREEN 证据完整，过程中测试真证 2 缺陷并修复。

## 6. 遗留问题/担忧（携带指针 → T3-05）

1. **T3-05 接线清单**：`createDaemon(cfg, { reconcileOnStart: (sd) => reconcile(sd, { transport, cfg }) })`；对账后须以**落盘状态**构造 GoalRunner（injected 指纹已含对账契约，tick 重锚分支不会重复注入）；周期 reconcile（如每 N 分钟）可直接复用本函数（幂等）。
2. **对账注入的回显守卫空窗**：reconcile 注入后守护若立刻 tick，runner 的 deafUntilMs=-1（运行态不持久化）；防护靠持久化 injected 的回显剥离（协议层已保证契约行被剔除），如真机实测发现契约回显误判，需在 T3-05 给 runner 增"构造期回显守卫"参数。
3. **alive 分支注入失败会令 daemon start 失败**（显式上抛语义）；watchdog 重启后下一轮对账走重建路径自愈——若实际运行中该窗口频繁命中，考虑 T3-05 在宿主层捕获降级（宿主职责，非本层兜底）。
4. 审计 append 为"读行数→追加"，长寿命目标高频审计为 O(n) 读——当前事件频率（秒级间隔）无虞，量大后再考虑缓存 seq。
5. loadGoals 的 blocked 标记覆盖原损坏文件，取证依赖审计 preview（200 字符截断）——若主控要求完整留存原始损坏件，需追加 sidecar 方案（本轮按最小实现未做）。
