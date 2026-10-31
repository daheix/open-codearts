# 华为云 CodeArts CLI 自动升级缺陷报告（建议提交华为）

> 状态：草稿（待用户审阅后经华为渠道提交）
> 日期：2026-10-31
> 影响版本：CodeArts CLI 26.10.9（亦复现于 26.10.13）；平台 Ubuntu 24.04.5 LTS，HOME 位于 ZFS
> 提交渠道：https://codearts.huaweicloud.com/portal/settings/cli-auth 页面反馈入口 / 华为云工单

---

## 中文版

### 缺陷标题
自动升级流程"先改名后部署"且部署失败静默无报错，导致 CLI 主程序丢失、完全不可用且无自愈

### 现象
自动升级后 `~/.codeartsdoer/installers/bin/codearts` **消失**（仅剩 `codearts.delete`），
任何方式启动 CLI 均报错，且升级器不留任何错误日志、不做自动恢复。用户侧表现 =
"CLI 突然无法启动"。本机 30 天内发生 **3 次**（2026-10-24、10-29 09:23、10-29 23:43）。

### 取证（内核日志 `cli-data/log/kernel-*.log`，service=upgrade）
```
23:42:26 starting exe upgrade method=curl targetVersion=26.10.13
23:43:17 downloaded /tmp/codearts-install-26.10.13 size=73160786
23:43:17 hash verification passed
23:43:18 renaming current exe for backup: bin/codearts → bin/codearts.delete
23:43:18 running installation / extracting installer
23:43:19 installer extracted to temp dir / temp file cleaned up
（此后无任何 upgrade 日志、无报错 —— 部署步骤静默中止）
```
另一次（10-29 09:23）在 /tmp 残留未署权限的 `agentkernel`（26.10.13，可运行）与
`codearts` 脚本 —— 均未部署到位。

### 根因分析
1. 升级采用**先改名、后部署**顺序：`bin/codearts → codearts.delete` 发生在部署之前；
   部署一旦失败即留下"无 codearts、仅 .delete"的不可启动残局，且无回滚。
2. 部署失败被**静默吞掉**（日志止于 extracted，无 error 行），用户无法感知原因。
3. 本机 `/tmp` 与 `$HOME` 位于 **ZFS 不同数据集**（st_dev 29 vs 52）：若部署内部使用
   `rename(2)` 从 /tmp 迁移文件，将稳定得到 `EXDEV (Errno 18)`（已独立实测复现）。
4. 下载阶段网络不稳（ECONNRESET / 端点悬挂）会中断流程；叠加 (1)(2) 即造成反复损坏。

### 修复建议
1. 部署改为 **copy + 同数据集暂存 + 原子替换**（禁跨文件系统 rename），或部署前显式
   校验 src/dst 同一文件系统；
2. 任一步失败：**自动回滚**（从 `.delete` 恢复原二进制）+ 显式错误上报，绝不静默；
3. 保留 `codearts.bak-<版本>` 备份与启动时自愈检查（检测"仅剩 .delete"即自动还原）；
4. 部署失败时在 TUI/日志双通道显式告知用户。

### English Summary
The CodeArts CLI auto-upgrade renames the current binary to `codearts.delete`
**before** deploying the new one. When deployment fails (network interruption
mid-download — observed ECONNRESET; or silent abort after "installer extracted
to temp dir"), the CLI is left with no executable and no error is surfaced
(log ends at extraction; no rollback). On ZFS systems where /tmp and $HOME are
different datasets, a rename-based deploy additionally fails with EXDEV
(Errno 18, independently reproduced). Result: repeated permanent breakage of
the CLI (3 occurrences in 6 days). Suggested fixes: copy-based atomic deploy
(never rename across filesystems), explicit failure reporting, automatic
rollback from the `.delete` backup, and a startup self-heal check.

---

## 本机已实施的临时防护（供参考，非官方方案）
- `autoupdate: false`（关闭自动升级）+ `OPENCODE_DISABLE_AUTOUPDATE=true`；
- `bin/codearts.bak-26.10.9` 备份 + 启动自愈检查；
- 自研受控升级：下载→哈希→同数据集暂存→copy 原子部署→失败零损坏。
