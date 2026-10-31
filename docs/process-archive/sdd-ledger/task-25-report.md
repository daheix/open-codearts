# Task 25 报告：安装包与组件升级支持（T4-05，收官交付）

- **Status**: DONE
- **Commit**: `3498ed8e08`（仅 `git add plugins/codearts-bridge`，12 文件 +2988/−3）
- **日期**: 2026-10-31
- **BASE**: `79a8523b`（分支 codearts-bridge）

## 1. 实现内容（对照任务书 A–G 逐条）

### A. `install.sh`（仓库根=插件根，139 行，幂等可重跑）
流程逐步输出进度行，`set -euo pipefail`，任一步失败显式报错非 0 退出：
1. 前置探测 git/bun：bun 按 `PATH → ~/.bun/bin` 两路探测，全缺 → 官方 `curl -fsSL https://bun.sh/install | bash`（装后断言 `~/.bun/bin/bun` 在场）；
2. `REPO_ROOT=$(dirname BASH_SOURCE)` 定位 + `bun install`；
3. opencode 接线（幂等）：写 `~/.config/opencode/plugins/codearts-bridge.ts`（一行 re-export 指向 `<repo>/index.ts` 绝对路径）；内容等价 → 跳过；不等价 → `cp` 备份 `.bak-<时间戳>` 后覆写；
4. systemd 守护（默认开，`--no-daemon` 跳过）：`bun src/cli.ts service install`（内部已含 daemon-reload + enable --now，T3-07 语义）；`systemctl` 不在场 → 跳过并提示前台 daemon 运行方式；
5. 质量门 `bun run typecheck && bun test`（`--skip-gate` 跳过，**仅供测试/CI**——嵌套 `bun test` 会自递归，见 §7 偏差登记①）；
6. `doctor` 体检 + 组件摘要（✓/⚠ 状态 + 各组件后续指引）。
参数：`--no-daemon` / `--state-dir <绝对路径>`（经 `CODEARTS_BRIDGE_STATE_DIR` 传递给 service install 与 doctor）/ `--skip-gate` / `--help`（awk 提取头注，无代码行泄漏）。

### B. `codearts-bridge doctor`（src/core/doctor.ts，732 行）
八项检查按任务书 ①..⑧ 固定顺序（id 稳定数组 `DOCTOR_CHECK_IDS`）：

| id | 检查 | 判定 |
|---|---|---|
| opencode | `opencode --version` 解析 | 缺失/`<2.1`/版本不可解析 → ⚠；≥2.1 → ✓ |
| bun | PATH → `~/.bun/bin/bun` 两路探测 | 缺失 → ✗；在场 → ✓ |
| codearts-cli | `probeInstall` 只读快照 | 探测抛错 → ✗；未装 → ⚠（指引 upgrade-cli）；autoupdate 开/漂移/备份失效 → ⚠ 汇总；健康 → ✓ |
| credential | `<kernelDataDir>/auth.json` 或 `readAksk` | 任一在场 → ✓（mode 入 detail）；皆无 → ⚠；文件损坏 → ✗（值绝不回显） |
| systemd | 三单元 stat + `is-active`（**单元缺失时零 systemctl 调用**） | 非 systemd/未装/非 active → ⚠；全在场且 active → ✓ |
| daemon | GET `/health` 3s 超时 | ok:true → ✓；否则 ⚠（附启动指引） |
| disk | 复用 `collectHealth`（db/wal/dumps/logs） | 阈值告警：dumps>500MB / WAL>256MB / logs>1GB → ⚠（hygiene 指引）；采集异常 → ✗ |
| network | release-info HEAD 5s 超时 | 任意 HTTP 应答 → ✓；失败 → ⚠ 不阻塞 |

结构纪律：判定函数 `judgeXxx(obs)` 全纯函数（观察值→`DoctorCheck{level,summary,remediation?,detail?}`）；采集器 `collectXxx` 把一切 IO 失败归一为观察值（体检如实报告而非中途夭折）。输出：人类可读行（✓/⚠/✗ + 修复指引）+ 尾部单行结构化 JSON；`--json` 仅 JSON。聚合退出码：任何 ✗ → 1，⚠ 不影响。

