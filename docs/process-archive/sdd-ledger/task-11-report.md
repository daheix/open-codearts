# Task 11 报告 — PTY 宿主 · tmux（T2-03）

- **Status**: DONE（26 新测试过 + 1 真机用例按裁定 skip；全量 221 pass / 0 fail + typecheck 零错误）
- **Commit**: `8fcbe21485` — `codearts-bridge(T2-03): tmux PTY 宿主 — 幂等重连/两段式注入/显式缺失错误/条件真机用例`
- **BASE**: `a478c3c9d5`（T2-02 评审修复后）

## 一、实现内容

### 文件清单
| 文件 | 性质 | 行数 | 内容 |
|---|---|---|---|
| `src/core/transport/pty-tmux.ts` | 新建 | 510 | `createTmuxTransport(exec, opts)` 实现 CodeartsTransport 六方法；`nodeTmuxExec` 生产缺省执行器；`sessionNameFor` 会话命名 |
| `src/core/transport/shared.ts` | 新建 | 256 | R-tm5 共享提取：日志 tailer（armLogTailer/newestKernelLog/LogSourceState）、shQuote、lookPath、PtyClock |
| `src/core/transport/pty-script.ts` | 重构 | 635→436 | 删除与 shared.ts 重复的 5 块实现，改 import + re-export（shQuote/PtyClock 保持既有导入面） |
| `test/transport-tmux.test.ts` | 新建 | 668 | 27 用例：26 fake 离线 + 1 真机套（`describe.skipIf(!HAS_TMUX)`，本机未装 tmux → skip） |

### 主控裁定逐条落实
- **R-tm1 探测与错误**：每次 `start()` 均执行 `tmux -V`（非缓存；测试钉死"前次成功不豁免后次失败"）。失败 → `BridgeError(PTY_HOST_UNAVAILABLE)`，remediation="安装 tmux（如 sudo apt install tmux），或配置 ptyHost=script。"（含任务书两 token）。无任何静默切换路径；生产 `nodeTmuxExec` 在 lookPath 探测缺失时同步抛同码错误（先探测后 spawn，无竞态）。
- **R-tm2 start 幂等**：流程 = 探测 → `has-session -t <target>` → 命中重连（不重建）/ 未命中 `new-session -d -s <target> <installDir>/bin/codearts`。argv 数组传参；命令参数经 `shQuote`（tmux 将命令参数交 sh 解析，空格路径会被拆词——转义对象仅为配置路径，与 T2-02 R-p5 同源依据，测试钉死空格场景）。
  - **会话命名**：`codearts-<slug>-<hash8(installDir)>`（slug=基名非字母数字转 `-` 截 24 字符；hash8=installDir sha256 前 8 位）。同 cfg 确定性同名（跨守护重启重连锚点），不同安装目录不碰撞。
  - **start(ref) 语义**：合法 ref 不要求在本实例注册过（跨守护重启后 ref 来自 state，由 tmux 服务器验证存在性）；存活 → 重连同 ref；已亡 → **同名重建**（spec 宿主重启对账："存活则重连；否则重启会话"），用当前 cfg，重建显式清队列/捕获基线、复位 closed/doneEmitted，日志计数保留。非法 ref（kind 不符/空 id）在任何 tmux 调用之前本地拒绝。
- **R-tm3 inject 两段式**：`["send-keys","-l","-t",target,text]` 与 `["send-keys","-t",target,"Enter"]` 两次独立 exec 调用，测试断言全序列保序（含前置 has-session 存活检查）。文本段加 `-l`（字面文本——否则 "C-c"/"F1" 会被 tmux 解释为键名；Enter 段刻意不加 -l 以发键）。多行文本 → `INJECT_TEXT_MULTILINE`（与 T2-02 同码）且零 send-keys。不设 120ms 窗口：send-keys 为服务器侧原子操作，次序由服务器保证（文件头注明与 R-p1 的差异依据）。send-keys 失败时复查存活归因：亡 → SESSION_NOT_ALIVE，活 → PTY_INJECT_FAILED。
- **R-tm4 stop/alive/snapshot**：stop=`kill-session -t`，exit≠0 时复查 has-session——不存在即幂等达成（非 stderr 字符串匹配，测试覆盖"外部已消亡"场景）；closed 后二次 stop 不再调用。alive=has-session 退出码。snapshot=`capture-pane -p -t`（raw=即时捕获；meta={id,kind,host:"tmux",target,alive,closed,log}；会话亡 → raw=""+alive:false 如实标注）。
- **R-tm5 共享提取**：日志 tailer（~200 行）+ lookPath + shQuote + PtyClock 提取至 `shared.ts` 唯一真相源；tailer 的唤醒机制参数化为 `wake` 回调（唤醒属各宿主自有状态）。pty-script.ts 改 import + re-export，**行为与测试零改动**（既有 42 个 script 测试全绿，diff 审查确认删除块与迁移内容一致）。观察循环骨架因两宿主差异（script：同步 child.alive()+onData 独立生产者；tmux：异步 has-session+生成器体内轮询 capture）**不做**提取——按裁定"最小重复并标注来源"（与 pty-script/FakeTransport M34 同构注释）。
- **R-tm6 语义对齐**：abort=立即放弃（T9 基准）——未开始即取消空迭代、挂起中 abort 正常落定不抛错、**残存保留给下一次 observe**（队列跨观察持久；测试：一次日志增量两条信号，消费一条后 abort，残余由下一次 observe 交付）。stop 后 observe 终止（不产 done，与 Fake 同态），stop 后再 observe 立即空迭代。会话外部消亡 → 一次性 done 后迭代正常结束（对齐 script 进程自然退出）。日志信号源与 T2-02 同语义：`kernelDataDir` 经 ObserveOptions 传参、tailer 同步装配基线、service= 行转 output、目录缺失不报错、meta.log 如实标注（available/file/serviceLines，观察结束 available:false 而 serviceLines 留痕不丢——测试双向断言）。

