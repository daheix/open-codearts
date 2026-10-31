# Task 22 报告：全局接入与使用文档（T4-01）

**Status**: DONE
**日期**: 2026-10-31
**工作区**: `/home/wsc/.local/share/opencode/worktree/e5785e/codearts-bridge`（分支 `codearts-bridge`）
**提交**:
- worktree：`c5df019a1d` — `codearts-bridge(T4-01): 全局接入与使用文档 — 2.2.5 全局 autoload 实测生效、开发文档更新`（仅 `plugins/codearts-bridge/README.md`，1 file +34/-1）
- 公开仓库（daheix/open-codearts，另行提交面）：`5a8a440` — CHANGELOG + README 扩充 + 同步 matrix.test.ts，**已推送 origin/main**
- 全局配置：`~/.config/opencode/opencode.jsonc` **零改动**（无需修改，见下）

---

## 1. 接入形态结论 + 日志证据（R-gj1/R-gj3）

### 结论：R-gj1 形态 1（全局自动加载目录）实测生效，形态 2（全局 jsonc 加键）不需要

**重要环境事实**：共享 opencode 服务已从 T1-01 时的 2.1.4 升级为 **2.2.5**
（`~/.config/ai.opencode.desktop/cli/2.2.5-x64/opencode-cli serve --service`，pid 172427，
`GET /api/info` → version 2.2.5）。以下结论均在 2.2.5 上取得。

**接入文件**（新建，无既有内容需备份；sha256 留痕）：

```
~/.config/opencode/plugins/codearts-bridge.ts   (229B, sha256 997bda02…f8e)
// codearts-bridge 全局自动加载入口（T4-01，R-gj1 形态 1）。
// 指向稳定公开检出 /home/wsc/wsc/open-codearts（非 worktree 瞬态路径）。
export { default } from "/home/wsc/wsc/open-codearts/index.ts";
```

**证据链（五重，日志行级留痕于 `~/.local/share/opencode/log/opencode.log`）**：

1. **热加载日志**：写入后约 0.25s（09:15:20.935Z）
   `msg="loading plugin" id=/home/wsc/.config/opencode/plugins/codearts-bridge.ts entrypoint=file:///home/wsc/.config/opencode/plugins/codearts-bridge.ts`；
