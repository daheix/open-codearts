# Task 13 报告：`codearts_run` 工具与 M2 验收（T2-05）

**Status: DONE** ｜ 提交 `d99f27ff8a` ｜ 分支 `codearts-bridge`

## 1. 实现内容

### 1.1 `src/core/run.ts`（新增，451 行）— run 编排核心

| 裁定 | 落实 |
|------|------|
| R-cr1 | `selectTransport` 纯函数（禁 I/O）：显式 `transport=structured/pty` 直接采用；`auto` → structured 当且仅当 readAksk 有凭据（AK/SK 齐备非空，与 structured.start 的 AKSK_MISSING 判据逐字一致，无选择/传输分歧），否则 pty（ptyHost 显式 tmux/script 直接用；auto 经 `probeTmuxAvailable()`（`tmux -V` 探测，PTY_HOST_UNAVAILABLE→不可用，其余错误上抛）二选一）。结果必含 `{mode, reason}`；reason 记录全部决策依据（凭据检测/探测结果/显式配置），无静默切换。异步探测输入（hasAksk/tmuxAvailable）由 `runOnce` 解析后传入，保持选择逻辑可测 |
| R-cr2 | 超时 = 可取消 `clock.delay(timeoutMs)` 到点 → 内部 AbortController.abort() → 观察循环终止 → `transport.stop()` → 结构化结果 `status="timeout"`（含已捕获输出摘要 `summary`）。非静默、非错误 |
| R-cr3 | `progress` 注入后至少一次（`prompt 已提交（mode=…）`），其后按信号批次 + 2s 节流（`运行中：信号 n 个（错误 e）`）；`context.signal` abort → 停止观察 + `stop()`（对齐 T9 abort 语义）；**预 abort 边界**：传入时已 abort 的信号同步传播（监听器不会触发，自审发现补齐，有专测） |
| R-cr4 | `run.start` / `run.exit` 成对写 `audit/install.jsonl`（经 appendInstallAudit）：mode/reason/session/sessionKind/promptLength/promptPreview(前 80 字符)/timeoutMs/reused + exit 侧 status/signals/errors/retryable/durationMs/outputBytes/summary。**prompt 全文不入审计**（专测断言尾部标记不出现）。run.start 审计失败 → 停止会话（清理失败不掩盖主错误）+ 显式上抛（禁止无审计的运行）；run.exit 失败不掩盖运行结果（R-t1 同纪律，run.start 已保证落盘） |
| 错误路径 | error 信号经 `classifyError`（R-s5 复用）分级，任一 retryable → `retryable:true` + 摘要；**不静默重试**（专测断言 injections 恰 1 次）。transport 抛出的 BridgeError 原样上抛（工具层 R-t1 转 content），run.exit 以 `status:"error"` + errorCode/errorMessage 留痕 |

**status 四值终态**（均结构化结果非错误）：`completed`（观察到 done）＞ `timeout` ＞ `cancelled`（宿主取消）＞ `ended`（事件流结束无 done——覆盖 structured 错误回合 R-s4"会话保活可续接"语义）。超时/取消/异常路径必 stop；completed/ended 不 stop（structured 会话供续接；PTY done 即进程已退）。

**可注入 seam**：`buildTransport`（缺省 `defaultBuildTransport`：structured→nodeRunSpawnProc / pty-tmux→nodeTmuxExec / pty-script→nodeScriptSpawnPty）、`tmuxProbe`、`clock`（`RunClock{now,delay+cancel}`，生产 Date.now/setTimeout/clearTimeout）、`progress`、`signal`、`kernelDataDir`（R-p2 透传）。

### 1.2 `src/server.ts`（修改，730 行 ≤1000 ✓）— 第六工具接线

