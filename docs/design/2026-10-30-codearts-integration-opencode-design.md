# codearts-bridge — opencode 集成方案设计文档

**版本**: v1.0（待评审）
**日期**: 2026-10-30
**状态**: 评审稿 —— 待用户 Review 后转为实施基线
**关联**:
- 前序止损操作日志：`操作记录/codearts工作台启动故障与升级失败修复-2026-10-30-操作日志记录.md`
- 后续独立项目 B（dsh 完整集成）：本方案**落地并验收完成后**另行立项设计，见 §3

---

## 目录

1. 背景与问题定义
2. 目标与非目标
3. 项目关系与顺序（A/B 独立方案）
4. 关键事实与硬约束（证据台账）
5. 总体架构
6. 组件设计
7. 接口契约
8. 错误处理、恢复策略与审计原则
9. 测试策略（TDD）
10. 里程碑、任务卡与落地定义
11. 风险与开放决策
12. 附录 A：证据来源清单

---

## 1. 背景与问题定义

### 1.1 原始三大痛点（用户报障）

| # | 痛点 | 现象 |
|---|---|---|
| ① | 启动/升级损坏 | 桌面快捷方式"无法启动"；根因：CLI 升级"先改名（`codearts → codearts.delete`）后部署"，部署跨 ZFS 数据集失败被**静默**吞掉，留下"无 CLI"残局（10-24、10-29 两次） |
| ② | 内存持续增长 | codearts 内核曾堆至 3–8GB（`cli-data/log/dump-*.heapsnapshot` 物证）；`opencode.db` 1.1GB + WAL 89MB；工作台侧另有终端缓冲放大 |
| ③ | 目标断连不续跑 | /goal 任务中断（模型断连/网络断/进程死）后没有持续等待恢复、自动续跑；codeartsGUI 依赖"抓 TUI 屏幕文本"，被 TUI 版本变更反复打穿（CHANGELOG 5 次修复记录） |

### 1.2 已止损现状（2026-10-30）

- CLI 已恢复 26.10.9（含 `codearts.bak-26.10.9` 备份），桌面两个快捷方式可用；
- `autoupdate: false` 已写入 `~/.codeartsdoer/codearts_cli.json` 且经内核重写验证保持；
- 手工修复动作已留档（见关联操作日志）。

**本设计要解决的**：把上述"手工止损"升级为**制度化、永久可运行**的集成方案——在 opencode 平台内驱动 codearts CLI，目标永不挂起、内存可治理、升级零损坏。

---

## 2. 目标与非目标

### 2.1 目标（硬性要求，四条）

1. **可启动**：任何时刻 CLI 可用；升级/断网故障不再产生"可执行文件丢失"式损坏；损坏可一键自愈且全程审计。
2. **永不挂起**：目标/任务中断（模型断连、网络断、进程死、宿主重启）→ 持续等待恢复、自动续跑，直至完成或人工停止。
3. **内存可控**：进程 RSS、DB/WAL、日志/转储占用可观测；有显式治理手段；结构化模式下内存不随轮次增长。
4. **可观测可操作**：状态/进度/暂停/恢复/停止统一由 opencode 工具面呈现；全程审计可追溯。

### 2.2 非目标（本期明确不做）

- 不修改华为 codearts 内核/Delphi 资产；不追 26.10.13 升级（工作台及既有验证均基于 26.10.9）。
- 不做 dsh 平台集成（独立项目 B，见 §3）。
- 不做 opencode GUI/TUI 部件（P3 可选增强，不在本基线）。
- 不做 codearts 会话内容到 opencode 会话的镜像/代理（仅状态回呼，见 §6.3.6）。

---

## 3. 项目关系与顺序（A/B 独立方案）

| 项目 | 内容 | 独立性 | 顺序 |
|---|---|---|---|
| **A（本文档）** | opencode 集成：`codearts-bridge` 插件 + 守护 + 目标引擎 | 自包含：不依赖 B；单独可部署、可验收 | **先行**，全部落地后启动 B |
| **B（后续立项）** | dsh 平台 codearts CLI 完整集成（cordis 插件、goal 模块联动、Web UI 面板、watchdog） | 自包含：不依赖 A；按 dsh 插件规范独立实现 | A 落地验收后启动 |

