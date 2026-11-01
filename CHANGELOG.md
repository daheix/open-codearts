# 更新日志

本文件记录面向使用者的重要变更。格式参考[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

## [0.4.1] - 2026-11-02

生产运维热修回仓 + 守护会话只读画面（dsh-codearts 侧栏集成）。
`bun test` 571 项全绿（25 文件，两轮复跑一致）。

### 新增

- **守护会话只读画面**：`GET /tuis`（在册目标会话清单）+ `GET /tui/view?ref=`
  （当前屏幕网格行帧）。守护内嵌 `@xterm/headless` 屏幕状态机持续消化 PTY 输出
  ——码道 TUI 为增量重绘，rawBuf 512KB 尾截断下重放 raw 无法重建画面，网格状态
  是唯一正确观测面。只读语义：无任何注入/停止通道，目标驱动权保持在监督循环。
- 守护重启自愈：reconcile 重建会话（全新 rawBuf 含启动整屏帧），网格随新缓冲
  重建即正确。

### 修复（生产运维热修，2026-11-01 实证）

- **停滞阈值 60s→240s**：进度检测按协议行判定，编译/测试等长静默相位被误判
  stall 并反复注入打断；240s 给构建循环留整周期，协议行出现即重置计时。
- **回显守卫 3s→45s**：TUI 冷启动含 403 重试/keyring/自升级下载 30s+，原窗口
  内回显尚未到达、注入文本被误认申报。
- **[GOAL-DONE] 行级精确匹配**：契约/验收失败注入文本自身含该字样，全文子串
  命中把回显当申报（PTY 折行破坏剥离指纹后必误判）；改为独立成行（trim 全等）
  才置 done。
- **续跑会话重申契约全文**：重建/续跑会话原只收 33 字短文本，模型只能翻
  .goal_state.json 找上下文；现重申目标全文与验收命令，任何续跑会话自包含。
- **升级包补执行位**：26.10.13 官方包内二进制无 +x 位，解压后 chmod 0755；
  版本探测走官方入口 wrapper 优先（agentkernel 直探因缺 wrapper 环境失败）。
## [0.3.0-dev] - 2026-10-31

首个公开发布的开发版：opencode 插件 + 核心库 + 守护进程全量交付，
`bun test` 463 项用例全绿（462 pass + 1 项 tmux 真机条件跳过）。

### 新增

**安装管家（M1）**——让 CLI 安装/升级不再"断链"

- `codearts_status`：安装版本、钉定状态、备份有效性、autoupdate 开关、
  AK/SK 凭据、数据库/日志体量一屏总览。
- `codearts_repair`：从有效备份原子自愈（校验→部署→复验→审计），
  支持清理 `.delete` 残局；bin 健康时返回 already-healthy。
- `codearts_upgrade`：受控升级——下载→哈希校验→同数据集暂存→copy 原子部署→
  复验→旧版转备份，**任何一步失败零损坏**（失败自动回滚并保留快照）。
- `codearts_health`：内核 RSS、DB/WAL 字节、堆转储计数、最近错误（去重 ≤20 条）。
- `codearts_hygiene`：堆转储清理 / WAL checkpoint / 日志轮转；dry-run 清单=执行清单。

**传输与单回合执行（M2）**

- `codearts_run`：单回合执行，自动选传输——已配置 AK/SK 走 `structured`
  （`codearts run --format json` 回合制进程），否则走 PTY（CLI 登录态）。
  选择结果与原因显式返回，**无静默降级**。
- 三种传输实现：`structured`（回合=进程，内存每回合归零）、
  `pty`+tmux（可 attach 观看、跨守护重启存活）、`pty`+script（零依赖兜底）。
- 超时即停止并返回结构化超时结果；进度流式上报；会话中途可取消。

**目标引擎与守护（M3）**——"永不挂起"的受监督长任务

- 目标五件套：`codearts_goal_start` / `goal_status` / `goal_list` / `goal_logs` /
  `goal_control`（pause / resume / stop）。
- 契约驱动监督：`[GOAL-PLAN]` / `[GOAL-STEP n/N]` / `[GOAL-DONE]` 标记 +
  独立验收命令**双过**才算完成；回显防护防自骗。
- 故障自愈：停滞 60s 自动续跑；模型/网络错误无限重试（60s 封顶、连续 ≥10 次告警
  但不停止）；回合进程死自动重建断点续跑；守护/宿主重启对账恢复（不双注入）。
- 守护进程：`codearts-bridge service install` 一键安装 systemd user 单元
  （Restart=always）+ 每分钟 watchdog（连续 2 次无响应自动重启）。
- 回呼通知：目标停滞/告警/终态尽力通知发起会话（失败仅审计，不阻塞目标）。

**插件接入（本版实测）**

- opencode **2.2.5**：全局自动加载目录 `~/.config/opencode/plugins/*.ts`
  实测生效——新建入口文件后约 0.25s 热加载，无需改配置、无需重启服务；
  `package.json` 的 `exports` 被采用（入口可为 `src/server.ts`）。
- opencode **2.1.4**：项目级 `plugin`（单数）键 + 绝对目录路径 + 根 `index.ts`。

### 已知限制

- AK/SK 未配置时 `structured` 传输显式 `AKSK_MISSING`（不静默转 PTY）。
- opencode 2.1.4 全局配置键不参与热重载加载（用自动加载目录替代）。
- TUI 存在交互式自升级对话框，监督引擎带 TUI-ready 门后再注入。
- 华为云官方升级流程存在"先改名后部署 + 跨数据集 rename"缺陷（本管家已规避并可自愈）。

[0.3.0-dev]: https://github.com/daheix/open-codearts/releases

### 修复（真机验收回归，2026-10-31）

- alive() 改布尔契约（未知/死会话返回 false，不再抛错致守护永久下线）
- 死会话重启风暴修复（start 重建自检，不再回传死 ref）
- PTY 注入多行安全（契约可整块送达 TUI；两段式提交保留）
- 生产 verifyRun 接线（目标验收命令可执行）
- 死会话 resume 自动重建
- 会话 raw 缓冲 512KB 封顶（尾滚动+丢弃计数）
