# Task 9 报告：传输接口与 FakeTransport（T2-01）

**Status**: DONE
**Commit**: `3c292e471d` — codearts-bridge(T2-01): 传输接口与 FakeTransport — 脚本化信号/注入留痕/可切换存活
**日期**: 2026-10-31

## 实现内容

### `src/core/transport/types.ts`（59 行）
传输接口唯一真相源，与任务书签名逐字对齐（R-tr1 接口最小完整，禁可选兜底字段扩展）：
- `TransportKind = "structured" | "pty"`
- `Signal { t: "output"|"error"|"idle"|"step"|"done"; at: number; text?: string }`
- `SessionRef { kind: TransportKind; id: string }`
- `CodeartsTransport` 六方法：`start/inject/observe/alive/stop/snapshot`（签名逐字对齐任务书；`kind` 属性加 `readonly` 属类型收紧非字段扩展，注释已说明）。

### `src/core/transport/fake.ts`（268 行）
确定性测试替身（无 spawn/FS/网络副作用，R-tr4），主控裁定 R-tr3 逐条落实：
1. **脚本化信号队列**：`push(ref, sig)` 原样入队 / `emit(ref, t, text?)` 便捷入队（返回信号供断言）；均显式 ref 寻址（多会话无歧义）；消费期间可继续追加，observe 挂起等待（事件驱动唤醒，无定时器）。
2. **注入留痕**：`injections` 按调用序记录 `{ref, text, at}`；stop 后留痕不丢。
3. **alive 可切换**：`stop` → false；`start` 复用同一 ref（恢复语义）→ true；复用归零时间线、保留队列/留痕/快照历史（审计事实不抹除）。
4. **stop 语义**：挂起中的 observe 的 next 得 done；后续 observe 立即空结束；stop 幂等；alive=false。
5. **确定性 at**：会话级调用序计数器（二选一裁定：**弃注入时钟、取调用序**，注释说明）；inject 与 emit 共享同一时间线刻度；start 复用归零。

语义裁决（显式报错、禁静默兜底，复用 `errors.ts` 的 BridgeError，无新增错误类型）：
- `SESSION_UNKNOWN`：未知 ref 全部方法显式抛（async 方法经 rejection、同步方法 observe 直接 throw），不产生副作用；
- `SESSION_NOT_ALIVE`：对已 stop 会话 inject，且不留痕；
- `OBSERVER_ACTIVE`：同一 ref 并发第二个 observe 同步抛（单观察者模型，消除多消费者争抢歧义；迭代器完成/return/abort 释放后可重新 observe）；
- observe 尊重取消（R-tr2）：abort → 迭代**正常结束不抛错**，"立即放弃"语义（残存信号丢弃）；已 abort 的 signal 传入 → 空迭代且不占用观察者名额；
- `snapshot.raw`：会话 raw 缓冲（output/error 入队时按序累积，与是否被消费无关，模拟终端缓冲区）；`meta` = `{id, kind, alive, closed, injections, signalCount}`。

### `test/transport-fake.test.ts`（300 行，16 例）
覆盖：start 生命周期（新会话 id 递增/kind 构造参数/复用复活/未知 ref）、注入留痕（调用序/时间线/停止后拒绝不留痕）、脚本产出（Signal 形态逐字段钉死/消费期间追加挂起唤醒/emit-at 与 start 复用归零）、abort 两路径（挂起中 abort / 预先 abort）、单观察者占用与释放、stop 终止（挂起迭代得 done/幂等/snapshot 历史保留）、snapshot（raw 拼接/meta 计数/注入计入）。

## TDD 证据

- **RED**：先写测试，`bun test test/transport-fake.test.ts` → `error: Cannot find module '../src/core/transport/fake'`（0 pass / 1 error）。
- **GREEN 迭代 1**：实现后 → 10 pass / 6 fail（全部 5000ms 超时）。
- **GREEN 迭代 2**：根因是测试 `drain` helper 与"队列耗尽挂起"语义冲突（该语义本身正确——R-tr3-①"期间可继续追加"的必然结果）→ `drain` 改为消费到 `done` 脚本终结信号即止（break 触发迭代器 return 释放观察者），相关用例以 `done`/`stop` 收尾 → 15 pass / 1 fail。
- **GREEN 迭代 3**：`alive` 是 async 方法，未知 ref 只能经 rejection 报错，测试误用同步 `toThrow` → 改 `rejects` → **16 pass / 0 fail（20ms，无超时依赖）**。

## 测试结果

- 聚焦：`bun test test/transport-fake.test.ts` → **16 pass / 0 fail**（20ms）。
- 全量：`bun test` → **172 pass / 0 fail / 930 expect**（基线 156 未动、零修改既有文件）。
- `bun run typecheck` → **零错误**。
- 行数门禁：types.ts 59 / fake.ts 268 / test 300，全部 ≤1000。

## 实现侧自审发现（已在提交前修复）