**独立性约束（用户裁决 2026-10-30）**：
- A、B 互不依赖，任何一方不得把另一方作为运行前提；
- 方法、协议、经验可以移植复用（如目标协议、安装管家流程），但**不做跨方案的共享包硬耦合**；
- B 启动时单独产出其设计文档与验收判据。

---

## 4. 关键事实与硬约束（证据台账）

| # | 事实 | 证据 | 对设计的影响 |
|---|---|---|---|
| F1 | codearts CLI 集成面：TUI（交互登录）/ `serve`（无头服务器）/ `run --format json`（程序化、`--session` 续接）/ `attach <url>`；**`acp` 命令不存在** | `codearts --help`、`codearts serve/run/attach --help`；`echo '' \| ./codearts acp` → "The 'acp' command is not supported." | 结构化集成主路径 = serve + run；ACP 路线否决 |
| F2 | **无头命令（serve/run/upgrade）强制要求 `CODEARTS_CLI_AK/SK`**；TUI 走 `cli-data/auth.json`（inferhub-provider OAuth）不受拦 | 26.10.9 与 26.10.13 双版本实测输出："认证失败，没有设置环境变量CODEARTS_CLI_AK/CODEARTS_CLI_SK"；配置入口 https://codearts.huaweicloud.com/portal/settings/cli-auth | structured 传输前置 AK/SK；未配置时 PTY 传输先行（可立即用） |
| F3 | 升级流程缺陷：下载→哈希→**改名旧二进制**→解压→**部署静默失败**；跨 ZFS 数据集（`/tmp` st_dev=29 vs `/home` st_dev=52）`rename(2)` 实测 `Errno 18 EXDEV` | `cli-data/log/kernel-…2026-10-29T234055…log` service=upgrade 全序列；现场 rename 探针 | 安装管家必须：copy 部署（绝不 rename）、失败零损坏、备份自愈 |
| F4 | 网络到华为云不稳：下载 ECONNRESET（20:22 实测）、OBS 主机 TLS 后 0 字节悬挂、接口间歇超时 | kernel 日志 `domain-switch.cb-status "CB network error detected: ECONNRESET"`；curl 诊断 | 下载/升级需重试与校验；监督需覆盖网络类错误 |
| F5 | 内核结构化日志可用作监督信号：`~/.codeartsdoer/cli-data/log/kernel-*.log`，逐行 `service=…` 字段（含 `service=om` 内存自报、`service=upgrade`、`service=proxy-fetch` 错误） | 日志实读 | 监督信号优先级：结构化事件流 > 内核日志 > 进程存活 >（PTY 模式）文本 |
| F6 | opencode V2 插件能力（实测文档） | https://opencode.ai/v2/docs/build/plugins/server | 见下 |
| F7 | 运行环境：opencode v2.1.4（桌面端为主战场）；bun 1.4.2 / node v24.21.0 可用；**tmux 未安装**；ZFS 双数据集；仓库已有 `plugins/ohm-shim` 本地插件先例 | 现场核查 | 依赖与测试工具选型；PTY 宿主二选一（tmux 优先/script 兜底） |

**F6 细则（opencode V2 插件，全部实测文档确认）**：
- `Plugin.define({ id, setup(ctx) })`；setup 可返回清理函数；插件运行于 opencode 常驻服务；
- 工具注册：`ctx.tool.transform(editor => editor.namespace({...}); editor.add({ name, description, input(JSON Schema), options, execute }))`；
- `execute(input, context)` 支持 `context.progress({ status })` 进度回报与 `context.signal`（随会话停止而取消）；
- 其他可用能力：`ctx.permission.assert`（敏感动作走权限门）、`ctx.session.synthetic`（向会话注入通知）、`ctx.storage`（插件级持久化）、`ctx.event.subscribe`（服务器事件流）、`ctx.command.transform`（注册命令）；
- 加载：`opencode.json(c)` 的 `plugins` 列表支持绝对路径/相对路径/对象形（带 `options`）；
- 插件生命周期随 opencode 服务；服务重启后 `setup` 重新执行 → **长循环必须放守护进程，插件侧需重连/对账**（见 §5）。

---

## 5. 总体架构