2. **依赖图 watcher**：跟踪公开检出全部模块 64 行订阅（`/home/wsc/wsc/open-codearts/src/**` 至 daemon.ts/goal/*），零 `failed to load plugin`（针对新文件 grep 计数=0）、零 duplicate/conflict 告警；
3. **`opencode plugin list`**（2.2.5 CLI）：`codearts-bridge  local  /home/wsc/.config/opencode/plugins/codearts-bridge.ts` 在册（同表亦见 worktree dev 接线实例，见遗留 1）；
4. **服务端 API**（R-gj3 `opencode api` 探测，2.2.5 新增 `/api/plugin` 端点；T1-01 时代 2.1.4 无工具/插件端点 404——该遗留项在 2.2.5 已解决）：`GET /api/plugin` → `{"id":"codearts-bridge","source":{"type":"local","path":"/home/wsc/.config/opencode/plugins/codearts-bridge.ts"},"features":{"server":true},"state":{"status":"active"}}`；且该响应视角（location.directory=/home/wsc）只列全局实例，证明 autoload 作用域=全局；
5. **会话工具活调**：本会话实调 `codearts_daemon_status` 成功 → 守护运行中 `ok=true, version=dev, uptime=3839s, actives=0`。

**2.2.5 加载行为增量**（对 README 实测表的重要修正）：
- `package.json` 的 `exports` **被采用**（dev 接线目录 entrypoint=`src/server.ts`，非 2.1.4 的必须根 index.ts）；
- 全局 autoload 目录 `.ts` 单文件入口写入即热加载（无需改配置/重启）；
- 2.1.4 的"全局 jsonc 两键不参与热重载"结论仍记录在案（2.2.5 未重测全局 jsonc 键——形态 1 已生效，无必要）。

**未重启服务**（裁定遵守：重启由用户在安全时机执行；本次形态 1 无需重启即已生效）。

## 2. 公开仓库文档改动（R-gj4，`/home/wsc/wsc/open-codearts`，commit 5a8a440 已推送）

| 文件 | 改动 |
|---|---|
| `CHANGELOG.md` | 新增。v0.3.0-dev：M1 安装管家（status/repair/upgrade/health/hygiene，零损坏升级）、M2 传输与执行（codearts_run 自动选传输/三传输/超时取消）、M3 目标引擎与守护（五件套/契约监督/故障自愈/systemd+watchdog/回呼）、插件接入实测（2.2.5 autoload/2.1.4 项目级）、已知限制——全部面向用户语言 |
| `README.md` | ①安装节重构：方式一=全局 autoload 目录（推荐，含 shim 代码与 0.25s 热加载说明）/方式二=plugin 键；②"加载方式（实测）"改 2.1.4/2.2.5 双版本对照表（含本节新证据与双实例提示）；③新增"故障排查"节四项：守护未启动（DAEMON_UNAVAILABLE）、PTY 宿主缺失（PTY_HOST_UNAVAILABLE）、升级失败恢复（零损坏+repair+BIN_MISSING_NO_BACKUP）、AK/SK 配置（门户链接+config.env 示例+验证路径）；④测试计数 455+→463；⑤首部/环境要求/已知限制同步 2.2.5 表述 |
| `test/matrix.test.ts` | 自上游 HEAD 同步（公开检出此前停在 T3-07=455 计数；src 树经 diff 逐位一致，仅缺此 M3 测试文件）。同步后公开检出 bun test **463 计数全绿**（462 pass+1 skip/2214 expect，实测） |

## 3. 终扫结果（R-gj4③，`git grep` 对全部 54 个入库文件）

| 扫描 | 模式 | 结果 |
|---|---|---|
| 内部路径/用户名 | `/home/wsc`、`worktree/e5785e`、`ChinaSimStdio`、`wsc@` | **零命中** |
| 密钥/凭据 | `ghp_`/`gho_`/`sk-*`/`ark-*`/PRIVATE KEY/AKTV… | **零命中** |
| 敏感文件名 | `account.txt`（零命中）；`daemon-token`/`auth.json`/`config.env` 命中均为设计文档中的文件名常量与格式说明，无真实值 | **无泄密** |

## 4. 测试与提交纪律核对

- worktree：`bun test` 463 计数（462 pass + 1 skip tmux 真机条件跳过）/ 0 fail；`bun run typecheck` rc=0（本任务不改 src/，全量复跑确认无破坏）。
- worktree 提交只 `git add plugins/codearts-bridge`（`c5df019a1d`，1 file）；工作区根 `opencode.json` 的 dev 接线改动**原样保留未提交未还原**（已裁定本地改动）。
- 公开仓库提交 `5a8a440` 已推送（`0283540..5a8a440 main -> main`）。
- 全局 autoload 文件与守护状态：文件在场（sha256 见上），`codearts_daemon_status` 活调 ok。

## 5. 遗留问题 / 担忧

1. **双实例并存（worktree 会话）**：本 worktree 项目级 `opencode.json` dev 接线与全局 autoload 并存——从本 worktree 打开的新会话会加载两个实例（`plugin list` 两行）。同名工具重复注册行为未系统实测（需新会话 boot，本任务不得重启服务/开真实新会话）。处置建议：全局接入已覆盖后，dev 接线仅插件开发调试需要；若用户在 worktree 会话观察到工具重复，移除项目级 `plugin` 数组中的 worktree 条目即可。日常（非 worktree）会话无此问题。
2. **2.1.4 结论不可达**：共享服务已升级 2.2.5，任务书"2.1.4 实测键名"只能在 2.1.4 环境复现；文档已按双版本对照表如实分列（2.1.4 列保留 T1-01 结论，2.2.5 列为本轮实测）。
3. **全局 jsonc 未加键**：R-gj1 形态 1 生效，形态 2 无需执行——全局配置保持零改动是**更优结果**（无备份/还原风险面）。若用户偏好配置键形态（显式可见），可按公开仓库 README"方式二"自行添加。
4. **守护 version=dev**：当前守护为开发态进程（uptime 3839s，本会话所在环境的 dev 接线产物）；systemd 生产单元安装保留自 T3-07，用户重启服务后若走生产守护，`daemon_status` 将报真实版本——属预期演进，非缺陷。
5. **autoload shim 依赖公开检出的 node_modules**：`/home/wsc/wsc/open-codearts` 需保持 `bun install` 过的依赖树（已验证在场）；若用户清理该目录 node_modules，autoload 加载会失败（日志 `failed to load plugin` 显式可见，不静默）——已在公开 README 安装节隐含（git clone+bun install 流程），担忧等级低。