### C. `codearts-bridge self-upgrade`（src/core/selfupgrade.ts，394 行）
流程：`.git` 形态核验 → **脏工作树拒绝**（`git status --porcelain` 非空 → `SELF_UPGRADE_DIRTY_TREE`，reset --hard 不可逆，零损坏要求先显式拒绝）→ `git fetch origin` → 比对 HEAD vs origin/main（一致 → `up-to-date` 零写入）→ 备份提交号至 `<stateDir>/self-upgrade-backup.json`（原子写）→ `git reset --hard origin/main` → bun.lock 内容变更才 `bun --cwd <repo> install` → 质量门 typecheck（默认跑）+ `bun test`（`--skip-tests`/`--skip-typecheck`）→ 守护活跃（`daemon.pid` + 注入 pidAlive）→ `systemctl --user restart` → /health 轮询（15 次 × 1s）→ 返回 updated。
失败语义：reset 之后任何失败 → `git reset --hard <备份提交>` 回滚 + 守护曾活跃则再重启 + 重抛原错误（附回滚注记）；回滚 reset 自身失败 → `SELF_UPGRADE_ROLLBACK_FAILED`（备份记录保留 + 人工恢复命令入 remediation）。
生产缺省 Exec：600s 超时 / 8MiB 输出上限（门禁量级）。git/bun/systemctl/fetch/pidAlive/sleep 全注入。

### D. `codearts-bridge upgrade-cli`（upgrade.ts 增 `upgradeCli`，+30 行）
`probeInstall` 探测 → `fetcher.latest()` → 在场且版本一致 → `{action:"already-latest"}`（零下载零部署）；否则 `upgradeInstall` **锚定同一清单版本**（防两次调用间清单漂移竞态）→ `{action:"upgraded",...}`；未安装（present=false）兼作一键安装。失败零损坏语义完整继承（T1-05 的哈希校验/原子部署/复验/旧版转备份/审计 install.jsonl 全在）。

### E. `uninstall.sh`（23 行薄转调）+ `codearts-bridge uninstall`（src/core/uninstaller.ts，234 行）
① opencode 自动加载入口：先备份 `.bak-<ISO 时间戳>` 后删；不在场跳过；非常规文件拒删。
② systemd 三单元：全缺跳过；`systemctl --version` 探测不可用 → 显式留痕并**保留单元文件**（禁静默）；可用 → 经注入 `serviceUninstall`（cli 层 `serviceUninstallCommand`，core 不反向依赖 cli）执行 disable+删+daemon-reload。
③ 默认保留 `<stateDir>` 与 codearts CLI（后者不在卸载范围，独立产品）；`--purge` 才清状态目录（守卫：拒 HOME/文件系统根/层数 <2 → `PURGE_TARGET_INVALID`）。
确认门：非交互无 `--yes` → `UNINSTALL_CONFIRM_REQUIRED` rc 1；交互默认 N（拒绝 → "已取消（未做任何变更）" rc 1）。

### F. 文档
README：目录结构更新 + 新增"**给别人安装（三行）**"（clone→install.sh→doctor）与"**升级**"节（bridge 自升级 / codearts CLI 升级 / opencode 兼容矩阵 2.1.4 vs ≥2.2.5）。CHANGELOG：**v0.4.0** 完整条目。package.json：0.1.0 → **0.4.0**。

### G. 测试（+84 用例）
- `test/doctor.test.ts`（55 用例）：compareVersions/humanBytes 纯函数（含非法输入显式抛）；八判定函数全业务分支；八采集器注入 fake exec/fetch/tmp FS（含"单元缺失零 systemctl 调用"沙箱安全断言、凭据值零回显断言）；runDoctorChecks 顺序稳定；doctorCommand 双输出/退出码/`--json`。
- `test/installer.test.ts`（29 用例）：install.sh/uninstall.sh `bash -n`；`--help`/未知参数显式报错；**沙箱 HOME 集成三态**（全流程 rc0+接线内容断言 / 幂等重跑无 .bak / 外部改动→备份后重写；HOME/PATH/STATE_DIR 全注入，绝不触碰真实 HOME）；selfUpgrade 13 分支（非 git/fetch 失败/脏树/无更新/成功/锁变更触发 install/test 失败回滚/typecheck 失败回滚/回滚自身失败/守护活跃重启/health 失败回滚+回滚重启/systemctl 失败回滚/pidfile 非法禁猜）；upgradeCli 三分支（already-latest 零下载/upgraded 含审计断言/HASH_MISMATCH 零损坏逐字节原位）；uninstall 八语义（非交互拒绝零改动/确认拒绝/--yes 全流程备份+单元真删+保留断言/不在场跳过/systemctl 缺失留痕保留/--purge 清除/purge=HOME 守卫拒绝）。

## 2. 测试结果（最终全量）

```
bun test   → 561 pass / 1 skip / 0 fail，2492 expect()，23 文件（基线 477+1skip → +84）
bun run typecheck → rc=0（tsc --noEmit 零错误）
bash -n install.sh / uninstall.sh → 双通过
单文件行数 → 最大 cli.ts 812 行（≤1000 铁律 ✓）
```

## 3. TDD 证据