```
┌─ opencode（桌面端/CLI，主战场）──────────────────────────────┐
│  codearts-bridge 插件（server part，薄壳，随服务常驻）        │
│   ├─ 注册 codearts_* 工具（进度 context.progress、取消        │
│   │  context.signal、敏感操作 ctx.permission.assert）         │
│   ├─ P1 工具：进程内直调核心库（状态/修复/升级/健康/清理/run） │
│   └─ P2 工具：经本地 HTTP 调守护进程（目标启停观测）；         │
│      goal 终态回呼 ctx.session.synthetic                       │
└──────────────┬───────────────────────────────────────────────┘
               │ ①进程内直调（P1）   ②127.0.0.1 HTTP + token（P2）
┌──────────────▼───────────────────────────────────────────────┐
│  codearts-bridge 守护进程（P2；systemd user service +         │
│  每分钟 watchdog，仿 dsh-web 模式；另有前台开发模式）          │
│   目标监督循环 / 状态机 / 持久化 / 审计                        │
└──────────────┬───────────────────────────────────────────────┘
               │ 传输层（CodeartsTransport 接口；显式选择+报告）
┌──────────────▼──────────────────┬────────────────────────────┐
│ 结构化传输（structured）          │ PTY 传输（pty）             │
│ codearts run --format json       │ TUI 托管：tmux（优先）/     │
│ 回合制独立进程；--session 续接    │ script(1)（兜底）          │
│ 前置：AK/SK                       │ 前置：无（用现有登录态）    │
│ 内存：每回合归零                  │ 内存：靠周期软重启+监控     │
└──────────────────────────────────┴────────────────────────────┘
```

**组件职责与代码布局（单包，仓库内）**：

```
plugins/codearts-bridge/
├── package.json            # name: codearts-bridge；exports: server 入口；bin: codearts-bridge（CLI）
├── src/
│   ├── server.ts           # opencode 插件入口（Plugin.define + 工具注册，薄）
│   ├── core/
│   │   ├── config.ts       # 配置解析（opencode options + 本地文件）+ 状态根 ~/.codearts-bridge
│   │   ├── install.ts      # 安装管家（钉版/备份/自愈/受控升级/autoupdate 防护）
│   │   ├── transport/
│   │   │   ├── types.ts    # CodeartsTransport 接口
│   │   │   ├── structured.ts
│   │   │   └── pty.ts
│   │   ├── goal/
│   │   │   ├── protocol.ts # 完成协议移植（codeartsGUI v0.2.x 语义）
│   │   │   ├── runner.ts   # 目标监督状态机
│   │   │   ├── state.ts    # 持久化
│   │   │   └── audit.ts    # 审计 jsonl
│   │   └── health/
│   │       ├── monitor.ts  # RSS/DB/WAL/日志/转储 采样
│   │       └── hygiene.ts  # 显式清理/检查点（dry-run 与执行一致）
│   ├── daemon.ts           # 守护进程（HTTP API + 监督循环宿主 + 恢复对账）
│   └── cli.ts              # codearts-bridge CLI（status/goal/service/upgrade/daemon）
├── test/                   # bun test：单元 + 集成 + fixtures（fake-codearts）
└── README.md
```

**状态根**：`~/.codearts-bridge/`（`state/goals/*.json`、`audit/*.jsonl`、`health/health.jsonl`、`logs/`、`config.env`、`daemon-token`）。

---

## 6. 组件设计

### 6.1 安装管家（install.ts）

**状态数据模型**（`status` 工具与守护共用）：
`{ binPath, present, version, sha256, backupPath, backupValid, autoupdateFlag, autoupdateGuardOk, akskConfigured, lastAuditId }`

**功能**：
1. **钉版**：记录期望版本与哈希（默认 26.10.9 + 当前实测哈希 `6d3e663b…` 并随修复更新）；版本漂移即报告。
2. **备份维护**：`codearts.bak-<version>` 缺失/失效 → 从当前有效二进制复制补齐（copy，不 rename）。
3. **自愈（显式动作 + 审计）**：
   - `bin/codearts` 缺失但备份有效 → copy 恢复 → 校验哈希与 `--version` → 审计；
   - 备份也无效 → **明确报错**（含修复指引与官方入口），绝不静默、绝不联网乱下。