### tmux observe 设计（实现者决策，已文档化）
- observe = 生成器体内轮询 `capture-pane -p`（注入时钟 POLL_MS=200）：基线在首轮捕获确定（基线前内容不交付，gated-clock 测试钉死确定性）；差分规则：前缀演进交增量、非前缀演进（TUI 重绘）全量如实转达。
- tmux 探测为异步 → 存活校验发生在首次 next（SESSION_NOT_ALIVE），与 script 的 observe() 同步抛错时点不同——pane 已消失无缓冲可交付，显式报错（文件头注明差异与依据）。

### 签名偏差说明（供主控裁决确认）
plan 卡写 `createTmuxTransport(cfg, exec)`；实际实现 `createTmuxTransport(exec, opts)`。理由：① types.ts（T2-01 唯一真相源）以 `start(cfg)` 逐次交付配置，工厂再收 cfg 会造成 installDir 双真相源；② T2-02 已落地 `createScriptTransport(exec, opts)` 先例。已在代码头注与提交信息中显式记录。

## 二、TDD 证据

- **RED**：先写 `test/transport-tmux.test.ts` → `bun test test/transport-tmux.test.ts` → `error: Cannot find module '../src/core/transport/pty-tmux'`（0 pass / 1 fail）。
- **GREEN**：实现 shared.ts + pty-tmux.ts + pty-script.ts 重构后 → tmux 套 26 pass/1 skip/0 fail；中途修复 4 处（见"自审发现"）。
- **全量**：`bun test` → **221 pass / 0 fail / 1066 expect**（基线 195 + 26 新过 + 1 skip）；`bun run typecheck` → 0 错误。
- **稳定性**：tmux 套连跑 5 遍全部 26 pass / 0 fail（gated clock 时序无脆弱性）。

## 三、测试设计要点（测试真实性）

- fake exec 为有状态 tmux 模拟（exists 侧状态、pane 缓冲、-V 探测失败注入、failNext 指定命令失败），全离线不触真实 HOME/套接字；断言落在**命令序列与退出码语义**上（非实现内部）。
- gated clock（每 tick 停在 promise 上由测试放行）使 observe 轮询时序完全确定：基线不交付、重绘全量、abort 残存、stop 终止、外部消亡 done 均为确定性断言。
- 真机套（skipIf）：临时 installDir（bin/codearts 包装 fake-tui.sh fixture）+ 独立 TMUX_TMP_DIR 套接字隔离 + kill-server 清场；覆盖 start→alive→inject 端到端回显→重连→stop 幂等。attach 语义不测（按裁定）。

## 四、自审发现（已修复）

1. **非法 ref 应先于探测拒绝**：初版 start 先 probe 后校验 ref，导致本地可拒的畸形输入也触 tmux；调整为"先本地校验、后探测"（失败快、无副作用）。
2. **inject 保序断言遗漏存活检查**：实现含前置 has-session（存活守卫），测试期望序列补齐——断言更完整地钉死调用序列。
3. **三处测试误传 promise 给 nextWithTimeout**（iter.next is not a function）：改为对挂起 promise 带超时 race；辅助函数语义不变。
4. **日志快照断言时点错误**：观察结束后 tailer 已 close（available:false/file:null），file 断言移至观察进行中，并补"结束后 serviceLines 留痕不丢"断言（与 R-p2 语义对齐）。
5. **typecheck**：`catch((e) => e as BridgeError)` 类型并集问题 → 改 try/catch 显式收窄。

## 五、遗留问题 / 担忧（均不阻塞）

1. **签名偏差待主控确认**：`(exec, opts)` vs plan 卡 `(cfg, exec)`（理由见上，风险低：T2-05 装配层按实际签名接线）。
2. **PTY_CAPTURE_FAILED 中途路径未单测**：observe 中 capture 失败（会话存活但 pane 异常）会显式抛错终止迭代——机制与已测的退出码检查同构，未单独构造场景（fake 需加"capture 失败"注入口；YAGNI 暂缓）。
3. **重绘全量信号在真实 TUI 下可能偏多**：capture-pane 差分对全屏重绘交付全量文本（如实转达，不丢失）；频次与可用性属 T3 监督层消费策略问题，本轮不做启发式抑制。
4. **重建时活跃观察者跟随会话名**（文档化边界）：旧观察者下一轮以新 pane 重建基线继续观察——语义已文档化，未单测（极端边界）。
5. **真机套依赖后续环境**：本机装 tmux 后 `bun test` 即自动启用真机用例；建议 T4 环境验证时补跑。

