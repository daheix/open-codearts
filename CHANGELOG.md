# 更新日志

本文件记录面向使用者的重要变更。格式参考[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)。

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