4. **受控升级（显式动作 + 权限门 + 审计）**：
   ```
   ①查版（ide.cn-north-4.myhuaweicloud.com/v1/release-info/latest）
   ②下载至同数据集暂存区（~/.codearts-bridge/tmp/，避免 /tmp 跨数据集）
   ③哈希校验（官方 hash 字段）
   ④解压 → 版本自检（新二进制 --version）
   ⑤copy 部署到 installers/bin/codearts + 脚本 deploy（绝不 rename）
   ⑥收尾验证（--version + 哈希）→ 旧版转存为 bak-<old ver>
   ⑦审计（下载源/哈希/版本/耗时/结果）
   ⑧任一步失败：现场保持原状（旧版仍在原位），临时件清理，审计失败原因
   ```
   注：升级前需满足 F2（upgrade 无头命令需 AK/SK）或走手动包路径（本期仅设计，不默认启用自动升级）。
5. **autoupdate 防护**：轮询 `codearts_cli.json` 的 `autoupdate` 字段；若为 true → `codearts_status` 报警 + 审计（设计为只报告，不静默改用户文件；提供显式"修正"动作）。

### 6.2 传输层（transport/*）

**统一接口**（`types.ts`，示意）：
```ts
interface CodeartsTransport {
  kind: "structured" | "pty";
  start(session?: SessionRef): Promise<SessionRef>;
  inject(session: SessionRef, text: string): Promise<void>;   // 注入一轮输入（内部处理提交时序）
  observe(session: SessionRef, since?: Cursor): AsyncIterable<Signal>; // 结构化事件/日志/文本信号
  alive(session: SessionRef): Promise<boolean>;
  stop(session: SessionRef, opts?): Promise<void>;
  snapshot(session: SessionRef): Promise<{ raw: string; meta: object }>; // 供审计/调试
}
```

**structured（首选，AK/SK 就绪时启用）**：
- 每回合 = 一个独立 `codearts run "<指令>" --format json [--session <id>] [--attach <url>]` 进程；
- 回合进程退出即回合结束 → **内核内存每回合归零**（对痛点②的直接治理）；
- 事件解析：JSON 事件流 → 归一化 `Signal{type: output|tool|error|idle|done, ...}`；
- 会话续接：`--session`/`--continue`；新建会话首次输出中捕获 session id 并持久化；
- 错误模式库：`timeout / ECONNRESET / 429 / 503 / 认证失败` → 分级别（可重试/需人工）。

**pty（兜底，无需 AK/SK，用现有登录态）**：
- PTY 宿主抽象：`tmux`（优先：可 attach 观看、跨守护重启存活）或 `script(1)`（零依赖：守护重启则 TUI 随之重启并由"进程死→续跑"恢复）；
- 启动：`tmux new-session -d -s codearts-<slug> '<installers>/codearts'`（wrapper 提供环境）；
- 注入：`tmux send-keys`（沿用 v0.2.6 经验：文本与 Enter **两步提交**，规避"粘贴识别吞回车"）；
- 判活信号（优先级）：内核结构化日志增量（F5）> 进程存活 > 屏幕文本变化/转轮高频输出（v0.2.6 阈值）；
- 输出快照：`tmux capture-pane -p`（审计用）。

**选择与报告（无静默降级）**：
- 配置 `transport: "auto" | "structured" | "pty"`；auto 依据 `akskConfigured` 选择并**在 status 中明示当前模式与原因**；模式不可用时工具显式报错（附切换指引），不偷偷换模式。

### 6.3 目标引擎（goal/*）

#### 6.3.1 完成协议（移植自 codeartsGUI v0.2.x，语义不变）

从 `/home/wsc/codeartsGUI` 移植（带 22 个 goalrunner 用例语义）：
- 契约：`[GOAL-PLAN]`（计划）/`[GOAL-STEP n/N] … | 推荐方案: …`（步骤）/`[GOAL-DONE]`（完成申报）；
- 完成判定**双过**：AI 自报 + 独立验收命令（契约中定义）；
- `stripInjectionEcho` + 注入后回显守卫（kEchoGuardMs=3s）：防注入回显被误判为 AI 完成；
- 续跑指令：会话活着 → 轻量"继续完成剩余任务"；进程死 → 完整断点续跑契约；
- 推荐方案自动推进（检索后直接执行不停问）。

