# Task 20 报告：systemd 服务与 watchdog（T3-07）

- **Status: DONE**
- **Commit: `599af05100`**（BASE `f736a61216`，分支 `codearts-bridge`，只含 `plugins/codearts-bridge` 4 文件）
- **测试：全量 455 计数（454 pass + 1 skip + 0 fail，2056 expect）/ `tsc --noEmit` 零错误；新增 33 用例**
- **真机安装已保留**（任务书 Step 5 + M4 需要）：`codearts-bridge.service` + `codearts-bridge-watchdog.timer` 均 active。

## 1. 实现内容

### 1.1 `src/core/service.ts`（新增，223 行，纯函数层）

| 导出 | 职责 |
|------|------|
| `renderServiceUnit({bunPath, cliPath, stateDir, user?})` | 守护单元渲染：`Restart=always` + `RestartSec=3`（崩溃自愈归 systemd）、`ExecStart="bun" "cli.ts" daemon`（双路径引号包裹，防空格路径拆参）、`Environment="CODEARTS_BRIDGE_STATE_DIR=…"`（守护与 watchdog 单一路径真相源）、`StandardOutput/StandardError=journal` + `SyslogIdentifier`（R-sv2"日志到 journal"）、`WantedBy=default.target`；`user?` 传入时出 `User=` 行；相对路径显式抛 `SERVICE_UNIT_INPUT_INVALID` |
| `renderWatchdogUnits(input)` | watchdog 单元对：`Type=oneshot` + `ExecStart=… watchdog-probe`；timer `OnCalendar=minutely` + `Persistent=true` + `Unit=` 指向 + `WantedBy=timers.target` |
| `evaluateProbe({httpCode, prevFails, graceActive}, now)` | 纯评估（R-sv1 签名原样）：宽限期 → `ok` 且计数原样（不探测不计数不清零，dsh 原型同语义）；`httpCode>0` → `ok` 清零（**任意状态码含 401/500 都证明事件循环存活**——dsh 模式口径）；`httpCode=0` → fails+1，达 2 → `restart`（计数清零重新累计），否则 `increment`；输出含 `atMs`（now 透传，结构化日志取时）；非法输入显式 `WATCHDOG_INPUT_INVALID` |
| 常量 | `WATCHDOG_GRACE_SECONDS=120` / `WATCHDOG_FAIL_THRESHOLD=2` / `WATCHDOG_PROBE_TIMEOUT_MS=15000` / `WATCHDOG_FAILS_FILE="watchdog-fails"` / `SERVICE_UNIT_NAMES` / `SERVICE_RESTART_SEC=3`（CLI 与渲染共用单一真相） |

### 1.2 `src/cli.ts`（修改，628 行）