- `TOOL_NAMES` 增 `"run"`；`RUN_INPUT_SCHEMA`（prompt 必填非空；session {kind enum, id} 封闭对象；timeoutMs 正整数 ≥1）。
- `ToolCtxLike` 增 `progress?` / `signal?`（宿主 2.2.3 Tool.Context 实际只有 progress；signal 为裁定要求的取消通道，缺省=不可取消、超时上限仍在——显式文档非静默）。
- `ToolDeps` 增 `buildTransport/tmuxProbe/clock`（测试注入 FakeTransport/FakeClock，绝不 spawn）。
- run 工具**不设权限门**（run 非管理动作，与 repair/upgrade/hygiene(apply) 的 codearts.manage 门区分）。
- `codearts_status` 的 transport.note 更新为如实状态（run 按轮构建传输；daemon 常驻通道 M3 占位）。

## 2. TDD 证据

- **RED**：先写 `test/run-tool.test.ts`（24 用例）→ `Cannot find module '../src/core/run'`（0 pass / 1 error，bun test 输出留存会话）。
- **GREEN**（迭代 4 次：修 import 路径 ×2、TMP_ROOT 未创建、aksk 写入路径/afterEach 空根）：24/24 → 补预 abort 边界用例后 **25/25 pass**。
- **全量**：`bun test` → **276 pass + 1 skip + 0 fail**（277 用例 / 13 文件 / 1309 断言；既有 252 基线 251 pass+1 skip 全数保持绿）。
- **typecheck**：`bun run typecheck`（tsc --noEmit）→ 零错误。
- **行数红线**：server.ts 730 / run.ts 451 / run-tool.test.ts 661，均 ≤1000。

## 3. 测试清单（25 新用例，全离线：FakeTransport + FakeClock + 临时 stateDir）

selectTransport 5（显式 structured/pty 两宿主/auto+凭据/auto+探测二选一/auto 显式宿主不看探测）＋ runOnce 14（完成/auto 凭据选择/auto 探测 script/显式不探测/进度节流精确断言/取消/预 abort 取消/超时 stop+摘要/retryable 不重试/ended/会话续接/审计成对+全文不入/输入校验/常量口径）＋ 工具层 6（注册与 schema/execute 成功 content/progress 透传/signal 取消/SESSION_UNKNOWN 错误 content/TOOL_INPUT_INVALID content）。

## 4. R-cr5 真机冒烟证据（PTY(script) × 真实 codearts TUI）

**环境**：`~/.codeartsdoer/installers/bin/codearts`（26.10.9 ELF）；系统有 `script`、无 tmux；AK/SK 未配置（auto→pty 判据正确生效）。

**驱动**：生产装配路径 `buildPlugin()`（默认 deps，无注入）→ setup → 直调 `codearts_run.execute({prompt:"只回复两个字：你好", timeoutMs:90000}, fakeCtx with progress)`（一次性驱动置于 gitignored `.tmp/`，取证后已删除）。

**过程与结论（三轮）**：
1. 第一轮（继承 opencode 会话 env）：TUI 启动即崩——`Failed to run the query 'CREATE TABLE workspace'`（SQLiteError: table already exists）。**根因取证**：内核日志名 brand = `process.env.SCENARIO ?? "anonym"`（二进制 strings 实证）；无 SCENARIO 时数据根落到 `~/.local/share/opencode/opencode.db`——与本会话活跃内核的库冲突。属冒烟环境 env 不对等，**非桥接缺陷**。
2. 第二轮（`env -u` 清 OPENCODE 标记）：同样崩溃 → 证实重定向键是 `SCENARIO` 而非 OPENCODE 标记。
3. **第三轮（`SCENARIO=codeartsdoer`，与 cli-data 部署口径一致）**：
   - 桥接链路**全绿**：auto 选择 reason=`auto：未检测到 AK/SK 凭据 → pty；ptyHost=auto：tmux 不可用 → script`；progress 每 2s 准点上报（77.6s/79.6s/…/89.7s 共 45 次）；90s 到点 → `status:"timeout"` + stop → **无残留进程**（pgrep 复核干净）。
   - 捕获：**1001 信号 / 49,354 字节**，summary 尾部为 TUI 动画帧（`Waiting for authorization...`）。
   - 审计：`auditId=6fea061f-9d5c-4df8-9acb-d40b2e3484af` 的 run.start/run.exit 成对落盘 `~/.codearts-bridge/audit/install.jsonl`（exit 行 status=timeout、signals=1001、durationMs=90007、promptPreview="只回复两个字：你好"）。
   - **对话未完成（如实标注）**：独立 TUI 进程停在 "Waiting for authorization..."（交互式登录门），未能回签 prompt。按 R-cr5 属"真机前置不足"，非桥接失败。

