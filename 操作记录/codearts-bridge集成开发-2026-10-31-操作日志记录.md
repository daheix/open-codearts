# codearts-bridge 集成开发（项目 A 收官，Task 24 / T4-03）- 2026-10-31 - 操作日志记录

## 任务背景与验收判据

- **背景**：华为 codearts CLI 三大痛点（升级损坏"无 CLI"残局、内存持续增长、/goal 目标断连不续跑）的手工止损（2026-10-30）升级为制度化集成方案——项目 A：`codearts-bridge` opencode 插件 + 本地守护 + 目标监督引擎。设计文档 `docs/superpowers/specs/2026-10-30-codearts-integration-opencode-design.md`，实施计划 `.superpowers/sdd/2026-10-31-codearts-integration-opencode-implementation-plan/`（25 任务卡，M1 基础器→M2 传输→M3 目标引擎→M4 落地）。
- **验收判据（spec §2.1 四条硬性要求，逐条对勾）**：
  1. **可启动** ✓——安装管家（状态探测/备份自愈/copy 部署受控升级/hygiene 治理）+ systemd 自愈单元 + watchdog 探活（T1-03~07、T3-07）；升级失败零损坏矩阵有专测；真机 3 次触发厂商升级缺陷现场均可从 `codearts.bak-*` 一键还原。
  2. **永不挂起** ✓——GoalRunner 无限重试（首错立即/60s 封顶/连续≥10 告警不停止）+ 进程死重建续跑 + 守护重启对账 + 宿主重启插件重连（T3-01~06、T3-08 矩阵八格）；真机实证死亡检测 4s、重建恰 1 次、守护 KILL 一次拉起 resumed=1。
  3. **内存可控** ✓——collectHealth 快照（RSS/DB/WAL/转储/日志/最近错误）+ hygiene 三治理（purge-dumps/wal-checkpoint/rotate-logs）+ structured 模式回合=进程内存天然复位（T1-06/T1-07；PTY 空闲软重启登记为后续增强，目标级重建已覆盖主路径）。
  4. **可观测可操作** ✓——12 个 `codearts_*` 工具（状态/修复/升级/健康/清理/run/目标六工具/daemon_status）+ 全程审计留痕 + 终态 `ctx.session.synthetic` 回呼 + `_progress` 直通（T1-08、T2-05、T3-06）。
- **本任务（T4-03）判据**：仓库规范操作日志 + 高复用经验入全局经验库并刷新索引 + 最终验证（bun test/typecheck/提交清单）+ 提交。

## 实施步骤（M1-M3 关键决策与改动文件）

**M1 安装管家（T1-01~08，测试 3→156）**：包骨架与加载实测（`@opencode/plugin` 2.2.3 钉版；2.1.4 加载形态实证：绝对目录+实体 `index.ts`，exports 不被采用）；配置与状态根（默认值/优先级/env 文件/0700；主控裁决 autoNudge 默认 true）；安装状态探测（钉版/哈希/备份/autoupdate 五类 fixture）；**备份与自愈（原子写/同数据集检查/copy 部署——针对厂商 EXDEV 缺陷的防御核心）**；受控升级（注入式 Fetcher/失败零损坏矩阵/single-flight）；健康采样（WAL 命名经内核二进制 strings 双确证）；hygiene 治理（dry-run 与执行清单一致）；五工具接线（R-t1 结构化错误/R-t2 权限门，`buildPlugin(deps)` 注入式装配全离线测试）。

**M2 传输层（T2-01~05，测试 156→296）**：`CodeartsTransport` 六方法接口+FakeTransport（可切换存活/脚本化信号）；script(1) PTY 宿主（**两段式注入** write(text)→120ms→write("\r")、detached+负 PID 组杀、tail 内核日志作信号源）；tmux 宿主（幂等重连/显式 PTY_HOST_UNAVAILABLE 禁静默切 script）；structured 传输（JSONL 事件解析、AK/SK 前置检查 AKSK_MISSING 不静默转 PTY、错误分级 classifyError、fake-run fixture 七场景真 spawn）；`codearts_run` 工具（selectTransport 纯函数 auto 选择带 {mode,reason}、进度 2s 节流、取消/超时、审计成对）。

