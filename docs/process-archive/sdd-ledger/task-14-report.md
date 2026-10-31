# Task 14 报告：守护进程骨架与 API（T3-01）

- **Status: DONE**
- **Commit: `53c10ed60d`** `codearts-bridge(T3-01): 守护骨架 — 令牌鉴权/健康端点/CLI 前台模式`
- 工作区：`/home/wsc/.local/share/opencode/worktree/e5785e/codearts-bridge`（分支 `codearts-bridge`）

## 1. 实现内容

### `src/daemon.ts`（新增，276 行）— createDaemon(cfg)（R-d1~R-d4）
| 裁定 | 落点 |
|---|---|
| R-d1 网络面 | 绑定地址硬编码 `127.0.0.1`（不受 daemonUrl 主机名影响，注释注明裁定依据）；端口唯一来源 = `cfg.daemonUrl` 端口段（loadConfig 默认 `http://127.0.0.1:4577`，故"默认 4577 可配（loadConfig 覆盖）"经既有 daemonUrl 字段实现，**不新增第二个端口配置真相源**）；`port:0` → 内核随机分配，实际端口经 `start()` 返回；`daemonPortOf()` 导出（默认 4577 / 0 保留 / 0~65535 校验，非法显式抛 `DAEMON_CONFIG_INVALID`） |
| R-d2 token | `<stateDir>/daemon-token` 首启 `crypto.randomBytes(32).toString("hex")` 生成，经 `atomicWriteFile` 原子写入（mode 0600，umask 无关）；重启复用（复用路径显式 `chmod 0600` 收紧）；鉴权 `Authorization: Bearer <token>`，`timingSafeEqual` 常量时间比较；缺失/错误 → 401 `{error:{code:"UNAUTHORIZED"}}`；文件存在但为空 → `DAEMON_TOKEN_INVALID` 显式报错（**不静默重新生成**——重生成会使已缓存令牌的客户端静默失联）；非 ENOENT 读错误 → `FS_READ_FAILED` |
| R-d3 路由语义 | `GET /health` **免鉴权**（设计依据入头注：健康探测不得要求凭据——watchdog 若须先读 token 才能探活，token 损坏即探活死锁；端点只回静态摘要无凭据外泄面）→ `{ok:true, version, uptime}`；未知路由 → 404 `{error:{code:"NOT_FOUND"}}`；其余一切请求（含非 GET 打 /health）一律先鉴权再路由 |
| R-d4 生命周期 | `start()` 幂等复用（进行中/已完成的 start 复用同一 Promise，注释注明选择理由：监督循环重复触发下"拒绝"语义制造竞态脆弱点）；`stop()` 先 `closeAllConnections()` 斩断全部 keep-alive 再 close（防 close 回调悬挂致 bun test 不退出）；stop 幂等（未启动空操作）、stop 后可再次 start（token 重启复用的重启路径） |

**Bun 运行时差异（实证处理）**：Bun 1.4.2 中 `server.closeAllConnections()` 会顺带停掉监听（`listening=false`、端口即释），随后 `close(cb)` 以 `ERR_SERVER_NOT_RUNNING` 回调报错；Node 中则保持监听。`stop()` 按 `server.listening` 实际状态分派两条路径（注释详实：两条路径收敛不变量一致——端口已释放、连接已全断，非兜底）。

**其他**：listen 失败 → `DAEMON_LISTEN_FAILED`（含 errno）；处理器意外异常 → 500 `{error:{code:"INTERNAL"}}`；所有响应（含错误）均 `application/json` 结构化。

### `src/cli.ts`（重写，176 行）— R-d5
- **`daemon`**：前台启动守护。**信号处理器先于 `start()` 注册**——修复真实竞态缺陷：旧实现"打印就绪行→注册处理器"存在窗口期，Bun 的 console.log 管道写同步返回后父进程可先于子进程完成注册而 kill，信号按默认处置直接杀进程（优雅停止失效），实测复现率约 50%（退出码 143）。修复后任何时刻的信号都进入优雅路径（start 期间到达 → start 完成后立即优雅停止）。SIGINT/SIGTERM → 优雅 stop → exit 0；stop 失败 → stderr 结构化 `DAEMON_STOP_FAILED` + exit 1；start 失败 → 移除信号监听后异常上抛（main 统一 exit 1）。
- **`status`**：fetch `<daemonUrl>/health`（GET，免鉴权），`AbortSignal.timeout(3000)`；成功 → stdout 健康 JSON + exit 0；不可达/超时 → `DAEMON_UNAVAILABLE`（remediation 含启动命令）；非 200 → `DAEMON_UNAVAILABLE`；非 JSON → `HEALTH_INVALID`；`ok≠true` → `HEALTH_MISMATCH`；均 stderr 结构化 + exit 1。
- `version`/`help`/未知命令 exit 2 原样保留；命令函数返回退出码、仅 `import.meta.main` 真正 `process.exit`（可测试性）。

