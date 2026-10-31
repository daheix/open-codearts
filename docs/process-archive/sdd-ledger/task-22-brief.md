### Task 22: 全局接入与使用文档（T4-01）

**Files:**
- Modify: `~/.config/opencode/opencode.jsonc`（备份后加插件条目，实测键名以 T1-01 结论为准）；Modify: `plugins/codearts-bridge/README.md`

**Interfaces:**
- Consumes: 全部。

- [ ] **Step 1: 全局接入**：备份全局配置 → 添加插件绝对路径条目 → 重启/重载 opencode 服务（`opencode service restart`）→ 在真实会话验证 `codearts_status` 可见可用（记录证据）
- [ ] **Step 2: README 完稿**：安装/加载/配置项/工具速查/AK-SK 配置指引（含门户链接与 `config.env` 示例）/tmux 可选说明/故障排查（daemon 未启动、PTY 宿主缺失、升级失败零损坏恢复）/审计与状态文件位置
- [ ] **Step 3: Commit**：`codearts-bridge(T4-01): 全局接入与使用文档 — opencode 加载实测结论、AK-SK/守护/排障说明`

