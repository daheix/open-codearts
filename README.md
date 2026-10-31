# codearts-bridge

**把华为云 CodeArts CLI（码道）变成 opencode 里可监督、永不挂起的智能体。**

opencode V2 插件（薄壳）+ 核心库 + 守护进程：为 CodeArts CLI 提供安装管家、
双传输（structured / PTY）、目标引擎（断点续跑 + 无限重试）与健康治理。

- 插件形态：opencode V2（`Plugin.define`；2.1.4 / 2.2.5 实测通过）
- 语言/运行时：TypeScript（Bun ≥1.4 开发与测试；插件随 opencode 服务运行）
- 外部依赖：仅 `@opencode/plugin`（其余全为 node: 内建）

---

## 特性

- **12 个 `codearts_*` 工具**：安装管家（status/repair/upgrade）、健康与治理（health/hygiene）、
  单回合执行（run）、目标五件套（goal_start/status/list/logs/control）、守护观测（daemon_status）。
- **安装管家**：版本钉定 + 哈希校验 + 备份自愈；受控升级（下载→校验→同数据集暂存→copy 原子部署→
  复验→旧版转备份），**任何一步失败零损坏**——规避厂商升级"先改名后部署"的断链缺陷。
- **目标引擎（永不挂起）**：契约驱动（`[GOAL-PLAN]` / `[GOAL-STEP n/N]` / `[GOAL-DONE]` + 独立验收双过）；
  停滞 60s 自动续跑；模型/网络错误**无限重试**（60s 封顶，连续 ≥10 次告警不停止）；进程死自动重建断点续跑；
  守护/宿主重启对账恢复；暂停/恢复/停止即时生效。
- **三传输可切换**（显式选择、无静默降级）：
  - `structured`：`codearts run --format json` 回合制进程（需 AK/SK；**codearts 内核**内存每回合归零——回合=独立进程；桥接侧会话缓冲有 512KB 封顶与丢弃计数）；
  - `pty`（tmux 优先）：可 attach 观看、跨守护重启存活（用 CLI 登录态）；
  - `pty`（script 兜底）：零依赖。
- **守护进程**：systemd user service（Restart=always）+ 每分钟 watchdog（连续 2 次无响应自动重启）。
- **全程审计**：状态/动作/恢复/失败逐条 jsonl 留痕（`~/.codearts-bridge/audit/`）。
- **测试**：463 项用例（单元/集成/故障注入矩阵），`bun test` 一键运行。

## 环境要求

| 项 | 说明 |
|---|---|
| opencode | ≥2.1（V2 插件 API；2.1.4 / 2.2.5 实测；2.2.5 起支持全局自动加载目录） |
| Bun | ≥1.4（安装依赖与运行测试；插件随 opencode 服务运行） |
| CodeArts CLI | 已安装（26.10.x 实测）且 TUI 已登录（`auth.json` 有登录态），或已配置 AK/SK |
| 可选 | tmux（PTY 首选宿主；未装则自动用 script 兜底语义）、systemd 用户实例（守护/watchdog） |

## 安装

```bash
git clone https://github.com/daheix/open-codearts.git
cd open-codearts
bun install
```

### 方式一：全局自动加载目录（推荐，opencode ≥2.2.5 实测生效）

```bash
mkdir -p ~/.config/opencode/plugins
cat > ~/.config/opencode/plugins/codearts-bridge.ts <<'EOF'
export { default } from "/绝对路径/open-codearts/index.ts";
EOF
```

写入后无需改配置、无需重启——运行中的 opencode 服务约 0.25s 内热加载
（2.2.5 实测；日志出现 `msg="loading plugin" id=…/codearts-bridge.ts`），
对所有项目生效。指向稳定检出的绝对路径，**不要指向临时目录**。

### 方式二：配置文件 `plugin` 键

在 opencode 配置（项目级 `opencode.json` 或全局 `~/.config/opencode/opencode.jsonc`）中加入插件：

```jsonc
{
  "plugin": [
    "/绝对路径/open-codearts"   // 目录形态加载（2.1.4 实测：须为目录 + 根 index.ts）
  ]
}
```