## 2. TDD 证据

- **RED**：先写 `test/daemon.test.ts`（16 用例）→ `Cannot find module '../src/daemon'`，0 pass / 1 fail。
- **中间迭代**（实现后暴露 2 个真问题，均根因修复）：
  1. `stop()` 全线报 `ERR_SERVER_NOT_RUNNING` → 最小实验定位 Bun `closeAllConnections` 停监听怪癖 → 按 `listening` 分态修复；
  2. SIGINT 子进程用例偶发 143（复现率 ~50%，6 连跑 3 败）→ 根因是 `daemonCommand` "打印就绪行→注册信号处理器"窗口期竞态（非 Bun 怪癖：同场景 SIGTERM 亦败、干净进程 SIGINT 亦败、普通 bun 脚本 `proc.kill` 正常；管道写同步返回后父进程可先 kill）→ 信号处理器先于 start 注册修复。
- **GREEN**：修复后 daemon.test.ts 单文件 **6/6 连跑全绿**；SIGINT 子进程用例确定性通过。

## 3. 测试结果（最终）

- `bun test`：**296 计数 = 295 pass + 1 skip + 0 fail**（既有 280 全绿保持；新增 16 用例）；全量复跑 2 次稳定。
- `bun run typecheck`：**零错误**。
- 行数红线：`src/daemon.ts` 276 / `src/cli.ts` 176 / `test/daemon.test.ts` 386，均 ≤1000。
- 新增用例覆盖：/health 免鉴权两态（无 token/错误 token 均 200，钉死防回归 401）、token 首启 64hex+0600、重启复用（旧 token 经 404 证明有效）、未知路由 401（无 token/错 token/Basic 方案）、404 结构化（正确 token）、POST /health 鉴权序（无 token 401 → 带 token 404）、start 幂等同端口、显式端口采用、stop 幂等可重启、CLI status 在场/不可达、**真进程 SIGINT 全链路**（spawn → 监听行 → SIGINT → exit 0 → 同端口立即复监听复核端口释放）。
- 真机冒烟：`bun src/cli.ts help/version/未知命令`（rc=2）；`daemon` + `kill -INT` → 优雅停止 exit 0；`status` 不可达 → 结构化 DAEMON_UNAVAILABLE rc=1。

## 4. 文件清单

| 文件 | 变更 | 行数 |
|---|---|---|
| `plugins/codearts-bridge/src/daemon.ts` | 新增 | 276 |
| `plugins/codearts-bridge/src/cli.ts` | 重写（保留 version/help/未知命令语义） | 176 |
| `plugins/codearts-bridge/test/daemon.test.ts` | 新增 | 386 |

提交仅含上述 3 文件（`git add plugins/codearts-bridge`）；工作区根 `opencode.json` 的 dev 接线本地改动未触碰、未提交。

## 5. 与任务书的偏差（裁定优先）

- 任务书 Step 1 早稿"`GET /health` 无 token → 401"与主控裁定 **R-d3（/health 免鉴权，防 watchdog 死锁）** 冲突，按派发指令"主控裁定直接遵守"执行：/health 无 token/错误 token 均 200，鉴权语义经未知路由 401/404 验证；测试注释与本报告均已注明。
- `port` 不新增 BridgeConfig 字段：经 `daemonUrl` 端口段承载（R-d1"loadConfig 覆盖"的最小实现，避免双真相源），`daemonPortOf` 注释说明。

## 6. 自审发现（已处理）

- `daemonCommand` 内 `onSignal` 闭包引用后置 `const removeSignalListeners`（TDZ 风格隐患）→ 已调整声明顺序。
- stop() 的 Bun/Node 分歧按 `server.listening` 显式分派并在注释中写明两路径的收敛不变量，规避"静默兜底"嫌疑。
- token 复用路径 `chmod 0600`：显式权限收紧（防外部工具放宽后残留），非错误掩盖；空令牌拒绝而非静默重生成。

## 7. 遗留问题/担忧（供主控裁决）

1. **`closeAllConnections` 的 Bun 行为差异**：Bun 1.4.2 中该调用顺带停监听。已按 `listening` 状态分派并在两平台语义等价（端口释放+连接全断）；若后续升级 Bun/切换 Node 运行时，此路径已注释醒目提示。后续任务（T3-04/05）无需感知。
2. **`start`/`stop` 并发未做队列化**：当前约定"监督循环串行调用"（注释声明）；stop 在 start 进行中调用的行为未钉死（T3-04 挂载监督循环时若有并发需求再扩）。
3. **`/health` 的 `actives` 字段**（spec §7.2）留待 T3-03/04 目标循环落地时补充，本卡按任务书只交付 `{ok,version,uptime}`。
4. **server.ts 的 daemon 占位文案**（status 工具中 `connected:false`）按计划属 T3-06 接线时更新，本卡未动 server.ts（Files 清单外，最小变更面）。