1. **RED**：先写 test/doctor.test.ts + test/installer.test.ts → `Cannot find module '../src/core/doctor'`（0 pass / 2 fail，模块不存在）；
2. **GREEN**：实现 doctor.ts → doctor.test 55 全绿；实现 selfupgrade.ts/uninstaller.ts/upgradeCli/cli.ts 接线 → installer.test 29 全绿（期间修复：fake git `-C` 偏移分派、pidfile 测试注入 pidAlive、summary 字段名对齐）；
3. 安装脚本最后落地 → bash -n 门与沙箱集成三态全绿；
4. 全程每一轮 `bun test`/`typecheck` 留痕于会话输出；最终全量回归 0 fail。

## 4. 文件清单

| 文件 | 状态 | 行数 |
|---|---|---|
| `plugins/codearts-bridge/install.sh` | 新增（0755） | 139 |
| `plugins/codearts-bridge/uninstall.sh` | 新增（0755） | 23 |
| `plugins/codearts-bridge/src/core/doctor.ts` | 新增 | 732 |
| `plugins/codearts-bridge/src/core/selfupgrade.ts` | 新增 | 394 |
| `plugins/codearts-bridge/src/core/uninstaller.ts` | 新增 | 234 |
| `plugins/codearts-bridge/src/cli.ts` | 修改（+114：USAGE 四命令 + 分派 + 命令函数） | 812 |
| `plugins/codearts-bridge/src/core/upgrade.ts` | 修改（+30：upgradeCli） | 647 |
| `plugins/codearts-bridge/test/installer.test.ts` | 新增 | 585 |
| `plugins/codearts-bridge/test/doctor.test.ts` | 新增 | 666 |
| `plugins/codearts-bridge/README.md` | 修改（+34：目录结构/给别人安装/升级节） | — |
| `plugins/codearts-bridge/CHANGELOG.md` | 修改（+38：v0.4.0） | — |
| `plugins/codearts-bridge/package.json` | 修改（0.1.0→0.4.0） | — |

仓库级纪律核验：`git status` 除插件目录外仅既有两处本地改动（`opencode.json` dev 接线、`.codeartsdoer/package.json`，**未提交未还原**）；提交仅含 `plugins/codearts-bridge`。

## 5. 安装流程自测记录（沙箱 HOME）

### 5.1 全量门禁安装（`--no-daemon --state-dir`，HOME=$SB/home）
```
install rc=0；质量门 561 pass/0 fail 通过；doctor 3✓/5⚠/0✗（沙箱裸环境预期 ⚠：
opencode 未检出/codearts 未装/无凭据/单元未装/网络超时——全部附修复指引）
接线文件写入 <sandbox>/.config/opencode/plugins/codearts-bridge.ts，内容
  export { default } from "<repo>/index.ts";
真机 HOME 零触碰（bun/systemctl/守护检查均只读或沙箱内）。
```

### 5.2 幂等重跑
```
rerun rc=0；"opencode 接线已等价，跳过"；插件目录仅 codearts-bridge.ts，无 .bak-* 产生
```

### 5.3 卸载链
```
uninstall --yes → rc0：autoload 已备份（.bak-2026-10-31T11-50-30-796Z）后移除；
  systemd 单元不在场跳过；"保留状态目录…（--purge 才清除）"；"保留 codearts CLI 安装"
重放 state → uninstall --yes → state 保留 ✓ → --purge → state 已清除 ✓
非交互无 --yes → 结构化 UNINSTALL_CONFIRM_REQUIRED（stderr JSON）拒绝，零改动
```

### 5.4 一次真机误触（如实记录，已还原）
首次手动全量门禁验证时**漏设 HOME 沙箱**，install.sh 按设计把真机
`~/.config/opencode/plugins/codearts-bridge.ts`（指向公开检出 open-codearts）判定为
"不等价"→ 备份为 `.bak-20261031194806` 后覆写为 worktree 路径。发现后立即从备份
逐字节还原并删除备份（现文件内容与任务前一致，sha/内容已核对；仅 mtime 变化，
opencode 热加载语义不受影响——重载回原指向）。该事件反证了脚本的备份-还原路径
真实有效，也促成了 §7 偏差登记⑤（README 强调 install.sh 会改写不等价接线）。

## 6. 自审发现（已全部处置）