1. **abort 唤醒遗漏**（初版）：observe 挂起在 `waitFor` 时 abort 无人唤醒，测试会永久卡死 → 迭代器内注册 `signal.addEventListener("abort", wake, {once:true})`，finally 移除。
2. **snapshot.raw 初版误基于 pending 队列**：消费后历史即丢，与"快照"语义矛盾 → 改为会话级 raw 缓冲（入队时累积）。
3. **push/emit 初版经"唯一会话"反查定位**：多会话场景歧义，且需要额外 FAKE_SCRIPT_AMBIGUOUS 错误路径 → 改为显式 ref 寻址（与六方法一致），删除该错误码。
4. **async generator 未启动时 finally 不执行**：观察者占用会泄漏 → 包装迭代器的 `return/throw` 先同步释放再委托，generator 体 finally 兜自然结束路径（双保险、幂等）。

## YAGNI 裁决（未实现项及理由）

- 不加注入时钟：R-tr3-⑤ 二选一已裁定取调用序；如 T3-03 需时钟先改 types/fake 走评审。
- 不加 `setAlive` 独立旋钮：stop（→false）/start 复用（→true）已完整覆盖"alive 可切换"且语义无歧义（不存在"进程死了流还挂着"的真实对应物）。
- 不做多消费者广播：单观察者 + 显式报错满足 T3-03 场景且消除争抢歧义。

## 遗留问题 / 担忧

1. `observe` 返回的包装迭代器 `next()` 忽略外部传入值（for-await 语义下无影响）——T2-02~04 实现时如需双向通道需另行设计（接口本身无此需求）。
2. abort 语义取"立即放弃、残存信号丢弃"：已在 fake.ts 与 types.ts 注释钉死；T2-02~04 真实实现须对齐该语义，否则 T3-03 经 Fake 验证的状态机行为与真实传输可能分叉（建议 T2 实现评审时对照本文件注释）。
3. 工作区根 `opencode.json` 有一处非本任务的环境性改动（opencode 自动注册插件路径），未纳入本提交、未触碰；留给主控处置。
4. `injections` 暴露数组引用（零拷贝只读纪律靠注释约定）：Fake 仅测试用，风险可控；如后续出现误改写可升级为 getter 返回只读视图。

## 关联

- 任务书：`.superpowers/sdd/2026-10-31-codearts-integration-opencode-implementation-plan/task-9-brief.md`
- 消费方：T2-02（script PTY）/ T2-03（tmux）/ T2-04（structured）实现 `CodeartsTransport`；T3-03 监督状态机注入 `FakeTransport`。
- 提交：`3c292e471d`（分支 `codearts-bridge`）

---

# 修复环第 1 轮（2026-10-31，接手实施者）

## 改了什么

### I1（Important）：abort"立即放弃"语义入 types.ts 唯一真相源（无行为变更）
- `src/core/transport/types.ts` `observe` 注释：补"abort 语义（本文件为唯一真相源）：**立即放弃**——残存未消费信号丢弃、不 flush；真实传输（T2-02~04）须对齐该状态机行为（T3-03 经 FakeTransport 验证的行为以此为基准）"。此前该语义只写在 fake.ts 头注释，违背本文件自称的唯一真相源定位；59 → 62 行。

### M34（Minor）：包装迭代器 return/throw 挂起等待对称唤醒
- `src/core/transport/fake.ts`：`observe` 内新增 `terminated` 局部标记 + 循环顶部检查 `if (signal?.aborted || terminated) return`；包装迭代器 `return/throw` 在释放观察者后、委托 `inner.return/throw` 前调用 `self.wakeAll(s)`（与 abort 路径同态）。268 → 279 行。
- 机理：async generator 的 return/throw 请求排在挂起中的 `next()` 之后，若不唤醒 `waitFor` 的等待者，`next()` 永不落定 → 排队中的 return/throw 也永不落定（消费方悬死）。对称唤醒后挂起中的 `next()` 立即正常落定（done，残存信号丢弃——"立即放弃"语义与 abort 一致），随后委托请求正常处理；generator 体 finally 的 releaseObserver 幂等兜底不变。

## 覆盖测试

- `test/transport-fake.test.ts` 新增 1 例（"单观察者约束"describe，紧邻既有"未启动迭代器 return 即释放"用例）：**挂起 next 期间调用 `iter.return()` → pending next 与 return 均落定（done），随后可再次 observe 且消费到新脚本信号（名额释放正确）**。300 → 314 行。类型收窄：`iter.return?.()` 可选链返回值经 `expect(ret).toBeDefined()` 断言协议存在性后以 `(await ret)?.done` 消费（修 TS2532）。

## 命令与输出（RED → GREEN）

- **RED**（先写测试、未实现时）：`bun test test/transport-fake.test.ts` → `16 pass / 1 fail`——新用例 `this test timed out after 5000ms`（"永不落定"症状逐字复现）。
- **GREEN**（实现后聚焦）：`bun test test/transport-fake.test.ts` → **17 pass / 0 fail**（37ms，无计时依赖）。
- **全量**：`bun test` → **173 pass / 0 fail / 934 expect**（基线 172 + 本轮 1）。
- `bun run typecheck` → **零错误**。
- 行数门禁：types.ts 62 / fake.ts 279 / test 314，全部 ≤1000。

## 提交

- `codearts-bridge(T2-01): 修复评审发现 — abort 语义入 types 唯一真相源；挂起等待 return/throw 对称唤醒 — I1/M34`（仅 `git add plugins/codearts-bridge`；工作区根 `opencode.json` 的 dev 接线改动按裁定未触碰、未纳入）。