**M3 目标引擎（T3-01~08，测试 296→463）**：守护骨架（仅绑 127.0.0.1、daemon-token 0600 timingSafeEqual、/health 免鉴权防 watchdog 死锁、SIGINT 竞态根因修复）；完成协议移植（契约/步骤解析/回显守卫/ANSI 边界，对齐 22 用例语义）；GoalRunner 纯 tick 监督状态机（时间全部 deps.clock 驱动、停滞双口径判据、并发串行化逐 await 相位复查）；持久化与对账（原子状态/审计留痕/幂等恢复/O_EXCL 单守护 pidfile）；守护目标 API（控制三语义/日志 seq 分页/多目标独立 sweep/quiescePump 排空窗口修复）；目标工具六件+回呼（守护代理唯一出口、显式不可用错误、终态通知恰好一次）；systemd 服务与 watchdog（Restart=always 自愈单元、宽限戳探活评估纯函数、幂等安装 mtime 钉死）；**M3 故障矩阵八格**（Fake 全离线钉死，详见验证证据）。

**M4 落地（T4-01~03）**：全局接入实测（`~/.config/opencode/plugins/codearts-bridge.ts` 一行 re-export → 公开仓库稳定检出，2.2.5 autoload 0.25s 热载，双端点在册 status=active，会话活调成功）；公开发布（daheix/open-codearts PUBLIC，泄密终扫全净，开箱 clone+bun install+455 测试全绿）；真机验收（T4-02）暴露 5 缺陷 → 一揽子修复（dad203fc53，18 RED 先行，17 文件 +807/−108）；本任务收官沉淀。

## 提交号清单（项目全提交，git log 时序自旧到新全列；700a241e 为 M2 收尾锚点）

| # | 提交 | 内容 |
|---|---|---|
| 1 | 3e540cb640 | 文档：opencode 方案设计文档（与 dsh 方案独立，A 先行） |
| 2 | 723e116754 | 文档：opencode 方案实施计划（25 任务卡 TDD 步进） |
| 3 | 58eba495fc | T1-01 包骨架与加载验证（实测加载键名与依赖解析） |
| 4 | 8bb2fc1d50 | T1-01 修复评审发现（不兼容宿主显式 throw） |
| 5 | 54b039cbf0 | T1-02 配置与状态根 |
| 6 | 6b4179fa8c | T1-02 主控裁决修正（autoNudge 默认 true） |
| 7 | b63accad8b | T1-03 安装状态探测 |
| 8 | e008c2a64b | T1-03 修复评审发现（EXEC_OUTPUT_OVERFLOW） |
| 9 | 9fff0cd7e8 | T1-04 备份与自愈（copy 部署/同数据集检查/autoupdate 修正） |
| 10 | 26734d6cf7 | T1-05 受控升级（失败零损坏矩阵/single-flight） |
| 11 | 80240ce43b | T1-05 修复评审发现（verify 失败回滚旧版快照） |
| 12 | c0a855b0cd | T1-06 健康采样 |
| 13 | 03af4add9c | T1-07 hygiene 治理 |
| 14 | dab56deae7 | T1-07 修复评审发现（WAL busy 回归/审计 schema 对齐） |
| 15 | b13e72fae1 | T1-08 M1 工具接线与验收（五工具+权限门，M1 全绿） |
| 16 | 3c292e471d | T2-01 传输接口与 FakeTransport |
| 17 | 8b7d4a43ba | T2-01 修复评审发现（abort 语义入真相源） |
| 18 | 9b3ea99d74 | T2-02 script(1) PTY 宿主（两段式提交/组杀） |
| 19 | a478c3c9d5 | T2-02 修复评审发现（终止机理注释更正） |
| 20 | 8fcbe21485 | T2-03 tmux PTY 宿主（幂等重连/显式缺失错误） |
| 21 | 4797bfb3eb | T2-03 修复评审发现（重建终止旧观察者） |
| 22 | b5be623412 | T2-04 structured 传输（JSONL/AK-SK 前置/错误分级） |
| 23 | d99f27ff8a | T2-05 codearts_run 工具（auto 选择/进度/取消，M2 全绿） |
| 24 | 700a241e46 | T2-05 修复评审发现（PTY 经官方 wrapper 启动，修真机授权门根因） |
| 25 | 53c10ed60d | T3-01 守护骨架（令牌鉴权/健康端点/CLI 前台） |
| 26 | b73ae61ff0 | T3-02 完成协议移植（契约/回显守卫/ANSI 边界） |
| 27 | 7c2c629fe0 | T3-03 监督状态机（停续/无限重试/续跑/双过验收/strikes） |
| 28 | 48c7db34c0 | T3-03 修复评审发现（classifyModelError stripAnsi） |
| 29 | ce8a360bf2 | T3-04 持久化与对账（原子状态/审计/幂等恢复） |
| 30 | ef26e2394b | T3-05 守护目标 API（全流程/控制/分页/多目标隔离） |
| 31 | f736a61216 | T3-06 目标工具与回呼（守护代理/显式不可用/终态通知） |
| 32 | 599af05100 | T3-07 systemd 服务与 watchdog（自愈单元/探活/幂等安装） |
| 33 | a2458e2e69 | T3-08 M3 故障矩阵（八格全过，永不挂起语义闭环） |
| 34 | c5df019a1d | T4-01 全局接入与使用文档（2.2.5 autoload 实测生效） |
| 35 | dad203fc53 | T4-02 修复真机验收 5 缺陷（④③②①⑤） |
| 36 | （本次） | T4-03 操作记录与经验沉淀（本日志 + 3 经验条目入全局经验库） |