## 六、验证记录

```
bun test                → 221 pass / 1 skip / 0 fail（222 tests, 11 files）
bun run typecheck       → tsc --noEmit 零错误
wc -l 各文件            → pty-tmux 510 / shared 256 / pty-script 436 / 测试 668（均 <1000）
git 提交范围            → 仅 plugins/codearts-bridge 4 文件；opencode.json 已裁定本地改动未触碰
```

---

## 七、修复环第 1 轮（2026-10-31，接手实施者）— I1 重建时活跃观察者令牌永久滞留

### 改了什么

评审发现 I1（Important）：`observe` 闭包捕获会话状态对象 A；观察中会话外部消亡后
`start(cfg, ref)` 走同名重建生成新对象 B，`freshSession` 继承 `observer: prev.observer`；
旧观察者结束时 `release()` 只清 `A.observer`（token 匹配守卫），B 上永久残留陈旧
symbol → 此后一切 `observe(ref)` 永远 `OBSERVER_ACTIVE`；且 `markUnavailable` 以
引用替换方式更新 `s.log`（整体替换），旧 tailer 关闭只改到 A，B 读到的
snapshot.meta.log 永久滞留 `available:true` 陈旧值（分叉）。

修复（逐条落实主控裁定）：

1. **`pty-tmux.ts` start 同名重建分支**：生成新对象前 `prev.closed = true; wakeAll(prev)`
   ——旧观察循环见 `closed` 即按 **stop 语义**静默结束（不产 done 信号、立即终止；
   与 tmux kill-session 的会话级行为一致：会话消亡则其上一切观察随之终止）。
2. **`freshSession` 干净起步**：`waiters: []`、`observer: null`（不再继承 prev）——
   wakeAll 已在调用前摘除全部旧 waiters，新对象继承旧 observer 标记正是滞留根因；
   `log: prev?.log` 引用继承**保留**（新旧对象共享同一 log 状态对象）。
3. **`shared.ts` log 状态全部原地变更**（`markUnavailable`/同步基线/轮转三处，
   `s.log.xxx = ...` 替代 `s.log = { ...s.log, ... }`）：可用性变更对共享该对象的
   新旧会话同时生效，snapshot 不再读到分叉陈旧 meta；serviceLines 计数语义不变
   （跨观察/跨重建保留）。对 pty-script 行为零影响（snapshot 读取时点展开，
   观测值序列与引用替换完全一致）。
4. **文件头语义注释**：pty-tmux.ts"重建时的活跃观察者"段落改写为新语义
   （stop 语义终止 + 干净起步 + 日志可用性显式同步）；shared.ts 文件头补
   "I1 原地变更"依据说明。原报告"遗留问题 4"（重建时活跃观察者随会话名延续）
   即本缺陷的文档化边界，本轮消除。

### 覆盖测试（transport-tmux.test.ts 新增 describe，2 用例）

- **组合场景（gated clock 确定性）**：observe 进行中 → `setExists(false)` 模拟外部
  消亡（旧观察者尚挂起、不知情）→ `start(CFG, ref)` 同名重建 → 断言旧 observe
  已终止（挂起 next 直接落定 `done:true`、未交付任何信号——stop 语义不产 done）→
  **再次 `observe(ref)` 成功可用**（新基线后增量 `+out` 正常交付，不再
  OBSERVER_ACTIVE）。
- **log meta 不分叉**：观察中消费 1 条 service 信号（serviceLines=1）→ 外部消亡 →
  重建 → 断言旧迭代终止、`snapshot.meta.log = {available:false, file:null,
  serviceLines:1}`（旧 tailer close 如实转不可用 + 计数保留）且 snapshot 正常
  （alive:true/closed:false）。修复前此断言读到分叉的 `available:true`。

### 命令与输出（RED → GREEN）

```
RED  （修复前）bun test test/transport-tmux.test.ts
     → 26 pass / 1 skip / 2 fail：两新用例的挂起 next 3s 超时落 null
       （r1 = null）——旧观察者在废弃对象上永续运行、永不终止（I1 复现）
GREEN（修复后）bun test test/transport-tmux.test.ts
     → 28 pass / 1 skip / 0 fail（83 expect）；连跑 3 遍稳定 28 pass / 0 fail
全量 bun test        → 223 pass / 1 skip / 0 fail（224 tests, 11 files, 1075 expect）
bun run typecheck    → tsc --noEmit 零错误
wc -l                → pty-tmux 529 / shared 266 / 测试 731（均 <1000）
git 提交范围         → 仅 plugins/codearts-bridge 3 文件；opencode.json 未触碰
```