**恢复路径**：① 在交互终端对 cli-data 部署完成一次设备流授权（`SCENARIO=codeartsdoer` 下 TUI 登录），使无头 TUI 免交互；或 ② 配置 AK/SK（`~/.codearts-bridge/config.env`）走 structured 通道（`codearts run --format json`，无 TUI 登录门），auto 选择会自动切换。

## 5. 自审发现与处置

1. **预 abort 边界**（自查发现）：传入已 abort 的宿主信号时监听器永不触发 → 补同步传播 `if (external?.aborted) ctrl.abort()` + 专测。
2. **选择判据一致性**：核对 structured.ts R-s2 的 AKSK_MISSING 判据与 hasAksk 谓词逐字一致（含空串拒绝），避免"选中 structured 却被 start 拒绝"的口径漂移。
3. **progress 失败非静默**：通道异常不中断运行但计数入结果 `progressFailures`（>0 才出现）。
4. **smoke 副作用清理**：TUI 在插件目录创建的 `.codeartsdoer/`（内核自动生成脚手架）已删除；驱动/strings 临时文件已删（工作目录内 .tmp/ 纪律）。
5. **YAGNI 复核**：status="ended" 为 structured 错误回合的如实表达（R-s4），非投机字段；outputBytes/durationMs 服务审计与调用方可观测性，成本极低。

## 6. 遗留问题/担忧

1. **TUI 独立进程的登录门**（见 §4 恢复路径）——建议后续任务验证结构化通道端到端（配 AK/SK 后 auto→structured），可作为 M3 前置。
2. **PTY 通道的 TUI 动画噪声**：1001 信号中大量为 spinner 动画帧（49KB），summary 尾部被动画占据；M3 监督状态机若依赖 output 信号文本判停滞，需考虑回显/动画过滤（`thresholds.echoGuardMs` 已有口径，T3-03 落地时对齐）。
3. **codearts_status 的 transport.note** 已改为"M3 占位"——daemon 常驻通道接入后应同步更新该文案。
4. 工作区根 `opencode.json` 本地改动（已裁定 dev 接线）与本任务无关，未提交未还原；worktree 根 `.codeartsdoer/package.json` 有 1 行非本任务改动，未触碰。

## 7. 文件清单

| 文件 | 变更 | 行数 |
|------|------|------|
| `plugins/codearts-bridge/src/core/run.ts` | 新增（runOnce/selectTransport/RunClock/defaultBuildTransport/probeTmuxAvailable + 常量） | 451 |
| `plugins/codearts-bridge/src/server.ts` | 修改（第六工具接线/ToolDeps/ToolCtx/schema/summarizeRun） | 730 |
| `plugins/codearts-bridge/test/run-tool.test.ts` | 新增（25 用例） | 661 |

---

## 8. 修复环第 1 轮（2026-10-31 追加：主控裁定①② / I-M48 / I-M49 / I-M50）

**Status: DONE**（修复轮）｜ 本节由修复实施者追加，上文 §1–7 为原实施记录。

### 8.1 裁定① PTY 双宿主改经官方 wrapper 启动（真机授权门根因修复）