- **`service install`（R-sv3）**：渲染三单元 → 幂等写入 `~/.config/systemd/user/`（**同内容不重写，mtime 不变**；变更经 `atomicWriteFile` 0644 原子替换）→ `systemctl --user daemon-reload` → `enable --now codearts-bridge.service codearts-bridge-watchdog.timer`（watchdog.service 由 timer 激活，不单独 enable）。全部 systemctl 经注入 `Exec`，测试绝不真装。stdout 输出 `{installed, written, skipped}`。
- **`service uninstall`（R-sv3）**：只删本插件三单元（他单元不碰，测试钉死）；三单元全缺 → 幂等 rc 0 零 systemctl 调用；`disable --now` 失败（未启用/未加载）属幂等卸载预期，**stderr 留痕后继续删文件**（失败可见，非静默），`daemon-reload` 收尾。
- **`service status`**：单元在场性 + `is-active` 状态汇总 JSON（rc 0）；守护单元缺失 → `SERVICE_NOT_INSTALLED` 结构化 stderr + rc 1。
- **`watchdog-probe`（R-sv1/R-sv4）**：① `is-active --quiet` 预检——非 active → 清计数退出（进程崩溃归 `Restart=always`，探针只管"活着但卡死"）；② 宽限 120s——**stateDir 启动戳方案**：`daemon.pid` mtime 即启动时刻（守护每次启动写/覆写，daemon.ts `acquirePidfile`），免 systemctl 时间戳解析的时区歧义；pid 缺失 = 守护尚未完成启动 → 按宽限跳过；③ 计数读取：损坏/空 → stderr 留痕按 0 起算（对齐 daemon.pid 陈旧清除先例，非静默）；④ `fetch /health` 15s 超时——拿到任何应答 → `httpCode=状态码`；未拿到 → 0，`reason` 分类 `timeout`/errno（如 `ECONNREFUSED`）/`non-json`/`ok-mismatch`/`http-N`（R-sv4，每轮一行 `[codearts-bridge watchdog]` 结构化 stderr → journald）；⑤ `evaluateProbe` 裁决 → 清计数/落新计数/`systemctl --user restart`。设计依据（写入头注）：体级异常（non-json/ok≠true）**有应答即存活、只留痕不重启**——重启无法修复端口被占用类问题，留痕排障才是正解（dsh 原型第 3 行原口径 + R-sv4"分类入 stderr/journal"字面）。
- **登记项①落地（T3-05/T3-06 交接）**：`daemonCommand` 生产装配挂载 GoalHost——新增 `resolveProductionTransport`（与 `runOnce` 逐行同构：`readAksk` → 按需 tmux 探测 → `selectTransport` → `defaultBuildTransport`）+ `new GoalHost({cfg, transport, clock: defaultRunClock, loop: defaultTickLoop(GOAL_SWEEP_INTERVAL_MS)})`，装配失败显式拒绝启动（目标域不可用的守护不装作健康）。生产形态下 `/goals*` 不再 501。
- CLI 分派：`service install|status|uninstall`、`watchdog-probe`；USAGE 更新。

### 1.3 `src/core/run.ts`（修改，1 处）

`needsTmuxProbe` 增 `export`（+注释）：daemon 生产装配与 `runOnce` 共用同一 tmux 探测条件，杜绝第二套选择真相源（M78 双份同码教训）。**Files 偏差登记**：任务书 Files 未列 run.ts；此为登记项①装配的最小必要改动（一词 export）。

### 1.4 `test/service.test.ts`（新增，33 用例）

生成器内容断言（Restart/ExecStart 绝对路径/Environment/journal/WantedBy/User 可选/相对路径抛错）、evaluateProbe 七分支（宽限/200/401·500 存活/首败/第 2 败/atMs/非法输入）、install 幂等（**mtime 钉死** + exec 序列 + exec 失败结构化 rc 1）、uninstall（他单元不碰 + 未安装零调用）、status 两态、探针九场景（非 active/宽限/健康/首败/重启/体异常三分类/计数损坏）、真进程 daemon 装配（`GET /goals` 200=[]，装配前 501——回归钉死；`/health` 含 `actives`）。全部注入 exec/fetch/时钟/路径，绝不真装真连。

## 2. TDD 证据

- **RED**：`bun test test/service.test.ts` → `error: Cannot find module '../src/core/service'`（1 fail，模块未建）。
- **GREEN**（实现后）：新文件 33/33 pass → 全量 455（454+1 skip）/ 0 fail。
- 中途修正两处：① fixture `nowMs` 数值 → 时钟函数（与接口约定一致）；② `typeof fetch` → `FetchLike` 结构类型（Bun 全局 fetch 带 `preconnect` 属性，纯 fake 无法满足——T3-06 `DaemonFetcher` 同款先例）；`reason` 定值分析报错 → 重构为 `probeHealth` 返回结构小函数（顺带提升可读性）。

## 3. 真机安装观察（任务书 Step 5，安装保留）

