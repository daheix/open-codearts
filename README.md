# codearts-bridge

opencode V2 插件（薄壳）+ 核心库 + 守护进程：为 CodeArts CLI 提供安装管家、
双传输（structured/PTY）、目标引擎与健康治理能力。

- 设计文档：`docs/superpowers/specs/2026-10-30-codearts-integration-opencode-design.md`
- 当前阶段：M1+M2+M3 全部完成（463 计数测试全绿）；**使用文档（安装/AK-SK/工具速查/
  故障排查/CHANGELOG）以公开仓库为准**：https://github.com/daheix/open-codearts
  （稳定检出 `/home/wsc/wsc/open-codearts`）。本 README 定位为开发文档。

## 目录结构

```
plugins/codearts-bridge/
├── install.sh          # 安装引导（幂等；接线/守护/质量门/体检）
├── uninstall.sh        # 卸载引导（转调 codearts-bridge uninstall）
├── package.json        # name: codearts-bridge；exports["."/"./server"] → src/server.ts
├── tsconfig.json       # strict + moduleResolution bundler + bun-types
├── index.ts            # 目录加载兼容入口（见下"加载方式（实测）"）
├── plugin/index.ts     # 裸目录 shim（备用入口，实测注释）
├── src/
│   ├── server.ts       # opencode 插件入口：Plugin.define + codearts_status 冒烟工具
│   ├── cli.ts          # CLI：daemon/service/doctor/self-upgrade/upgrade-cli/uninstall
│   └── core/           # config/install/upgrade/doctor/selfupgrade/uninstaller/service/
│                       # health/fsx/run/transport/goal（核心库）
└── test/               # bun:test 全量用例（含 install.sh 沙箱 HOME 集成）
```

## 常用命令

```bash
bun install          # 安装依赖（@opencode/plugin 2.2.3 钉版）
bun test             # 单元测试
bun run typecheck    # tsc --noEmit
```

## 给别人安装（三行）

```bash
git clone https://github.com/daheix/open-codearts && cd open-codearts
bash install.sh                 # 缺 bun 自动装；接线 opencode；默认装 systemd 守护；跑质量门
codearts-bridge doctor          # 体检（等价：bun src/cli.ts doctor）
```

- `install.sh` 幂等可重跑；常用参数：`--no-daemon`（跳过 systemd 守护）、
  `--state-dir <绝对路径>`（自定义状态根）、`--help`。
- install.sh 不安装 codearts CLI（独立产品）：`bun src/cli.ts upgrade-cli` 一键安装/升级；
  凭据配置见下文 AK/SK 节（或 `codearts login` 后用登录态）。
- 卸载：`bash uninstall.sh --yes`（默认保留 `~/.codearts-bridge` 数据与 codearts CLI；
  `--purge` 连状态目录一并清除）。

## 升级

| 组件 | 命令 | 说明 |
|------|------|------|
| bridge 自身 | `codearts-bridge self-upgrade` | `git fetch` → 有更新则 `reset --hard origin/main` → bun install（lock 变更时）→ typecheck+test 门 → 守护重启 → /health 验证；**失败自动回滚备份提交**（记录在 `<stateDir>/self-upgrade-backup.json`）。`--skip-tests`/`--skip-typecheck` 可跳门禁 |
| codearts CLI | `codearts-bridge upgrade-cli` | 官方 release-info → 已最新即返回 → 否则受控升级（哈希校验/原子部署/复验/旧版转备份，失败零损坏） |
| opencode | 官方渠道 | 兼容矩阵：≥2.1 支持 V2 插件（本插件硬性要求）；2.1.4 走项目级 `plugin` 键+目录路径；**2.2.5 起推荐全局自动加载目录** `~/.config/opencode/plugins/*.ts`（install.sh 的接线形态，`exports` 被采用、热加载生效） |

`codearts-bridge doctor` 可随时体检八项组件状态（opencode/bun/codearts CLI/凭据/
systemd 单元/守护 /health/磁盘占用/官方端点网络），任何 ✗ 退出码非 0。

## 插件契约

- 默认导出：`Plugin.define({ id: "codearts-bridge", setup })`（`@opencode/plugin` 2.2.3）。
- 注册唯一冒烟工具：命名空间内名 `status` + `options.namespace = "codearts"`
  ⇒ 对外有效名 `codearts_status`；`execute` 返回 `{ ok: true, version }`。
- setup 含不兼容守卫（依 SDD 台账 Ruling（2026-10-31，修复环 I1））：
  宿主上下文缺少 `tool.transform` 时**显式 throw**（错误消息含插件 id、缺失项与
  期望契约 opencode V2 插件 API），由宿主以 `failed to load plugin` 记录——
  仓库铁律：出错即显式报错，禁止静默退化。

## 加载方式（实测）

> 实测环境：opencode **2.1.4** 后台服务（`~/.config/ai.opencode.desktop/cli/2.1.4-x64/opencode-cli`，
> pid 随启动变化；CLI `~/.opencode/bin/opencode` 为 2.0.28，仅用于 `api`/`plugin list` 观测）。
> 实测日期：2026-10-31。方法：热重载观察 + 日志取证（`~/.local/share/opencode/log/opencode.log`），
> 全程未重启/未杀死任何 opencode 进程，试验配置均备份还原并 diff 校验一致。