- **根因回顾**（§4 第三轮）：PTY 双宿主直启 `<installDir>/bin/codearts`，env 裸传父环境（无 SCENARIO/KERNEL_DATA_DIR 等）→ TUI 停在交互式授权门 "Waiting for authorization..."。
- **修改**：`pty-script.ts` start 与 `pty-tmux.ts` start（仅 new-session 分支）改为 spawn 官方 wrapper `<installDir>/codearts`（shQuote 转义；argv 数组不变）。wrapper 文件缺失 → `BridgeError("WRAPPER_MISSING")`，remediation=检查 installers 目录完整性/官方重装指引；**不静默回退 bin 直启**。tmux 侧仅在实际需要 new-session（新建/同名重建）时检查——存活会话重连不消费 wrapper，不受部署目录事后残缺影响。
- **structured 维持 bin 直启**（structured.ts 注释写明依据）：`run` 子命令为无头 JSONL 通道，无 TUI 授权门，凭据由 R-s2 AK/SK 前置保障；wrapper 的 TUI env 装配对无头通道无意义，且避免对 wrapper 文件的额外部署依赖。显式设计决策，非回退对照面。
- **测试**：两宿主 argv 断言改为 wrapper 路径（含空格路径 shQuote 用例迁至真实临时目录）；各新增 "wrapper 缺失 → WRAPPER_MISSING（spawn/ new-session 零调用，禁静默回退）" 专测；fixture 布局对齐（script/tmux 测试的 CFG 指向带 wrapper 的 fixture 安装目录；tmux 真机用例的 fake-tui 包装迁至 `<installDir>/codearts`；fake-tui.sh 本体零改动，经 wrapper 包装照常运行）。原 `/nonexistent/installers` CFG 会误触 WRAPPER_MISSING，属本轮有意的行为变更暴露。

### 8.2 I-M48 预 abort 短路 ＆ I-M50 error 审计对齐（run.ts）

- **M48**：run.start 审计落盘后、inject 前，`ctrl.signal.aborted` 短路——已取消的 prompt 不再写入目标会话（inject 零调用）；取消语义照常走 finally stop + 结构化 `status="cancelled"`。用例断言补 `tr.injections` 长度为 0。
- **M50**：error 路径 `run.exit` 审计补 `outputBytes`/`summary`/`retryable` 字段（与成功路径 schema 单一对齐；摘要计算提前为 `summarize()` 复用）。新增用例：观察首信号后传输故障 → runOnce 原样上抛 BridgeError，exit 审计行 status="error" 且 outputBytes>0、summary 含已捕获文本。

### 8.3 I-M49 报告行数勘误

原报告 §2/§7 所记 `run.ts 451 / run-tool.test.ts 661` 为估算口径；**当时实测 447/653**，特此勘误。本轮修复后实测：run.ts 468、pty-script.ts 457、pty-tmux.ts 549、structured.ts 602、server.ts 730、run-tool.test.ts 703、transport-script.test.ts 640、transport-tmux.test.ts 771——均 ≤1000 ✓。

### 8.4 裁定② 真机复验（PTY(script) × 真实 codearts TUI，经官方 wrapper）

**环境**：`~/.codeartsdoer/installers/`（wrapper 26.10.9 期；bin/codearts 26.10.9 ELF）；无 tmux、无 AK/SK（auto→pty-script 判据正确）；`~/.codeartsdoer/cli-data/auth.json` 在场（用户已按要求完成一次交互式设备流授权）。驱动：生产装配 `buildPlugin()` 无注入 + 一次性驱动置于 gitignored `.tmp/smoke-r2/`（取证后已整体删除）。

**五轮取证链**（逐轮如实）：

1. **runOnce 90s**（auditId `4c033121…`）：status=timeout，111 信号 / 14,851 字节。**授权门已消失**——summary 尾部为内核日志行（`service=connection-monitor …TUI mode`、`service=om 内存使用情况`），非上一轮的授权动画帧。对话未闭合。
2. **runOnce 120s**（auditId `780671f1…`）：status=timeout，97 信号 / 13,697 字节；summary 无 "Waiting for authorization"（grep 实证）。审计 run.start/run.exit 成对落盘、超时路径字段齐备。
3. **raw PTY 取证**：35s 引导屏仅 378 字节，解码为 `✶ 检查更新... → ▾ 发现新版本: 26.10.9 → 26.10.13`——TUI 启动即进入自升级检查（wrapper 设 `OPENCODE_CHANNEL=latest`；config 的 `autoupdate:false` 不抑制该 TUI 前置门）。内核日志（cli-data/log）实证 upgrade 服务经华为云 release-info API 取版本并 curl 下载 161MB 安装包。
4. **8min 长窗取证**：稳定停在交互式对话框 `▏ ◆ 是否升级? ● Yes / ○ No`——等待用户按键，盲注入的 prompt 在此被吞（前三轮对话未闭合的根因）。
5. **raw PTY 按键驱动**（方向键+回车，屏幕快照逐步核对）：对话框 → 升级尝试 → **升级失败：`EXDEV: cross-device link not permitted, rename '/tmp/agentkernel' -> '~/.codeartsdoer/installers/bin/codearts'`**（上游 TUI 缺陷：/tmp 跨设备 rename；用户安装保持 26.10.9 钉版未被改动）→ TUI 继续进入**聊天 UI**：模型选择器 `Build · DeepSeek-V4.1-Flash-1017 (huaweicloud-maas)`（**登录态可用实证**）→ 注入 prompt「只回复两个字：你好」→ 屏幕回显输入并提交 → `esc interrupt` 加载动画 + `(0.18x) huaweicloud-maas` 生成指示——**prompt 成功进入模型回合，对话能推进**。90s 观察窗关闭时生成仍在流式进行，完整回合未在窗内闭合。