#### 6.3.2 监督状态机

```
      start()
        │
        ▼
   ┌─ active ──────────────────────────────────┐
   │   轮次推进（输出/步骤/事件）→ 刷新指纹      │
   │   停滞(60s无增量 且 无步骤推进) → nudge ───┘ （注入"继续完成剩余任务"）
   │   模型/网络错误 → 重试（首次立即，间隔60s封顶，次数无上限）
   │   进程死 → 重启会话（tmux 剩余存活则重连）→ 完整断点契约注入
   │   连续 nudge 无进展（strikes≥3）→ 升级告警（不停止，等人工/继续重试）
   │   完成申报+验收双过 → complete
   └─ paused（人工）──resume──▶ active（注入继续指令）
      blocked（策略阻塞：如验收连续失败）──人工 resume──▶ active
      complete/stopped（终态，审计落盘）
```

**策略参数表**（全部可配置、入审计）：

| 参数 | 默认 | 说明 |
|---|---|---|
| 停滞判定 | 60s 无增量且无 `[GOAL-STEP]` 推进 | 与 v0.2.6 一致；结构化模式用事件流，PTY 模式用日志+文本 |
| 错误重试 | 首次立即；间隔 60s 封顶；**次数无上限** | 用户原始要求"一直执行下去"；连续 ≥10 次黄条级告警（审计+回呼） |
| strikes | 3 | 重启/续跑后无进展循环保护；仅告警不终止 |
| 轮次上限 | 可配置（默认不限） | 审计计数 |
| 回显守卫 | 3s | 移植自 v0.2.6 |
| 快照间隔 | 5min 或里程碑 | `capture-pane`/事件摘要落审计 |

#### 6.3.3 持久化与审计

- `state/goals/<goalId>.json`：目标、契约、轮次、步骤、strikes、会话引用（tmux 名/会话 id）、状态、时间戳、上次注入指纹；
- `audit/<goalId>.jsonl`：逐事件追加（start/inject/retry/restart/resume/pause/stop/complete/verify/error），含时间、原因、动作、结果、证据引用（日志偏移/快照文件）；
- **宿主重启对账**：守护启动时扫描 state → 恢复未完成目标（tmux 存活则重连；否则重启会话+断点契约）。

#### 6.3.4 控制

`codearts_goal_control(id, action)`：`pause`（立即生效、保留进度）/`resume`（注入继续指令）/`stop`（终态）。语义对齐 dsh-goal-controls 的 pause/resume/stop（为项目 B 预留一致性）。

#### 6.3.5 守护进程（daemon.ts）

- 形态：`codearts-bridge daemon`（前台，开发/测试）与 systemd user service（生产；安装脚本 `codearts-bridge service install`；附每分钟 watchdog probe 仿 `bin/dsh-watchdog-probe.sh`）；
- HTTP API（127.0.0.1，token 文件鉴权 `~/.codearts-bridge/daemon-token` 0600，禁 shell 拼接）；
- API 面：`GET /health`、`GET /goals`、`POST /goals`、`GET /goals/:id`、`GET /goals/:id/logs`、`POST /goals/:id/control`、`GET /runs/:id`（run 会话留痕）。

#### 6.3.6 回呼

- 插件加载期间轮询守护（30s）或在工具调用时同步；目标终态/告警 → `ctx.session.synthetic` 注入发起会话（含 goalId 与摘要）；失败仅审计，不阻塞目标（标注为**尽力通知**，非投递保证）。

### 6.4 健康与内存治理（health/*）

- **采样**：托管进程与 codearts 内核 RSS（含解析 `service=om` 自报）、`cli-data/opencode.db` 与 WAL 大小、`log/` 与 `dump-*.heapsnapshot` 占用、最近错误计数（`service=proxy-fetch`/`service=upgrade` 摘要）；
- **治理（显式 + dry-run）**：
  - `hygiene wal-checkpoint`（低成本、可定时）；
  - `hygiene purge-dumps --older-than Nd`（默认 30 天；dry-run 与实际一致，审计删除清单）；
  - `hygiene rotate-logs`（保留策略可配）；
  - PTY 模式：可配"空闲软重启"（仅在两轮之间执行，注入断点契约后续跑）。