配套公开仓库 daheix/open-codearts：0283540（首提交，git archive 全量发布）→ 5a8a440（CHANGELOG v0.3.0-dev/故障排查节/双版本加载对照表）。

## 验证证据（构建/测试输出摘要）

- **最终全量测试**（本任务 2026-10-31 实跑，`plugins/codearts-bridge`）：`bun test` → **474 pass / 1 skip / 0 fail，475 tests across 21 files，2264 expect() calls（7.13s）**；`bun run typecheck`（tsc --noEmit）→ **rc=0 零错误**。1 skip 为按裁定 skip 的 tmux 真机用例（本机未装 tmux，`describe.skipIf` 门控）。测试轨迹：3（T1-01）→156（M1）→296（M2）→463（M3）→474（T4-02 修复）。
- **M3 故障矩阵八格**（test/matrix.test.ts，全部离线：FakeTransport+假时钟+手动 sweep+真实 HTTP 守护）：①模型错误连续 4 次 server 类错误无限重试不停止、第 5 信号恢复至 complete；②网络类错误（ECONNRESET/ETIMEDOUT/fetch failed）同一无限重试语义；③杀回合进程 alive=false 重建、断点续跑契约恰一次；④杀守护同 stateDir 重建（token/pidfile/状态复用）、断点契约不双注入；⑤opencode 服务重启插件 setup 重跑、实例 2 工具恢复、守护不受影响；⑥守卫窗口回显作废 done+窗外回显剥离不误判；⑦双过验收自报 done+verify 首败注入失败原因、再申报 verify 过 complete；⑧pause/resume/stop 三连即时生效、终态出册 actives=0。八格全过为 T4-02 修复后的回归基线。
- **真机验收关键结论（如实区分两层）**：
  - **恢复链路实证 ✓（桥接自身能力）**：死亡检测 4s（≤2min 判据）；杀会话 restart 恰 1 次+新 TUI spawn+零 tick-failed（修复前风暴 52 strikes）；守护 KILL 一次拉起 resumed=1、journal 零 BridgeError（修复前崩溃循环永久下线）；死会话 resume 重建链闭环；控制三连 ✓；多行契约注入成功驱动真实模型回合（修复前 INJECT_TEXT_MULTILINE 拒绝、契约从未送达）；structured 对照 AKSK_MISSING 豁免成立（未烧配额）。
  - **目标完成受上游阻塞（非桥接缺陷，如实记录）**：复验目标因模型服务端持续 5xx 未产出 hello-bridge.txt——完成判据按主控裁定降级口径（"恢复链路证据完整"）达成，不虚报目标完成。
- **门禁口径**：单文件 ≤1000 行全过（最大 920 行）；`.tmp/` 验收证据（24 文件）不入库。

## 遇到的问题与根因