> **加载形态实测**（2.1.4 与 2.2.5 结论不同，详见[加载方式（实测）](#加载方式实测)）：
> 2.1.4 要求绝对目录 + 根目录实体 `index.ts`（`exports` 不被采用；相对路径被静默跳过；
> 文件路径被拒）。2.2.5 下 `exports` 被采用，且全局配置 `plugin` 键经重启后加载。

重启 opencode 服务（2.1.4 的全局配置键不参与热重载；项目级键可热重载）后，
会话中即出现 `codearts_*` 工具。

## 工具速查

| 工具 | 权限 | 说明 |
|---|---|---|
| `codearts_status` | 无 | 安装/凭据/传输/守护/健康一屏总览 |
| `codearts_repair` | manage | 从有效备份原子自愈（校验→部署→复验→审计）；可选修正 autoupdate |
| `codearts_upgrade` | manage | 受控升级（失败零损坏） |
| `codearts_health` | 无 | 内核 RSS、DB/WAL、堆转储、日志、最近错误 |
| `codearts_hygiene` | manage(apply) | 堆转储清理 / WAL checkpoint / 日志轮转（dry-run 清单=执行清单） |
| `codearts_run` | 无 | 单回合执行（自动选传输；进度流式；可取消；可超时） |
| `codearts_goal_start` | 无 | 启动受监督目标（契约注入→停滞续跑→双过验收） |
| `codearts_goal_status` / `codearts_goal_list` / `codearts_goal_logs` | 无 | 目标观测 |
| `codearts_goal_control` | 无 | pause / resume / stop |
| `codearts_daemon_status` | 无 | 守护健康与启动指引 |

## 快速上手

```
codearts_status
  → 确认 CLI 在场、版本、备份有效、autoupdate=false
codearts_run { "prompt": "只回复两个字：你好" }
  → 单回合执行（AK/SK 就绪走 structured；否则 PTY 登录态）
codearts_goal_start { "objective": "把 xxx 修到测试全绿", "verify": ["bun test"] }
  → 启动受监督目标：停滞自动续跑、断网自动等待恢复、完成双过验收
```

## 守护进程（目标引擎宿主）

目标监督循环运行在独立守护中（opencode 重启不影响在跑目标）：

```bash
codearts-bridge service install    # 生成 systemd user 单元 + watchdog 定时器
codearts-bridge daemon             # 或前台运行（开发）
systemctl --user status codearts-bridge
```

watchdog 每分钟探测 `/health`（15s 超时），连续 2 次无响应自动重启——与 dsh-web 同款自愈模式。

## 配置参考

opencode.jsonc 插件对象形 options：

| 键 | 默认 | 说明 |
|---|---|---|
| `installDir` | `~/.codeartsdoer/installers` | codearts CLI 安装根 |
| `stateDir` | `~/.codearts-bridge` | 状态/审计/健康/日志根 |
| `transport` | `auto` | `auto` / `structured` / `pty` |
| `ptyHost` | `auto` | `tmux` / `script` |
| `daemonUrl` | `http://127.0.0.1:4577` | 守护地址 |
| `akskFile` | `<stateDir>/config.env` | AK/SK 凭据文件（0600） |
| `autoNudge` | `true` | 目标停滞自动续跑（false=显式退出） |

`config.env` 格式（`CODEARTS_CLI_AK` / `CODEARTS_CLI_SK`，KEY=VALUE 行）。
AK/SK 申请：https://codearts.huaweicloud.com/portal/settings/cli-auth

## 架构一览

```
opencode（插件：codearts_* 工具，进度/取消/权限门）
   │ ①进程内直调（安装管家/健康）  ②127.0.0.1 HTTP（目标引擎）
codearts-bridge 守护（systemd + watchdog）
   │ 传输层（显式选择）
structured（run --format json 回合制）  │  pty（tmux / script 托管 TUI）
   └──────────── CodeArts CLI ─────────────┘
```

模块：`src/server.ts`（插件装配）· `src/goal-tools.ts`（目标工具代理+回呼）·
`src/core/{install,health,upgrade}.ts`（安装管家/健康/受控升级）·
`src/core/transport/*`（三传输）· `src/core/goal/{protocol,runner,state}.ts`（协议/状态机/持久化）·
`src/{daemon,daemon-goals}.ts`（守护与目标宿主）· `src/cli.ts`（CLI）。

## 已知限制与实测注意

- **AK/SK 未配置**时 `structured` 传输显式 `AKSK_MISSING`（不静默转 PTY）；PTY 路径用 CLI 登录态即可用。
- opencode **2.1.4** 目录加载要求：绝对目录路径 + 根 `index.ts` 实体入口（`exports` 不被采用；
  相对路径走 npm 解析被静默跳过；文件路径被拒）。2.2.5 起 `exports` 被采用，
  全局自动加载目录生效。详见[加载方式（实测）](#加载方式实测)。
- 2.1.4 服务端无工具清单 HTTP 端点（2.2.5 有 `/api/plugin`）——工具可见性以会话内实测为准。
- TUI 存在交互式自升级对话框（`OPENCODE_CHANNEL=latest`）：停滞重试保障最终递达（实测第 5 轮递达）；TUI-ready 门为路线图增强。
- 华为云升级流程存在"先改名后部署 + 跨数据集 rename"缺陷（本管家已规避并可自愈）。

## 故障排查

### 守护未启动（`DAEMON_UNAVAILABLE`）

- **现象**：`codearts_goal_*` / `codearts_daemon_status` 返回
  `DAEMON_UNAVAILABLE`（含启动指引）；单回合 `codearts_run` 不受影响（进程内直调）。
- **诊断**：`systemctl --user status codearts-bridge`；或看 `codearts_daemon_status`
  输出（免鉴权 `/health` 透传）。
- **处置**：`codearts-bridge service install` 安装并拉起 systemd 用户单元；
  开发场景可前台 `codearts-bridge daemon`。插件**不会自动拉起守护**（显式报错不静默兜底）。

### PTY 宿主缺失（`PTY_HOST_UNAVAILABLE`）

- **现象**：传输创建报 `PTY_HOST_UNAVAILABLE`，remediation 提示装 tmux 或改用 script。
- **诊断**：`tmux -V` 是否可用；插件配置 `ptyHost` 当前值。
- **处置**：安装 tmux（PTY 首选宿主），或在 opencode 配置的插件 options 里显式
  `"ptyHost": "script"`（零依赖，每次注入经 `script(1)` 伪终端）。无静默切换——
  选择结果与原因总在返回中。

### 升级失败恢复（零损坏）

- **设计保证**：升级全程"下载→校验→同数据集暂存→copy 原子部署→复验"，任何一步失败
  自动回滚并审计 `upgrade.fail`；回滚再失败则**保留暂存快照**（审计含快照路径）。
- **现象**：`codearts_upgrade` 返回结构化错误码（如 `HASH_MISMATCH`、
  `VERIFY_FAILED`），bin 保持旧版可用。
- **处置**：按 remediation 逐条执行；bin 已损坏时 `codearts_repair` 从
  `bin/codearts.bak-<版本>` 备份原子自愈（自动扫描任一有效备份）；
  备份也缺失时错误码 `BIN_MISSING_NO_BACKUP`，按指引官方重装。
- **审计**：全部动作留痕 `~/.codearts-bridge/audit/install.jsonl`（含 before/after 与所用备份文件）。

### AK/SK 配置（`AKSK_MISSING`）

- **现象**：`structured` 传输/`auto` 选择时报 `AKSK_MISSING`（显式报错，不静默转 PTY）。
- **申请**：https://codearts.huaweicloud.com/portal/settings/cli-auth
- **配置**：写 `<stateDir>/config.env`（默认 `~/.codearts-bridge/config.env`，权限 0600）：

  ```sh
  CODEARTS_CLI_AK=你的访问键
  CODEARTS_CLI_SK=你的秘密键
  ```

- **验证**：`codearts_status` 的 AK-SK 字段变为已配置；`codearts_run` 结果中
  `mode=structured`。未配置时 PTY 路径仍可用（走 CLI 登录态）。

## 加载方式（实测）

> 实测环境：opencode **2.1.4** 与 **2.2.5** 后台服务；方法：热重载观察 + 日志取证
> （`~/.local/share/opencode/log/opencode.log`）、`opencode plugin list`、
> 服务端 `GET /api/plugin`，全程未重启服务。

| 项 | 2.1.4 | 2.2.5 |
|---|---|---|
| 全局自动加载目录 `~/.config/opencode/plugins/*.ts` | 未验证 | **实测生效**：写入 `.ts` 入口后约 0.25s 热加载，watcher 跟踪完整依赖图，无需改配置/重启 |
| 配置键名 | 项目级 `opencode.json` 用 **`plugin`**（单数）；**全局配置两键均不参与热重载**（需重启服务） | 同左（项目级键可热重载；全局 `plugin`/`plugins` 键热重载不加载，重启后加载） |
| 路径形态 | **绝对目录路径**。⚠ 文件路径被拒（`configured plugin path must be a directory`）；相对路径走 npm 包解析，未安装目录被**静默跳过** | 同左 |
| 入口解析 | 目录下实体 **`index.ts`**（`package.json` 的 `exports` 不被采用——本包根目录提供 `index.ts` 再导出 `src/server.ts`） | **`exports` 被采用**（`entrypoint=file:///…/src/server.ts`）；根 `index.ts` 兼容入口保留 |
| 依赖解析 | 沿插件目录树就近解析（`@opencode/plugin` 从本包 `node_modules/` 正常加载） | 同左 |
| 加载证据 | `msg="loading plugin" id=… entrypoint=file:///…/index.ts`（config.updated 后约 1.3s 生效） | 同左；另可用 `opencode plugin list` 与 `GET /api/plugin`（`status: "active"`）核查 |
| 工具清单 | 服务端无工具列表端点（`/api/tool*` 均 404）——以会话内实测为准 | `/api/plugin` 可用；工具面以会话内实测为准 |

> **双实例提示**：若同一项目既配了项目级 `plugin` 键又在全局自动加载目录放了入口，
> 该项目会话会加载两个插件实例（`opencode plugin list` 可见两行）。工具名重复注册
> 行为未系统实测——建议二选一：日常用全局自动加载目录，开发调试才用项目级键。

## 开发

```bash
bun install
bun test            # 463 项用例（单元/集成/故障注入矩阵）
bun run typecheck   # tsc --noEmit
```

- 目录结构：`src/server.ts`（插件装配）· `src/core/*`（领域模块）· `src/core/transport/*`（传输）·
  `src/core/goal/*`（协议/状态机/持久化）· `src/{daemon,daemon-goals}.ts`（守护）· `src/cli.ts`。
- 设计要点：runner 纯 tick（时间注入）· 审计 jsonl 追加 · 原子写（同目录 tmp+rename+fsync）·
  部署仅 copy（禁跨文件系统 rename）· 一切失败显式 BridgeError（禁静默兜底）。

## License

[MIT](LICENSE)