- 所有治理动作先在 `codearts_health`/`codearts_hygiene` 输出计划，执行需显式调用（破坏性动作走 `ctx.permission.assert`）。

### 6.5 opencode 插件层（server.ts）

- **工具清单**（namespace `codearts`）：

| 工具 | 阶段 | 语义要点 |
|---|---|---|
| `codearts_status` | P1 | 一屏全局：版本/备份/哈希/autoupdate 防护/AK-SK/传输模式/守护状态/健康摘要 |
| `codearts_repair` | P1 | 显式自愈；无备份→明确报错+指引 |
| `codearts_upgrade` | P1 | 受控升级；需权限门；失败零损坏 |
| `codearts_health` | P1 | 指标 + 最近错误摘要 |
| `codearts_hygiene` | P1 | 计划（dry-run）与执行；显式动作 |
| `codearts_run` | P1 | 单回合执行；`context.progress` 流式回报；`context.signal` 取消；结构化摘要返回 |
| `codearts_goal_start/status/list/logs` | P2 | 经守护；`start` 返回 goalId；`logs` 分页读审计/会话快照 |
| `codearts_goal_control` | P2 | pause/resume/stop |
| `codearts_daemon_status` | P2 | 守护健康；未安装→安装指引（不静默） |

- **权限**：`upgrade/repair/hygiene 执行` 走 `ctx.permission.assert`（action: `codearts.manage`，resource: `install|state`）；
- **配置**（opencode.jsonc 对象形 options）：`installDir`、`stateDir`、`transport`、`daemonUrl`、`aksk`（`env|file`，文件默认 `~/.codearts-bridge/config.env`）、`thresholds{…}`、`autoNudge` 等；
- **加载与落地**：全局 `~/.config/opencode/opencode.jsonc` 增加插件条目（绝对路径指向本仓库 `plugins/codearts-bridge`）；键名（`plugin`/`plugins`）与 `@opencode/plugin` 依赖解析以 opencode 2.1.4 实测为准（实现第一步验证性任务 T1-01）。

---

## 7. 接口契约

### 7.1 工具入参/出参（摘要，完整 Schema 在实现期随代码提交）

```jsonc
// codearts_status(): → { install: {...}, aksk: {...}, transport: "structured|pty", daemon: {...}, health: {...} }
// codearts_repair(confirm: boolean): → { action: "restore-from-backup", from, to, sha256, auditId } | { error, remediation }
// codearts_upgrade(version?: string, confirm: boolean): → { from, to, hash, auditId } | { failedAt, preserved: true, auditId }
// codearts_run(prompt: string, opts?: { session?: string, timeoutMs?: number }): → { session, summary, signals: n, auditId }
// codearts_goal_start(objective: string, opts?: { verify?: string[], workdir?: string, maxRounds?: number }): → { goalId }
// codearts_goal_control(goalId: string, action: "pause|resume|stop"): → { state, auditId }
```

### 7.2 守护 HTTP API

```
GET  /health                       → { ok, version, uptime, actives: n }
GET  /goals                        → [{ goalId, state, rounds, strikes, objective(≤120字) }]
POST /goals { objective, verify?, workdir?, maxRounds? } → { goalId }
GET  /goals/:id                    → 完整状态（含会话引用、最近指纹）
GET  /goals/:id/logs?cursor=…      → 审计分页
POST /goals/:id/control { action } → { state }
```
鉴权：`Authorization: Bearer <daemon-token>`（文件 0600）；绑定 127.0.0.1。

### 7.3 本地文件

- `~/.codearts-bridge/config.env`（0600）：`CODEARTS_CLI_AK=…`、`CODEARTS_CLI_SK=…`（插件在 spawn 时按需注入子进程 env，不依赖服务进程全局环境）；
- `daemon-token`（0600）；`state/`、`audit/`、`health/`、`logs/` 如上。

---

## 8. 错误处理、恢复策略与审计原则

**总原则**（对齐仓库铁律）：禁止任何形式的静默 fallback / 兜底掩盖；错误就地报告（结构化错误码/消息），恢复一律是**显式设计、带阈值、全程审计**的受控动作。