1. **厂商升级"先改名后部署"+跨 ZFS EXDEV 缺陷链（上游缺陷，本项目防御的源头）**：升级器先 rename 旧二进制再部署，部署 rename 源 `/tmp`（st_dev=29）目标 `/home`（st_dev=52）跨 ZFS 数据集返回 `Errno 18 EXDEV`，错误被静默吞掉 → 旧已改名新未落位"无 CLI"残局（10-24、10-29 两次报障；10-31 真机验收第三次现场触发）。防御：T1-04 备份自愈+copy 部署+同数据集暂存+失败零损坏矩阵；现场急救 `ln codearts.bak-26.10.9 bin/codearts`（硬链接零副本）。建议上报华为。
2. **TUI 自升级交互门**：wrapper 设 `OPENCODE_CHANNEL=latest`，TUI 启动即进入自升级检查（T13 真机取证：35s 引导屏仅 378 字节=`✶ 检查更新... 发现新版本 26.10.13`），`autoupdate:false` 不抑制该前置门；盲注入被对话框吞掉。处置：依赖停滞重试的最终递达（T13 第 5 轮实证可递达）；TUI-ready 门（就绪信号后再注入）登记为 M3 增强候选，非本期基线。
3. **真机验收 5 缺陷的根因与修复**（dad203fc53，全部"Fake 测不到的真机行为差异"，矩阵盲区）：
   - **④[严重] 守护重启崩溃循环**：`pty-script.alive()` 对未知 ref 抛 SESSION_UNKNOWN 而非返回 false → 重启对账上抛 → daemon exit 1 → systemd 无限拉起（存在活跃目标即永久下线）。修复：alive()=布尔契约写入 types.ts 真相源、4 传输对齐、崩溃循环回归断言。
   - **③[严重] 死会话重启风暴**：`runner.restartLocked` 把死 ref 原样回传 `transport.start(cfg, ref)`，script 宿主拒绝复活 → 5s 周期空转（strikes 攀至 52）。修复：start(死 ref) 销毁残留+新建活会话，回传 ref 须过自检（alive=true），restartLocked 采纳回传 ref。
   - **②[高] 多行契约被 PTY 拒绝**：契约天然多行，两段式注入误作"拒绝多行"（INJECT_TEXT_MULTILINE）→ 任何目标契约都无法送达（首 tick 实证）；且 injectPrompt 先改状态后传输，被拒仍留 injected 指纹。修复：PTY inject 改多行安全（整块写入+独立 Enter），拒绝分支删除。
   - **①[高] 生产 verifyRun 未接线**：daemonCommand 装配 GoalHost 未传 verifyRun → 带 verify 的 POST /goals 必失败且遗留半成品目标（会击穿④）。修复：execVerify（execFile+60s 超时+截断+cwd=workdir）+生产装配专测。
   - **⑤[中] 死会话 resume 永久失败**：resume 直接操作死 ref 仅 SESSION_NOT_ALIVE。修复：resume 前置 alive 检查，死→重建+resume 契约。

## 经验总结（已沉淀全局经验库 `~/.codeartsdoer/experience-reuse/experiences/`，索引已刷新至 active 496）

1. [厂商升级"先改名后部署"+跨 ZFS rename EXDEV→静默损坏；防御=copy 部署+同数据集暂存+备份自愈](../../../.codeartsdoer/experience-reuse/experiences/build-env/2026-10-31-huawei-upgrade-rename-first-deploy-later-defect.md)（build-env，tier S）——部署逻辑三铁律与现场硬链接还原手法。
2. [opencode 2.1.4/2.2.5 本地目录插件加载形态实测](../../../.codeartsdoer/experience-reuse/experiences/build-env/2026-10-31-opencode-plugin-loading-214-225.md)（build-env，tier S）——双版本对照表+三重活证排障顺序；加载语义随小版本反转。
3. [PTY 两段式注入+alive() 布尔契约——真机验收抓矩阵盲区](../../../.codeartsdoer/experience-reuse/experiences/coding-pattern/2026-10-31-pty-two-stage-injection-and-alive-contract.md)（coding-pattern，tier S）——内容与提交分离；监督谓词"查询不抛错"；**Fake 测试覆盖率上限=Fake 与生产的语义一致性**。

方法论沉淀：真机验收的不可替代价值在抓"Fake/矩阵盲区"（5 缺陷中 4 个属语义分歧）；发现后必须把语义钉进类型真相源+回归断言，而非只修实现。

## 关联提交号与文档

- 本任务提交：见清单第 36 项（本日志 + `操作记录/codearts-bridge真机验收T4-02-2026-10-31-操作日志记录.md` 随库补录；`plugins/codearts-bridge` 代码零改动）。
- 设计文档：`docs/superpowers/specs/2026-10-30-codearts-integration-opencode-design.md`（§2 四条硬性要求/§4 证据台账 F1~F7）。
- 实施计划与任务卡：`.superpowers/sdd/2026-10-31-codearts-integration-opencode-implementation-plan/`（task-1~23 brief/report、progress.md）。
- 公开仓库：https://github.com/daheix/open-codearts （PUBLIC，0283540..5a8a440；稳定检出 `/home/wsc/wsc/open-codearts`）。
- 全局接入位置：`~/.config/opencode/plugins/codearts-bridge.ts`（一行 re-export 指向公开稳定检出，2.2.5 autoload 实测生效）。
- 前序止损日志：`操作记录/codearts工作台启动故障与升级失败修复-2026-10-30-操作日志记录.md`（主检出工作区，未入库）。
- 后续：项目 B（dsh 完整集成）按 spec §3 待 A 验收后另行立项；延后项登记——TUI-ready 门、PTY 空闲软重启、公开 README 2.2.5 全局 jsonc 单元格"未验证"标注、评审 3 新 Minor（fake alive kind 校验/resumeLocked active 先置/start 重建失败窗口）。