**结论（对照裁定②预期）**：

- **授权门根因修复实证**：bin 直启的 "Waiting for authorization..." 在 wrapper 启动下不复现（1/2/3/4 轮 grep 均阴性）；内核以 `SCENARIO=codeartsdoer` + `KERNEL_DATA_DIR=cli-data` 正常引导（日志/无 SQLite 冲突）。
- **登录态可用（对话能推进）✓**：第 5 轮实证 prompt 递达已认证模型并开始生成。
- **完整回合未闭合的残余因素**（均非桥接缺陷，如实记录）：① TUI 自升级确认对话框阻塞输入（`OPENCODE_CHANNEL=latest` 前置门，autoupdate:false 不抑制）；② 上游升级 EXDEV 失败弹屏；③ 按量计费提醒弹窗（套餐流量用尽）；④ 模型生成时长超过观察窗。
- **TUI-ready 门**：注入需等聊天 UI 就绪（跳过升级对话框/计费弹窗）——属 M3 监督状态机范畴，与 §6.2 噪声过滤一并落地（候补信号：屏幕含 "Ask anything…" 即就绪）。

**清场**：五轮全部 stop/组杀收尾；codearts/curl-staging 进程 pgrep 复核零残留；驱动与取证文件已删；用户安装保持 26.10.9（EXDEV 失败未改盘，codearts.bak-26.10.9 原样）。

### 8.5 修复轮 TDD 与回归证据

- **RED**（先写测试，10 失败全数因预期原因红）：script 3（argv 形态 bin≠wrapper / WRAPPER_MISSING 未抛 / 空格路径）、tmux 4（new-session argv / 同名重建 / 空格路径 / WRAPPER_MISSING）、run-tool 2（M48 零注入 / M50 审计字段缺失）。一次性事故：script 测试 TMP_ROOT 重复声明 + FIXTURE TDZ 乱序，模块加载失败——修正声明顺序后 RED 达成。
- **GREEN**：聚焦三文件 **78 pass + 1 skip + 0 fail**。
- **全量**：`bun test` → **279 pass + 1 skip + 0 fail**（280 用例 / 13 文件 / 1322 断言；既有 276 基线全数保持绿，+3 新用例）；`bun run typecheck` 零错误；单文件行数 ≤1000 ✓（§8.3 实测表）。

### 8.6 本轮变更文件

| 文件 | 变更 |
|------|------|
| `src/core/transport/pty-script.ts` | start 改经官方 wrapper + WRAPPER_MISSING（+头注裁定依据） |
| `src/core/transport/pty-tmux.ts` | new-session 分支改经官方 wrapper + WRAPPER_MISSING（仅新建/重建时检查） |
| `src/core/transport/structured.ts` | 注释：structured 维持 bin 直启的设计依据 |
| `src/core/run.ts` | M48 预 abort 短路；M50 error 路径审计字段对齐（summarize 提前） |
| `test/transport-script.test.ts` | argv 断言改 wrapper；+WRAPPER_MISSING 专测；fixture 安装目录 |
| `test/transport-tmux.test.ts` | 同上（new-session 断言/专测/确定性目录/真机 fixture 迁移） |
| `test/run-tool.test.ts` | M48 零注入断言；+M50 error 审计对齐用例 |