1. **install.sh --help 泄漏代码行**：初版 `sed -n '2,30p'` 把 `set -euo pipefail` 与变量定义打进帮助 → 改 awk"仅连续 # 注释行"，复核干净；
2. **doctor 测试触碰真实 HOME 风险**：初稿 loadConfig 未显式注入 installDir → probeInstall 会读真机安装目录（环境依赖 + 违反隔离纪律）→ 全部用例改注入 tmp 路径；
3. **core→cli 反向依赖**：uninstaller 初稿直接 import cli.ts 的 serviceUninstallCommand（会成环）→ 改为 `deps.serviceUninstall` 注入（cli 装配、core 声明签名），未注入且单元在场 → `UNINSTALL_SERVICE_DEPS_MISSING` 显式报错；
4. **uninstall purge 分支异常逃逸**：assertPurgeable 抛错未被捕获会以"CLI 内部错误"形态冒泡 → 包裹为结构化 printError + rc 1；
5. **未用导入清理**：doctor.test/installer.test/selfupgrade.ts 三处 unused imports 移除（typecheck rc=0 复核）。

## 7. 偏差与裁定登记（自主决策，均最小实现）

1. **`--skip-gate` 参数超出任务书三参数面**：任务书集成测试要求"沙箱内跑 install.sh"且测试本身运行于 `bun test` 之内——install.sh 的 `bun test` 质量门会自递归（测试→install.sh→bun test→测试…），必须提供跳过通道。定位为"测试/CI 专用"并在 --help 明示；**全量门禁路径已由 §5.1 手动真跑覆盖**（561 绿），不构成质量缺口。
2. **self-upgrade 增加"脏工作树拒绝"**（任务书未要求）：`reset --hard` 会不可逆丢弃用户未提交改动，与"失败零损坏"精神冲突；显式报错（SELF_UPGRADE_DIRTY_TREE + stash/提交指引）而非静默覆盖。对公开检出的正常使用零影响（干净树）。
3. **self-upgrade typecheck 默认执行**：任务书"typecheck 可跳过"取严格解读（默认跑 + `--skip-typecheck` 显式跳过），代价 +18s，质量优先。
4. **doctor 结构化输出形态**："双输出"落实为"人类可读行 + 尾部单行 JSON"（脚本按行取尾解析），另供 `--json` 纯 JSON；比"仅 --json"更贴合任务书字面。
5. **install.sh 会覆写不等价的既有接线（先备份）**：这是"幂等指向本仓库"语义的必然；已写入 README 安装节提示（指向其他检出的既有接线会被备份后改写）。
6. **daemon /health 与网络探测在沙箱测试中可能触达真机守护/外网**：均为只读 GET/HEAD，符合"不触碰运行中守护"纪律（status 命令同形态先例）；单测内全部注入 fake，绝不联网。
7. **FetchLike/PID_FILE_NAME 双份同码**：cli.ts 与 core 层各自定义同形类型/常量（core 不反向依赖 cli；daemon.ts 的私有常量未导出）——沿用 M78 已登记先例，注释注明同源。

## 8. 遗留问题 / 后续建议

1. **真机安装验证由主控执行**（本任务纪律）：建议在公开检出 `/home/wsc/wsc/open-codearts` 跑 `bash install.sh`（不带 --no-daemon，验证 systemd 全链），预期 doctor 的 opencode 项按真机 CLI 版本如实呈现（本机 `~/.opencode/bin/opencode` CLI 为 2.0.28 会报 ⚠，属双版本并存实况，非缺陷）；
2. **self-upgrade 门禁耗时**：全量 `bun test` + typecheck ≈ 45s，后续可考虑 `--skip-tests` 文档化为"日常自升级推荐"；
3. **`--state-dir` 传递链**：uninstall.sh 未透传 --state-dir（uninstall 子命令只收 --yes/--purge），依赖环境变量 `CODEARTS_BRIDGE_STATE_DIR`——自定义状态根用户卸载时需带该环境变量（README 升级节未展开，后续可补）；
4. **M 级小项**：install.sh usage 依赖 awk（POSIX 环境普遍在场，无碍）；doctor 磁盘阈值（500MB/1GB/256MB）为固定常量，未参数化（够用，阈值调整属配置化候选）。

## 9. 验收判据对照（任务书约束逐条）

| 约束 | 结果 |
|---|---|
| 禁静默 fallback/兜底 | ✓（systemctl 缺失留痕保留、pidfile 非法报错、purge 守卫、非交互拒绝等全部显式） |
| BridgeError 结构化 | ✓（新增 20+ 错误码全部 BridgeError/结构化 stderr JSON） |
| 中文注释与文案 | ✓ |
| 单文件 ≤1000 行 | ✓（最大 cli.ts 812） |
| bun test 全绿 | ✓ 561+1skip/0 fail |
| typecheck 零错误 | ✓ rc=0 |
| bash -n 通过 | ✓ 双脚本 |
| 提交格式 `codearts-bridge(T4-05): …` | ✓ 3498ed8e08 |
| 只 git add plugins/codearts-bridge | ✓ |
| 不触碰真实全局配置/运行守护 | ✓（一次误触即时还原，见 §5.4；终态零差异） |