**恢复策略登记表**（设计即登记，逐条可审计）：

| 场景 | 动作 | 阈值/前置 | 失败行为 | 审计 |
|---|---|---|---|---|
| bin 缺失且备份有效 | 自愈恢复（copy） | 哈希+版本校验通过 | 明确报错+指引 | restore 事件 |
| 目标停滞 | 注入"继续完成剩余任务" | 60s 无增量且无步骤推进 | 记录；strikes≥3 升级告警 | nudge 事件 |
| 模型/网络错误 | 重试（不限次数） | 首次立即，60s 封顶 | 连续≥10 次黄色告警；不停止 | retry 事件 |
| 会话进程死 | 重启会话+断点契约 | 状态持久化存在 | 重试并审计 | restart 事件 |
| 守护/宿主重启 | 启动对账恢复未完成目标 | state 可读、tmux 存活则重连 | 报错并标记 blocked，等人工 | reconcile 事件 |
| autoupdate 被置 true | 报警（不改用户文件） | 轮询发现 | 提示显式修正动作 | guard 事件 |
| 传输模式不可用 | **显式报错**（附切换指引） | — | 不自动换模式 | error 事件 |

**审计事件清单**：`status/repair/restore/upgrade{start,step,fail,done}/run{start,exit,error}/goal{start,inject,retry,restart,resume,pause,stop,complete,verify,strike,reconcile}/hygiene{plan,apply}/guard`。

---

## 9. 测试策略（TDD）

- **单元**（`bun test`）：install（fake FS + fixture 二进制：健康/缺失/仅 .delete/哈希漂移）、protocol（22 用例移植）、runner（fake 传输 + 可控时钟）、health；
- **集成**：`test/fixtures/fake-codearts`（bash/node 脚本，模拟 `run --format json`：正常完成/停滞/错误码/中途崩溃/回显/[GOAL-DONE] 双过）；PTY 侧移植 `fake_tui.py` 行为（含两步提交与吞回车场景）；
- **故障注入矩阵**（每条都是验收用例）：
  1) 断网（注入 ECONNRESET/超时事件）→ 无限重试；2) 停 60s → 自动续跑；3) 杀回合进程 → 重启续跑；4) 杀守护 → systemd 拉起 + 对账续跑；5) opencode 服务重启 → 插件重连、目标不受影响；6) 回显误判防护；7) 双过验收（自报+命令）；8) 升级中断（模拟）→ 零损坏；
- **真机冒烟（人工，标注前置）**：AK/SK 就绪后 `codearts_run` 全链路；PTY 就绪后 30–60 分钟小目标 + "拔网 10 分钟"演练；
- **质量门**：`tsc --noEmit` 零错误；测试全绿；单文件行数沿用仓库纪律精神（≤1000 行，适用 TS）。

---

## 10. 里程碑、任务卡与落地定义

### 10.1 里程碑与任务（P0，实施计划将由 writing-plans 展开）

| 里程碑 | 内容 | 任务卡（草案） | 验收判据 |
|---|---|---|---|
| **M1 基础器** | 插件加载链验证、配置/状态根、安装管家全量、健康与清理工具 | T1-01 加载验证（opencode 2.1.4 实测加载 + 空工具可见）；T1-02 配置与状态根；T1-03 状态模型与探测；T1-04 备份+自愈；T1-05 受控升级（含失败零损坏测试）；T1-06 autoupdate 防护；T1-07 健康采样；T1-08 hygiene（dry-run 一致）；T1-09 工具注册+权限；T1-10 M1 测试与验收 | 造"只剩 .delete"→status 诊断+repair 恢复（哈希审计）；无备份→明确报错；升级演练跨数据集成功且中途失败零损坏；autoupdate 置 true→报警；全部单测绿 |
| **M2 传输与运行** | PTY 传输（tmux 优先 / `script(1)` 兜底，同一抽象的两个实现，先以 `script` 打通测试、tmux 视安装情况启用）、structured 传输（fake 全测；AK/SK 就绪后真机）、`codearts_run` | T2-01 传输接口+fake；T2-02 PTY 托管（启动/两步注入/读流/停止）；T2-03 structured 解析与错误模式；T2-04 run 工具（进度/取消/摘要） | fake 场景全过；PTY 真机可注入一轮并观测；structured 对 fake 全场景正确 |
| **M3 目标引擎** | 守护进程、协议移植、监督状态机、持久化审计、控制、回呼、systemd | T3-01 守护骨架+API+token；T3-02 协议移植（22 用例）；T3-03 监督状态机；T3-04 持久化+对账；T3-05 控制+goal 工具；T3-06 回呼；T3-07 systemd+watchdog；T3-08 故障矩阵全量 | 中断矩阵（模型错误/断网/杀进程/杀守护/opencode 重启）全部自动续跑至完成；pause/resume/stop 即时；审计完整；structured 内存不随轮次增长 |
| **M4 落地** | 全局配置接入、README/使用手册、真机验收、操作记录 | T4-01 全局 opencode.jsonc 接入与文档；T4-02 真机验收（小目标全流程 + 拔网演练）；T4-03 操作记录+经验沉淀 | 用户机器上：插件加载、工具可用、真机目标跑通、"拔网 10 分钟"恢复；文档齐备；操作记录归档 |