| 观察 | 结果 |
|------|------|
| `bun src/cli.ts service install` | rc 0，三单元写入 `~/.config/systemd/user/` |
| `systemctl --user status codearts-bridge` | **active (running)**，PID 501551，`ExecStart=/home/wsc/.bun/bin/bun …/src/cli.ts daemon`，监听 127.0.0.1:4577；journal 出传输选择行（pty-script，systemd 环境无 tmux） |
| `kill -9 501551` → 6s 后 | **active**，新 PID 502400 重绑 4577，`/health` `{"ok":true,…}`；journal 见陈旧 pidfile 自愈 + 启动对账 resumed=0 blocked=0（T3-04/T3-05 路径生产验证） |
| watchdog timer（每分钟） | 16:15:16 宽限跳过（49s）→ 16:16:21 宽限跳过（113s）→ 16:17:21 `code=200 reason=healthy fails=0 action=ok`；计数文件不在场（健康态） |
| 幂等复装 | `written:[]`、`skipped:` 三单元、**mtime 不变** |
| `service status` | JSON 全 active，rc 0 |

**安装保留状态**：daemon + timer 均 enabled+active（M4 落地需要）。

## 4. 自审发现（完整性/质量/YAGNI/测试真实性）

- **裁定偏差 2 处（均已在代码注释登记）**：① `renderWatchdogUnits` 裁定文写 `()`，但 R-sv2 内容断言要求 watchdog ExecStart 绝对路径——无参签名无法嵌入 bun/cli 路径，取同参签名（纯函数性质不变）；② 任务书 Step 1 "watchdog 脚本 bash -n"被 R-sv1 内置化取代（无 bash 脚本，无 shellcheck 项）——R-sv1 明示"单二进制自含，优于外置 bash"。
- **显式决策（非兜底，可审计）**：uninstall 的 disable 失败容忍与计数损坏按 0 起算均 **stderr 留痕后继续**（幂等卸载/派生计数损失无害，对齐 daemon.pid 陈旧清除先例）；宽限期取 stateDir 启动戳而非 systemctl ActiveEnterTimestamp（裁定允许二选一，选免时区歧义者）。
- **YAGNI**：无投机参数；`user?` 为裁定签名原样；常量仅渲染与 CLI 共用所需。
- **测试真实性**：探针/安装全注入，唯一真进程用例（装配回归）与 daemon.test.ts 既有模式同构（本机空闲端口 + 本地 HTTP，无外部依赖）。

## 5. 遗留问题 / 担忧

1. **单元文件锚定 worktree 路径**：`ExecStart` 的 cli.ts 指向本 worktree（`.local/share/opencode/worktree/e5785e/...`）。若该 worktree 将来被清理，服务会 fail-loop（systemd+watchdog 会持续重启报错，journal 可见）。**建议分支合回主检出后重跑一次 `service install`**（幂等，自动覆写路径）。
2. **M74/M72 等 Minor**（resume 瞬态 roster 不一致、verify trim-drop 等）：本任务挂载 GoalHost 即登记项①"roster 随对账重建消化"的落点（真机对账 resumed=0/blocked=0 跑通）；runner 层 API 级改进（如 dispose）超出本任务 Files，未动。
3. **端口占用排障路径**：若 4577 被其他进程占用，探针会持续 `non-json`/`http-N` 留痕但 restart 无解（设计如此，留痕排障）；考虑未来在 reason 里附 `_DAEMON_PORT_CONFLICT` 提示（未做，YAGNI）。
4. **workdir/maxRounds 消费者**（T3-05 登记项③）与插件重载 goalId 映射（T3-06 concern）保持原状，非本任务范围。

## 6. 文件清单

- 新增：`plugins/codearts-bridge/src/core/service.ts`（223 行）
- 修改：`plugins/codearts-bridge/src/cli.ts`（176 → 628 行）
- 修改：`plugins/codearts-bridge/src/core/run.ts`（needsTmuxProbe 增 export）
- 新增：`plugins/codearts-bridge/test/service.test.ts`（668 行，33 用例）
- 单文件 ≤1000 行铁律：全部满足（最大 cli.ts 628）。