**结论（可直接用于 T4-01 正式接入）：**

| 项 | 实测结论 |
|---|---|
| 配置键名 | 项目级 `opencode.json` 用 **`plugin`**（单数，本仓库既有用法）。`plugins`（复数）为 v2 新键（schema 见 `@opencode/schema` 2.2.3；官方 issue #56258 证实两键在 v2 均可加载）——但在本环境**全局配置** `~/.config/opencode/opencode.jsonc` 中两种键均未能触发热重载加载（`config.updated` 事件后仅重载项目级插件），全局接入待 T4 用**全局自动加载目录** `~/.config/opencode/plugins/*.ts` 另行验证 |
| 路径形态 | **绝对目录路径**（如 `/…/plugins/codearts-bridge`）。⚠ 文件路径会被规范化拒绝：`WARN "configured plugin path must be a directory"`；相对路径目录会走 npm 包解析路径，本地未安装目录被**静默跳过**（无任何日志行） |
| 入口解析 | 目录下 **`index.ts`**（或 index.js）。⚠ `package.json` 的 `exports` 字段在 2.1.4 目录解析中**不被采用**——必须有实体 `index.ts`，故本包根目录提供 `index.ts` 再导出 `src/server.ts` |
| 依赖解析 | 沿插件文件目录树向上解析——`@opencode/plugin` 从本包 `node_modules/` 正常解析（模块加载 + 默认导出形状校验通过，日志无 `failed to load plugin`） |
| 加载证据 | `msg="loading plugin" id=/…/plugins/codearts-bridge entrypoint=file:///…/index.ts`（config.updated 后约 1.3s 热重载生效）；依赖图文件 watcher 跟踪 `src/server.ts`、`src/core/config.ts` |
| 工具清单 | 2.1.4 服务端无工具列表 HTTP 端点（`/api/tool`、`/api/tools`、`/api/experiment/tool` 均 404），`codearts_status` 在列情况未能经 API 确认，待 T4 经会话内实测 |
| 反例参照 | `plugins/ohm-shim`（裸目录 + index.js + 依赖 oh-my-openagent）在主检出可加载；在 worktree 中因依赖缺失报 `failed to load plugin: Cannot find package 'oh-my-openagent'`——佐证依赖按插件目录就近解析 |

**推荐的 T4-01 接入形态**（本卡已验证）：在项目级 `opencode.json` 的 `plugin` 数组中
加入本插件目录的**绝对路径**，入口为根 `index.ts`：

```jsonc
{
  "plugin": [
    "/home/wsc/.local/share/opencode/worktree/e5785e/codearts-bridge/plugins/codearts-bridge"
  ]
}
```

## 全局接入（T4-01 实测，2026-10-31）

**正式接入形态：全局自动加载目录，实测生效**（opencode **2.2.5** 后台服务；
全程未重启服务，全局 `opencode.jsonc` 零改动——无需形态 2 的配置键方案）：

```ts
// ~/.config/opencode/plugins/codearts-bridge.ts（新文件，sha256 997bda02…f8e）
// codearts-bridge 全局自动加载入口（T4-01，R-gj1 形态 1）。
// 指向稳定公开检出 /home/wsc/wsc/open-codearts（非 worktree 瞬态路径）。
export { default } from "/home/wsc/wsc/open-codearts/index.ts";
```

**证据链**（`~/.local/share/opencode/log/opencode.log`）：

1. 写入后约 0.25s：`msg="loading plugin" id=/home/wsc/.config/opencode/plugins/codearts-bridge.ts
   entrypoint=file:///home/wsc/.config/opencode/plugins/codearts-bridge.ts`；
2. 依赖图 watcher 跟踪公开检出全部模块（`/home/wsc/wsc/open-codearts/src/**` 64 行订阅，零
   `failed to load plugin`）；
3. `opencode plugin list`（2.2.5 CLI）：`codearts-bridge  local  /home/wsc/.config/opencode/plugins/codearts-bridge.ts` 在册；
4. 服务端 `GET /api/plugin`（2.2.5 新端点）：`{"id":"codearts-bridge","source":{"type":"local",
   "path":"/home/wsc/.config/opencode/plugins/codearts-bridge.ts"},"state":{"status":"active"}}`；
5. 会话内活调 `codearts_daemon_status` 成功（守护 version=dev, uptime=3839s, actives=0）。

**2.2.5 加载行为增量**（对照 2.1.4 结论）：`package.json` 的 `exports` **被采用**
（dev 接线目录的 entrypoint 为 `src/server.ts` 而非根 `index.ts`）；全局 autoload 目录
`.ts` 单文件入口直接热加载。双版本对照表见公开仓库 README"加载方式（实测）"节。

**双实例注意**：本 worktree 的项目级 `opencode.json` 仍有 dev 接线（本地改动，台账在案、
不提交）——从本 worktree 打开的会话会同时加载全局与项目两个实例（`plugin list` 可见两行）。
工具名重复注册行为未系统实测；全局接入已覆盖后，dev 接线仅在插件开发调试时需要。

## 兼容入口说明

- `index.ts`（根）：2.1.4 目录加载的实体入口（`export { default } from "./src/server.ts"`）。
- `plugin/index.ts`：裸目录 shim 备用入口（若未来把插件目录整体发布为 npm 包，
  可将配置指向该裸子目录以绕过包解析路径）。