估算（仅供参考，随故障矩阵规模浮动）：M1 ≈2–3 人日，M2 ≈3–5，M3 ≈5–8，M4 ≈1–2。

### 10.2 "落地"定义（本方案 A 的完成线）

1. 插件已配置到用户 opencode（全局），`codearts_*` 工具在真实会话可见可用；
2. 真机完成至少一次"目标全流程"（含中断恢复演练）并留证；
3. 守护进程随系统自启、watchdog 生效；状态/审计文件就位；
4. README/使用说明与操作记录归档；测试套件与 `tsc` 全绿。

---

## 11. 风险与开放决策

| # | 事项 | 默认决策（可改） | 影响 |
|---|---|---|---|
| R1 | **AK/SK 配置**（structured 前置） | 未配置时以 PTY 为主模式先行落地；AK/SK 配置后启用 structured 并做一次性真机验证 | 仅影响 transport 选型，不影响里程碑结构 |
| R2 | tmux 安装（PTY 宿主首选） | 优先 tmux（可 attach、跨重启存活）；未安装时用 `script(1)` 兜底（行为一致：崩溃→重启+续跑） | 体验差异（观看/存活），状态中明示 |
| R3 | systemd 用户服务（P2 守护） | 接受（沿用 dsh-web 模式，含 watchdog）；另提供前台模式 | 无 → 目标循环改随 opencode 服务，抗重启能力下降（不推荐） |
| R4 | 华为云侧接口/下载稳定性 | 重试+校验+审计兜底；升级仅显式动作 | 升级链路可能偶发失败（零损坏保证不变） |
| R5 | codearts CLI 未来版本变更 | 结构化接口解耦优先；协议/信号以测试锁定 | 升级前跑全量回归 |

---

## 12. 附录 A：证据来源清单（2026-10-30 实测）

- 升级损坏全序列：`~/.codeartsdoer/cli-data/log/kernel-codeartsdoer-incognito-2026-10-29T234055-3098810-0.log`（`service=upgrade`）
- ECONNRESET：`~/.codeartsdoer/cli-data/log/kernel-…2026-10-30T202015-3896807-0.log`
- 认证门控：`codearts serve/run` 与 26.10.13（`/tmp/agentkernel`）实测输出（"认证失败…CODEARTS_CLI_AK/CODEARTS_CLI_SK"）
- 跨数据集 rename：现场探针 `OSError [Errno 18] Invalid cross-device link`（/tmp st_dev=29、/home st_dev=52）
- opencode 插件能力：https://opencode.ai/v2/docs/build/plugins 与 /build/plugins/server
- 本地插件先例：`plugins/ohm-shim`；opencode v2.1.4；bun 1.4.2；node v24.21.0
- 既有语义资产：`/home/wsc/codeartsGUI`（GoalProtocol、goalrunner 22 用例、fake_tui.py、e2e_harness）

---

*本文档为项目 A 的实施基线（评审通过后生效）。项目 B（dsh 完整集成）将在本方案落地验收后另行立项，遵守 §3 独立性约束。*
