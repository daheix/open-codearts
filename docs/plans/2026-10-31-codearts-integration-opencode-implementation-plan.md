# codearts-bridge（opencode 集成）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（本仓库律：所有编码任务派子 agent，主 agent 监督验收）。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付 `codearts-bridge`——opencode 插件（`codearts_*` 工具）+ 核心库 + 守护进程，把 codearts CLI 集成进 opencode：启动/升级零损坏、目标永不挂起、内存可观测可治理。

**Architecture:** 单包（插件薄壳 + 核心库 + 守护）；P1 工具进程内直调核心；P2 目标工具经本地 HTTP 调 systemd 守护；传输层在 `structured`（`codearts run --format json`，回合制进程，需 AK/SK）与 `pty`（tmux/script 托管 TUI，用现有登录态）之间由配置选择，显式报告，不静默切换。

**Tech Stack:** TypeScript（Bun 1.4.2 运行/测试）+ `@opencode/plugin` 2.2.3 + `node:` 内建库（无重型依赖）；`bun test` + `tsc --noEmit`。

**Spec:** `docs/superpowers/specs/2026-10-30-codearts-integration-opencode-design.md`（实施方案 A；方案 B=dsh 另行立项）

## Global Constraints

- 工作区：本计划在**专用 git worktree**（分支 `codearts-bridge`）执行；下列路径相对仓库根（worktree 内同构）。主检出 `feature/h3dl-3dlayout` 上有用户 WIP，**禁止在其上直接开发**。
- 禁静默 fallback：一切降级/失败**显式**（结构化错误 + 原因 + 修复指引）；恢复动作必须是设计中登记过的、带阈值与审计的受控动作。
- 部署/迁移文件仅用 **copy**，禁止跨文件系统 rename（/tmp 与 /home 为不同 ZFS 数据集，EXDEV 实测）；暂存目录必须与目标同文件系统。
- 传输/模式选择显式（`transport: auto|structured|pty`），`auto` 结果必须在 `codearts_status` 中说明原因；不可用时显式报错，不换模式。
- 破坏性动作（`codearts_upgrade`、`codearts_repair` 的修正、`codearts_hygiene` 执行）在插件层走 `ctx.permission.assert`（action=`codearts.manage`）。
- 状态根：`~/.codearts-bridge/`（`daemon-token`、`config.env` 均 0600）；审计 jsonl 追加写；状态文件原子写（同目录 tmp+rename）。
- 单文件 ≤1000 行；`tsc --noEmit` 零错误；`bun test` 全绿；中文注释与用户可见文案。
- 临时文件仅 `plugins/codearts-bridge/.tmp/`（git 忽略），用后即删；禁止系统临时目录。
- 测试全离线：网络访问仅限官方升级接口/下载源，且只在真机冒烟任务出现；单测/集成一律用注入的 fake。
- 提交信息：`codearts-bridge(Tn-MM): 摘要 — 细节`；每个任务结束时提交（回滚点）。
- 默认端口：守护 `127.0.0.1:4577`（可配）。

## Review Focus（最易伤用户的五类输入/条件，逐条在对应任务加测试）

1. `bin/codearts` 缺失只剩 `.delete`、或备份无效时——任何工具不得崩溃/静默，必须返回带修复指引的结构化错误（T1-03/T1-04）。
2. 升级部署的跨文件系统陷阱：暂存目录必须与 `installDir` 同 st_dev，否则拒绝执行（显式错误）（T1-05）。
3. PTY 注入回显被误判为进展/完成——echo guard（T3-02 移植用例 + T2-02 两步提交）。
4. 守护/opencode 重启后对账：未终态目标必须恢复且**幂等**（重复恢复不双注入）（T3-04）。
5. 并发竞争：pause 与 tick 并发、两个 upgrade/hygiene 并发——single-flight/串行化（T1-05、T3-03）。

---

## 文件结构总览（锁定分解）

```
plugins/codearts-bridge/
├── package.json                # name=codearts-bridge；exports: ./server；bin: codearts-bridge
├── tsconfig.json               # strict；noEmit
├── README.md                   # 使用手册（T4-01 完稿）
├── src/
│   ├── server.ts               # opencode 插件入口：Plugin.define + 工具注册（T1-08/T2-05/T3-06）
│   ├── cli.ts                  # CLI：status/daemon/service/goal/upgrade（T3-01/T3-07）
│   ├── daemon.ts               # 守护进程宿主 + HTTP API（T3-01/T3-05）
│   └── core/
│       ├── config.ts           # 配置与状态根（T1-02）
│       ├── errors.ts           # BridgeError 结构化错误（T1-03）
│       ├── install.ts          # 安装管家：probe/repair/upgrade/guard（T1-03/T1-04/T1-05）
│       ├── fsx.ts              # 原子写/st_dev 检查/copy 部署等文件原语（T1-04）
│       ├── health.ts           # 健康采样 + hygiene（T1-06/T1-07）
│       ├── transport/
│       │   ├── types.ts        # CodeartsTransport/Signal/SessionRef（T2-01）
│       │   ├── fake.ts         # 测试用 fake 传输（T2-01）
│       │   ├── pty-script.ts   # script(1) 宿主（T2-02）
│       │   ├── pty-tmux.ts     # tmux 宿主（T2-03）
│       │   └── structured.ts   # run --format json 驱动（T2-04）
│       └── goal/
│           ├── protocol.ts     # 完成协议/续跑指令/回显守卫（T3-02）
│           ├── runner.ts       # 监督状态机（纯 tick 设计）（T3-03）
│           └── state.ts        # 持久化/原子写/审计 jsonl/对账（T3-04）
└── test/
    ├── server.test.ts / config.test.ts / install.test.ts / fsx.test.ts
    ├── health.test.ts / transport-*.test.ts / protocol.test.ts / runner.test.ts / state.test.ts
    ├── daemon.test.ts / matrix.test.ts
    └── fixtures/
        ├── fake-codearts/ （fake-run.ts、fake-tui.sh、scenarios.ts、install-fixtures.ts）
        └── ...
```

---

## M1 · 基础器

### Task 1: 包骨架与加载验证（T1-01）

**Files:**
- Create: `plugins/codearts-bridge/package.json`、`tsconfig.json`、`bunfig.toml`（可选）、`.gitignore`（忽略 `.tmp/`、`node_modules/`）、`src/server.ts`、`src/core/config.ts`（仅常量占位）、`test/server.test.ts`（bunfig.toml 可选：无 test 配置需求；2026-10-31 Ruling 豁免，见 SDD ledger）

**Interfaces:**
- Produces: 模块 `src/server.ts` 默认导出 `Plugin.define({ id: "codearts-bridge", setup })`；常量 `PLUGIN_ID = "codearts-bridge"`；工具命名空间 `codearts`。

- [ ] **Step 1: 写失败测试** `test/server.test.ts`：
  - `default export is a plugin definition with id "codearts-bridge"`（断言导出对象非空且 id 正确，通过 `@opencode/plugin` 的 `Plugin.define` 形状检查）
  - `setup registers exactly one smoke tool named codearts_status`（用 fake ctx：`{ tool: { transform: async (cb) => { const ed = captureEditor(); cb(ed); } } }`，断言 `ed.add` 收到 `name === "status"`、`options.namespace === "codearts"`）
- [ ] **Step 2: 跑测试确认失败**：`bun test test/server.test.ts` → FAIL（模块不存在）
- [ ] **Step 3: 实现**
  - `package.json`：`name: codearts-bridge`、`type: module`、`exports: { "./server": "./src/server.ts" }`、`bin: { "codearts-bridge": "./src/cli.ts" }`、dependency `"@opencode/plugin": "2.2.3"`；devDependencies `typescript`；scripts：`test: bun test`、`typecheck: tsc --noEmit`
  - `tsconfig.json`：strict、moduleResolution bundler、types `bun-types`（或 `@types/bun`）
  - `src/server.ts`：`Plugin.define` + 注册 smoke 工具 `codearts_status`（返回 `{ ok: true, version: "dev" }`）
  - 安装依赖：`cd plugins/codearts-bridge && bun install`
- [ ] **Step 4: 跑测试确认通过（含 typecheck）**：`bun test`；`bun run typecheck`
- [ ] **Step 5: 加载验证（观察步骤，记录到任务完成说明）**
  1. 临时把插件加到全局 `~/.config/opencode/opencode.jsonc`（`"plugins": ["<worktree 绝对路径>/plugins/codearts-bridge"]`；若 2.1.4 不识别 `plugins` 则改试 `plugin`）——**先备份该文件**；
  2. 观察日志 `~/.local/share/opencode/log/opencode.log` 出现插件加载行；
  3. `opencode api get /api/info` 正常；如可用则查询工具列表接口确认 `codearts_status` 在列；
  4. 记录实测结论（键名/路径形式/依赖解析方式）到 `README.md` 的"加载方式（实测）"节；随后把全局配置**还原**（正式接入放 T4-01）。
- [ ] **Step 6: Commit**：`git add plugins/codearts-bridge && git commit -m "codearts-bridge(T1-01): 包骨架与加载验证 — 安装@opencode/plugin 2.2.3、smoke 工具、实测加载键名与依赖解析"`

### Task 2: 配置与状态根（T1-02）

**Files:**
- Modify: `src/core/config.ts`；Create: `test/config.test.ts`

**Interfaces:**
- Produces:
```ts
export interface BridgeConfig {
  installDir: string;           // 默认 ~/.codeartsdoer/installers
  stateDir: string;             // 默认 ~/.codearts-bridge
  transport: "auto" | "structured" | "pty";
  ptyHost: "auto" | "tmux" | "script";
  daemonUrl: string;            // 默认 http://127.0.0.1:4577
  akskFile: string;             // 默认 <stateDir>/config.env
  thresholds: { stallSeconds: number; retryCapSeconds: number; strikes: number; echoGuardMs: number };
  autoNudge: boolean;
}
export function loadConfig(overrides?: Partial<BridgeConfig>, env?: Record<string,string|undefined>): BridgeConfig;
export function ensureStateDirs(cfg: BridgeConfig): Promise<void>;   // state/{goals,audit,health,logs,tmp} 0700
export async function readAksk(file: string): Promise<{ AK?: string; SK?: string } | undefined>; // 缺失返回 undefined，绝不打印值
```
- Consumes: 无。

- [ ] **Step 1: 写失败测试** `test/config.test.ts`：
  - `defaults: installDir/stateDir/daemonUrl/thresholds 默认值正确`（阈值默认 `{ stallSeconds: 60, retryCapSeconds: 60, strikes: 3, echoGuardMs: 3000 }`）
  - `override precedence: overrides > env(CODEARTS_BRIDGE_*) > defaults`
  - `ensureStateDirs creates dirs with mode 0700（umask 无关断言）`
  - `readAksk parses KEY=VALUE env file; missing file -> undefined; never throws`
- [ ] **Step 2: 跑测试确认失败**：`bun test test/config.test.ts` → FAIL
- [ ] **Step 3: 实现**（纯函数优先；`os.homedir()` 经注入以便测试）
- [ ] **Step 4: 跑测试确认通过**：`bun test test/config.test.ts` + `bun run typecheck`
- [ ] **Step 5: Commit**：`codearts-bridge(T1-02): 配置与状态根 — 默认值/优先级/env 文件解析/0700 目录`

### Task 3: 安装状态探测（T1-03）

**Files:**
- Create: `src/core/errors.ts`、`src/core/install.ts`；Create: `test/install.test.ts`、`test/fixtures/install-fixtures.ts`

**Interfaces:**
- Produces:
```ts
export class BridgeError extends Error { code: string; remediation?: string; }  // code 如 BIN_MISSING_NO_BACKUP
export interface InstallStatus {
  path: string; present: boolean; version?: string; sha256?: string;
  backupPath: string; backupValid: boolean;
  autoupdateFlag?: boolean; drift: boolean;   // drift: 版本/哈希与钉版记录不一致
}
export async function probeInstall(cfg: BridgeConfig): Promise<InstallStatus>;
```
- Consumes: `BridgeConfig`（T1-02）；fixture 工厂 `makeInstallFixture(dir, kind: "healthy"|"missing"|"only-delete"|"bad-hash"|"bad-version")`。
- 命令执行注入：`interface Exec { run(cmd: string[]): Promise<{code:number; stdout:string; stderr:string}> }`，测试用 fake（不真跑二进制）；`--version` 解析 `26.10.9`。

- [ ] **Step 1: 写失败测试** `test/install.test.ts`：
  - `healthy: present=true, backupValid=true, drift=false`
  - `missing-with-valid-backup: present=false, backupValid=true（供 repair 使用）`
  - `only-delete: present=false, backupValid=false, 且 probe 不抛错`
  - `bad-hash: drift=true`
  - `autoupdate flag 读取 codearts_cli.json；true 时 status 中如实呈现`
  - Review-Focus-1 断言：`missing 且无备份时 probe 返回状态而非抛错；后续 repair 才给结构化错误`（T1-04 落实错误分支）
- [ ] **Step 2: 跑测试确认失败**：`bun test test/install.test.ts` → FAIL
- [ ] **Step 3: 实现**（文件系统读 + Exec 注入 + 钉版记录 `<stateDir>/pinned.json`；探测逻辑对每种 fixture 给出上述字段）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit**：`codearts-bridge(T1-03): 安装状态探测 — 五类 fixture、钉版/哈希/备份/autoupdate 全量状态`

### Task 4: 备份与自愈修复（T1-04）

**Files:**
- Create: `src/core/fsx.ts`；Modify: `src/core/install.ts`；Create/Modify: `test/fsx.test.ts`、`test/install.test.ts`

**Interfaces:**
- Produces:
```ts
// fsx.ts
export function sameDevice(a: string, b: string): Promise<boolean>;      // st_dev 比较
export async function atomicWriteFile(p: string, data: string | Uint8Array, mode?: number): Promise<void>; // 同目录 tmp+rename
export async function copyDeploy(src: string, dst: string, mode?: number): Promise<void>; // copy + fsync + chmod，禁 rename
export async function sha256File(p: string): Promise<string>;
// install.ts
export interface RepairResult { action: "restore-from-backup"; from: string; to: string; sha256: string; auditId: string; }
export async function repairInstall(cfg, exec: Exec, opts?: { fixAutoupdate?: boolean }): Promise<RepairResult>;
// 失败分支：BridgeError(code=BIN_MISSING_NO_BACKUP, remediation="官方安装包重装指引 + 升级入口链接")；BACKUP_INVALID_HASH
export async function ensureBackup(cfg, exec: Exec): Promise<void>;  // 备份缺失/失效则从当前有效二进制 copy 补齐
```
- Consumes: T1-03 的 `probeInstall`。

- [ ] **Step 1: 写失败测试**：
  - `fsx.test.ts`：`sameDevice(/tmp, <repo> .tmp) === false`（本机 ZFS 双数据集）；`copyDeploy 后目标哈希一致且 mode=755`；`atomicWriteFile 无半写（崩溃注入：写 tmp 后中断，目标仍完整）`
  - `install.test.ts` 新增：`repair: only-delete 场景从备份恢复成功（哈希+版本校验+auditId）`；`repair: 无备份 -> BridgeError(BIN_MISSING_NO_BACKUP) 含 remediation`；`repair: 备份坏哈希 -> BridgeError(BACKUP_INVALID_HASH)`；`ensureBackup: 缺失即补齐`；`repair fixAutoupdate: 显式动作把 true 修正为 false 并审计`
  - Review-Focus-1：`repair 对只读目录 -> 结构化 IO 错误含路径与原因`
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（审计写 `<stateDir>/audit/install.jsonl`：`{ts, kind:"repair", from, to, sha256, auditId}`）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit**：`codearts-bridge(T1-04): 备份与自愈 — 原子写/同数据集检查/copy 部署/显式错误分支/autoupdate 修正`

### Task 5: 受控升级（T1-05）

**Files:**
- Modify: `src/core/install.ts`；Create: `test/upgrade.test.ts`、`test/fixtures/fake-release.ts`

**Interfaces:**
- Produces:
```ts
export interface Release { version: string; url: string; hash: string; }   // 官方接口字段
export interface Fetcher { latest(): Promise<Release>; download(url: string, dest: string): Promise<void>; }
export const httpFetcher: Fetcher;   // 真实实现（ide.cn-north-4…/v1/release-info/latest + OBS 下载）
export interface UpgradeResult { from: string; to: string; sha256: string; stagingDir: string; auditId: string; }
export async function upgradeInstall(cfg, deps: { fetcher?: Fetcher; exec: Exec }, opts?: { version?: string }): Promise<UpgradeResult>;
```
- Consumes: T1-04 的 `fsx` 原语与 `ensureBackup`。

- [ ] **Step 1: 写失败测试** `test/upgrade.test.ts`（全部用 `fake-release.ts` 注入 Fetcher + fixture 二进制）：
  - `happy path: download->hash 校验->解压(fake tar: 实为 copy fixture)->同数据集暂存->copyDeploy->--version 验证->旧版转 bak->审计含 auditId`
  - **Review-Focus-2**：`staging 目录与 installDir 不同 st_dev -> BridgeError(STAGING_CROSS_DEVICE) 且不动现有安装`
  - `哈希不匹配 -> BridgeError(HASH_MISMATCH)，现有安装零变化（前后哈希断言）`
  - `解压失败（注入）-> 现有安装零变化`；`部署中断（注入 copyDeploy 失败）-> 原二进制仍在原位（零损坏断言）`
  - **Review-Focus-5**：`两个 upgrade 并发 -> 第二个 BridgeError(ALREADY_RUNNING)（single-flight）`
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现**（暂存强制 `<stateDir>/tmp/staging-<version>`；落地前 `sameDevice(staging, installDir)` 断言；步骤级审计 `upgrade.step`）
- [ ] **Step 4: 跑测试确认通过**
- [ ] **Step 5: Commit**：`codearts-bridge(T1-05): 受控升级 — 注入式 Fetcher、同数据集暂存、失败零损坏矩阵、single-flight`

### Task 6: 健康采样（T1-06）

**Files:**
- Create: `src/core/health.ts`；Create: `test/health.test.ts`

**Interfaces:**
- Produces:
```ts
export interface HealthSnapshot {
  rssBytes?: number;                 // 托管进程 RSS（来自注入的 PidProbe）
  dbBytes: number; walBytes: number; // cli-data/opencode.db(.wal)
  dumps: { files: number; bytes: number };   // dump-*.heapsnapshot
  logs: { bytes: number };
  lastErrors: string[];              // 最近 N 条 service=proxy-fetch|upgrade 错误摘要（含 ECONNRESET/timeout）
  kernelRssFromLog?: number;         // 解析 service=om "rssMB=…" 最近一条
}
export async function collectHealth(cfg, deps: { proc?: () => Promise<string> }): Promise<HealthSnapshot>;
```
- Consumes: T1-02 配置。

- [ ] **Step 1: 写失败测试**（fixture：假 cli-data 目录树 + 假 kernel 日志样本，含 `service=om "rssMB=525.64"` 与 `error fetch … ECONNRESET` 行）：
  - `sizes: db/wal/dumps/logs 字节数与文件数正确`
  - `kernelRssFromLog: 取最近一条 rssMB 并换算字节`
  - `lastErrors: 只收 ERROR 级、去重、最多 20 条、含 ECONNRESET 与 timeout`
  - `缺目录时不抛错（返回零值）`——注意：这是"容忍探测"而非掩盖（状态如实报告缺失）
- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现** → **Step 4: 通过**
- [ ] **Step 5: Commit**：`codearts-bridge(T1-06): 健康采样 — DB/WAL/转储/日志/内核自报 RSS/最近错误`

### Task 7: hygiene 治理（T1-07）

**Files:**
- Modify: `src/core/health.ts`；Create: `test/hygiene.test.ts`

**Interfaces:**
- Produces:
```ts
export type HygieneAction = { kind: "purge-dumps"; files: string[] } | { kind: "wal-checkpoint" } | { kind: "rotate-logs"; keep: number };
export async function planHygiene(cfg, opts: { olderThanDays?: number; logsKeep?: number }): Promise<HygieneAction[]>;
export async function applyHygiene(cfg, actions: HygieneAction[]): Promise<{ applied: string[]; auditId: string }>;
```
- Consumes: T1-06 的采集；`bun:sqlite` 用于 WAL checkpoint。

- [ ] **Step 1: 写失败测试**：
  - `plan purge-dumps 仅列超过 olderThanDays 的 dump-*.heapsnapshot（dry-run 列表 = apply 实际删除清单，逐一断言）`
  - `wal-checkpoint: 预置含 WAL 的 sqlite 文件，apply 后 wal 尺寸显著下降且数据完整（重开可读）`
  - `rotate-logs: 保留最近 keep 个 kernel-*.log，其余删除（清单一致）`
  - `apply 记录审计 hygiene.apply（含删除清单）`
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: Commit**：`codearts-bridge(T1-07): hygiene — dumps 清理/WAL checkpoint/日志轮转，dry-run 与执行清单一致`

### Task 8: M1 工具接线与验收（T1-08）

**Files:**
- Modify: `src/server.ts`；Create: `test/m1-acceptance.test.ts`

**Interfaces:**
- Produces（工具集，全部接线到 T1-02~T1-07）：
  - `codearts_status` → `probeInstall` + `collectHealth` 摘要 + 传输/守护占位信息
  - `codearts_repair({ fixAutoupdate?: boolean })` → 权限门 → `repairInstall` → `ensureBackup`
  - `codearts_upgrade({ version?: string })` → 权限门 → `upgradeInstall`
  - `codearts_health()` → `collectHealth`
  - `codearts_hygiene({ apply?: boolean, olderThanDays?, logsKeep? })` → 计划/执行（apply 走权限门）
  - 每个工具 `execute` 返回 `{ content }`：JSON 摘要 + 人类可读文本；错误以 BridgeError 结构化为 `content`（含 code/remediation），**不抛裸异常**。
- Consumes: M1 全部模块。

- [ ] **Step 1: 写失败测试** `test/m1-acceptance.test.ts`（fake ctx 捕获 editor，直调各 `execute`）：
  - `status 返回五类 fixture 的正确摘要（表驱动）`
  - `repair 在 only-delete 场景恢复成功且返回 auditId`；`无备份场景返回 code=BIN_MISSING_NO_BACKUP 且含 remediation 文本`
  - `upgrade 权限门：permission.assert 被调用的 action/resource 断言`
  - `hygiene apply=false 只返回计划；apply=true 走权限门且执行清单=计划清单`
  - 每个工具注册名与 namespace 精确断言（`status/repair/upgrade/health/hygiene`，namespace `codearts`）
- [ ] **Step 2: 跑测试确认失败**
- [ ] **Step 3: 实现接线**（工具名不带前缀，由 namespace 组合；schema 用 JSON Schema 严格 `additionalProperties: false`）
- [ ] **Step 4: 全量验证**：`bun test`（M1 全部）+ `bun run typecheck`；随后在真实 opencode 会话里对五个工具做一次手工冒烟（记录命令与输出到任务说明）
- [ ] **Step 5: Commit**：`codearts-bridge(T1-08): M1 工具接线与验收 — 五工具+权限门+结构化错误，M1 全绿`

---

## M2 · 传输与运行

### Task 9: 传输接口与 fake（T2-01）

**Files:**
- Create: `src/core/transport/types.ts`、`src/core/transport/fake.ts`；Create: `test/transport-fake.test.ts`

**Interfaces:**
- Produces:
```ts
export type TransportKind = "structured" | "pty";
export interface Signal { t: "output" | "error" | "idle" | "step" | "done"; at: number; text?: string; }
export interface SessionRef { kind: TransportKind; id: string; }
export interface CodeartsTransport {
  kind: TransportKind;
  start(cfg: BridgeConfig, ref?: SessionRef): Promise<SessionRef>;
  inject(ref: SessionRef, text: string): Promise<void>;
  observe(ref: SessionRef, opts?: { signal?: AbortSignal }): AsyncIterable<Signal>;
  alive(ref: SessionRef): Promise<boolean>;
  stop(ref: SessionRef): Promise<void>;
  snapshot(ref: SessionRef): Promise<{ raw: string; meta: Record<string, unknown> }>;
}
export class FakeTransport implements CodeartsTransport { /* 脚本化信号/注入记录/存活开关 */ }
```
- Consumes: T1-02 配置类型。

- [ ] **Step 1: 写失败测试**：
  - `FakeTransport.observe 按脚本依次产出信号；inject 记录 (text) 与调用顺序；alive 可切换；stop 后 observe 结束`
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: Commit**：`codearts-bridge(T2-01): 传输接口与 FakeTransport — 脚本化信号/注入留痕/可切换存活`

### Task 10: PTY 宿主 · script(1)（T2-02）

**Files:**
- Create: `src/core/transport/pty-script.ts`；Create: `test/transport-script.test.ts`、`test/fixtures/fake-codearts/fake-tui.sh`

**Interfaces:**
- Produces：
```ts
export function createScriptTransport(exec: { spawnPty(args: string[], env: NodeJS.ProcessEnv): PtyChild }): CodeartsTransport;
export interface PtyChild { pid: number; onData(cb: (chunk: string) => void): void; write(data: string): void; kill(): void; alive(): boolean; }
```
- 注入两段式：`write(text)` → 120ms → `write("\r")`（v0.2.6 教训：文本+回车同块会被当粘贴吞掉）。
- 日志信号源：tail `<KERNEL_DATA_DIR>/log/kernel-*.log` 增量，`service=` 行作为 output 信号补充（spec F5 信号优先级）；日志源不可用（无文件/轮转）不影响运行，来源可用性在 `snapshot.meta` 中如实标注。
- Consumes: T2-01 接口。

- [ ] **Step 1: 写失败测试**（`fake-tui.sh`：读到文本回显 `[RX:<text>]`；单独收到 `\r` 打印 `[ENTER]`；支持 `--scenario stall|error|exit`）：
  - `two-step submit: 断言 fake-tui 收到两次独立写入（文本与回车分离，120ms 间隔可注入时钟）`
  - `observe: 回显与 [ENTER] 依序成为 output 信号`
  - `log tail: fake-tui 向日志文件追加 service=om 行 -> observe 产出对应 output 信号；日志文件缺失 -> 来源标记不可用且不抛错`
  - `exit 场景：进程死后 alive()=false 且 observe 结束（不挂起）`
  - `stop: 调 kill 且 PID 回收`
- [ ] **Step 2~4: TDD 循环**（PTY 读取用 `script -qefc` 包装实跑 fixture；测试允许真实 spawn bash fixture，但禁止依赖网络）
- [ ] **Step 5: Commit**：`codearts-bridge(T2-02): script(1) PTY 宿主 — 两段式提交/信号化读取/请求级存活检查`

### Task 11: PTY 宿主 · tmux（T2-03）

**Files:**
- Create: `src/core/transport/pty-tmux.ts`；Create: `test/transport-tmux.test.ts`

**Interfaces:**
- Produces：`export function createTmuxTransport(cfg, exec): CodeartsTransport;`；会话命名 `codearts-<slug>`；`start` 幂等（已存在则重连）；`snapshot` 用 `capture-pane -p`。
- Consumes: T2-01；tmux 探测：`mkdirpx().available()`。

- [ ] **Step 1: 写失败测试**（注入 tmux 命令执行器 fake；`tmux` 不存在时覆盖显式错误）：
  - `tmux 缺失 -> BridgeError(PTY_HOST_UNAVAILABLE, remediation="sudo apt install tmux 或 ptyHost=script")`（不静默降级）
  - `start 幂等：new-session 已存在 -> list-sessions 命中 -> 重连不重建`
  - `inject: send-keys 序列 = [文本, Enter] 两次独立调用`
  - `kill-session 后 alive=false`
  - 有 tmux 环境（`which tmux`）时：标记 `describe.skipIf(!hasTmux)` 真机用例一套（attach 语义不测）
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: Commit**：`codearts-bridge(T2-03): tmux PTY 宿主 — 幂等重连/两段式注入/显式缺失错误/条件真机用例`

### Task 12: structured 传输（T2-04）

**Files:**
- Create: `src/core/transport/structured.ts`；Create: `test/transport-structured.test.ts`、`test/fixtures/fake-codearts/fake-run.ts`

**Interfaces:**
- Produces：
```ts
export function createStructuredTransport(cfg, exec, aksk?: { AK?: string; SK?: string }): CodeartsTransport;
// 每回合 spawn: <installDir>/bin/codearts run <prompt> --format json --print-logs（新会话首次）
//               … --session <id>（续接）；env 注入 AK/SK（仅存在时）
export function classifyError(line: string): "retryable" | "fatal" | undefined; // ECONNRESET/timeout/429/503 -> retryable；认证失败 -> fatal
```
- Consumes: T2-01 接口；T1-02 `readAksk`。

- [ ] **Step 1: 写失败测试**（`fake-run.ts` 按 `--scenario` 输出 JSONL 事件：`session.id`/`message.part`/`error`/退出码）：
  - `events -> signals: output/step/error 归类正确，done 于进程退出且 exit=0`
  - `session id 捕获：首回合从事件提取并复用为后续 --session 参数（断言 argv）`
  - `error 分类：ECONNRESET/timeout/429 -> retryable；认证失败（AK/SK 缺）-> fatal + BridgeError(AKSK_MISSING) 当 aksk 为空时 start 前置检查直接拒绝（显式）`
  - `进程中途崩溃（exit≠0 无 done）-> observe 产出 error 信号且进程句柄可回收`
  - `AK/SK 注入：子进程 env 含注入值（fake-run 打印 env 键存在性，不打印值）`
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: Commit**：`codearts-bridge(T2-04): structured 传输 — JSONL 事件解析/会话续接/错误分级/AK-SK 前置检查`

### Task 13: `codearts_run` 工具与 M2 验收（T2-05）

**Files:**
- Modify: `src/server.ts`；Create: `test/run-tool.test.ts`

**Interfaces:**
- Produces：`codearts_run({ prompt, session?, timeoutMs? })`：`transport` 由配置选择（auto：有 AK/SK→structured，否则→pty）；`context.progress({status})` 每 2s 或每信号批次更新；`context.signal` 触发 `stop()`；返回 `{ session, summary, signals: n, auditId }`；审计 `run.start/run.exit`。
- Consumes: T2-01~T2-04、T1-08 权限模式。

- [ ] **Step 1: 写失败测试**（fake 传输 + fake ctx）：
  - `auto 选择逻辑：aksk 存在->structured；缺失->pty；并在返回值中说明所选模式与原因`
  - `progress 至少被调用一次且含状态文本；signal abort -> stop() 被调`
  - `错误路径：transport 报 retryable 错误 -> 工具返回可重试标记与摘要（不静默重试——重试属目标引擎职责）`
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: M2 验收**：`bun test` 全绿 + `typecheck`；PTY 真机冒烟：用 `script` 宿主对真实 codearts 注入一轮并捕获输出（记录到任务说明；不要求完成对话）
- [ ] **Step 6: Commit**：`codearts-bridge(T2-05): codearts_run 工具 — auto 传输选择/进度/取消/显式错误，M2 全绿`

---

## M3 · 目标引擎

### Task 14: 守护进程骨架与 API（T3-01）

**Files:**
- Create: `src/daemon.ts`、`src/cli.ts`；Create: `test/daemon.test.ts`

**Interfaces:**
- Produces：
```ts
export function createDaemon(cfg): { server: http.Server; start(): Promise<{port:number}>; stop(): Promise<void> };
// 端点：GET /health；鉴权 Authorization: Bearer <stateDir/daemon-token>（自动生成 0600）
// CLI：codearts-bridge daemon（前台）；codearts-bridge status
```
- Consumes: T1-02 配置/状态根。

- [ ] **Step 1: 写失败测试**（`fetch` 打临时端口）：
  - `GET /health 无 token -> 401；带正确 token -> 200 {ok:true, version, uptime}`
  - `token 文件首启生成 0600；重启复用`
  - `未知路由 404 且响应体为结构化 JSON`
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: Commit**：`codearts-bridge(T3-01): 守护骨架 — 令牌鉴权/健康端点/CLI 前台模式`

### Task 15: 完成协议移植（T3-02）

**Files:**
- Create: `src/core/goal/protocol.ts`；Create: `test/protocol.test.ts`

**Interfaces:**
- Produces：
```ts
export const GOAL_PLAN_MARK = "[GOAL-PLAN]"; export const GOAL_DONE_MARK = "[GOAL-DONE]";
export const CONTINUE_PROMPT = "继续完成剩余任务";
export function buildContract(objective: string, verify: string[]): string;
export function buildResumeContract(state: { objective: string; doneSteps: number[]; totalSteps?: number }): string;
export function parseProgress(text: string): { plan?: string[]; steps: { n: number; title: string }[]; done: boolean };
export function stripInjectionEcho(text: string, injected: string[]): string;
export function hasRealContent(text: string): boolean;  // 逐字符 isLetterOrNumber + CJK 区间（v0.2.6 教训）
```
- 移植源：`/home/wsc/codeartsGUI/src/goalprotocol.cpp` 与 `tests/test_goalrunner.cpp`（22 用例语义逐条搬运）。
- Consumes: 无（纯函数）。

- [ ] **Step 1: 写失败测试**（用例名对齐 C++ 原语义）：
  - `contract contains objective, verify commands, [GOAL-PLAN]/[GOAL-DONE] 说明`
  - `parseProgress: 步骤行 "n/N … | 推荐方案: …" 解析；[GOAL-DONE] 置 done`
  - `echo guard: 注入文本回显（含 [GOAL-DONE] 字样）剥离后不产生 done`
  - `hasRealContent: 纯 CSI/私有标记/退格符 -> false；CJK/字母数字 -> true`
  - `stripAnsi 类边界：ESC[?25h 私有标记整体消费（v0.2.6 修过的 bug 回归）`
- [ ] **Step 2~4: TDD 循环**（对照 C++ 用例表逐条勾）
- [ ] **Step 5: Commit**：`codearts-bridge(T3-02): 完成协议移植 — 契约/步骤解析/回显守卫/ANSI 边界，对齐 22 用例语义`

### Task 16: 监督状态机（T3-03）

**Files:**
- Create: `src/core/goal/runner.ts`；Create: `test/runner.test.ts`

**Interfaces:**
- Produces：
```ts
export type GoalPhase = "active" | "paused" | "blocked" | "complete" | "stopped";
export interface GoalState { goalId: string; objective: string; verify: string[]; phase: GoalPhase; rounds: number; steps: number[]; strikes: number; injected: string[]; lastProgressAt: number; session?: SessionRef; auditId?: string; }
export interface RunnerDeps { clock: { now(): number }; transport: CodeartsTransport; audit(e: object): void; log(e: object): void; thresholds: BridgeConfig["thresholds"]; verifyRun?(cmd: string[]): Promise<{ok:boolean; out:string}>; }
export class GoalRunner {
  constructor(init: GoalState, deps: RunnerDeps);
  tick(): Promise<GoalState>;                  // 纯 tick；测试用假时钟推进
  pause(): void; resume(): Promise<GoalState>; stop(): Promise<GoalState>;
  state(): Readonly<GoalState>;
}
```
- 规则（spec §6.3.2）：停滞 60s→注入 `CONTINUE_PROMPT`；错误（signal t=error 且 retryable）→重试（无次数上限，间隔 60s 封顶，连续≥10 告警）；进程死→`stop+start` 重建+`buildResumeContract`；strikes≥3 告警不终止；done+verify 双过→complete；paused 不 tick 注入。
- Consumes: T3-02 协议、T2-01 FakeTransport。

- [ ] **Step 1: 写失败测试**（假时钟 + FakeTransport 脚本；每条=一个回归用例）：
  - `stall: 无新信号推进 60s -> 注入 CONTINUE_PROMPT（一次）；再 60s 无进展 -> 再注入`
  - `fast output: 3s 内 >=12 块 -> 不打断（不注入）`
  - `重绘欺骗：文本重复重绘不刷新 lastProgressAt（指纹=文本变化量+步骤推进）`
  - `error retryable: 立即重试；连续失败 -> 退避 60s 封顶；10 次后告警事件（不停止）`
  - `error fatal: 转 blocked（等人工），审计原因`
  - `process death: alive=false -> 重建会话 + buildResumeContract 注入（断点续跑）`
  - `strikes: 连续 3 次恢复无进展 -> strike>=3 告警；此后仍继续重试`
  - `done double-pass: done 标记 + verifyRun ok -> complete；verify fail -> 注入失败原因继续`
  - **Review-Focus-5**：`pause 与 tick 并发：pause 后并发 tick 不产生注入（串行化断言）`
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: Commit**：`codearts-bridge(T3-03): 监督状态机 — 停续/无限重试/进程死续跑/双过验收/strikes/并发串行化`

### Task 17: 持久化与对账（T3-04）

**Files:**
- Create: `src/core/goal/state.ts`；Modify: `src/daemon.ts`；Create: `test/state.test.ts`

**Interfaces:**
- Produces：
```ts
export async function saveGoal(stateDir, s: GoalState): Promise<void>;   // atomicWriteFile
export async function loadGoals(stateDir): Promise<GoalState[]>;
export async function appendAudit(stateDir, goalId: string, e: object): Promise<string>; // 返回 auditId
export async function reconcile(stateDir, deps: { transport: CodeartsTransport }): Promise<{ resumed: string[]; blocked: string[] }>;
// reconcile：未终态目标 -> alive(session) 则续 tick；否则重建会话+断点契约；幂等（不双注入：以 injected 指纹去重）
```
- Consumes: T3-03 状态与 T1-04 fsx。

- [ ] **Step 1: 写失败测试**：
  - `atomic save/load 往返一致；损坏 JSON -> 标记该目标 blocked 并审计（不崩守护）`
  - `appendAudit 追加且顺序保持；并发追加不交错（单文件锁串行）`
  - **Review-Focus-4**：`reconcile 幂等：连续两次 reconcile 同目标 -> 第二次不注入（injected 指纹去重）`
  - `reconcile: 会话死 -> 重建+断点契约；重建失败 -> blocked+fatal 审计`
- [ ] **Step 2~4: TDD 循环**（守护接入：启动时 reconcile，周期 tick 集成测试在 T3-05）
- [ ] **Step 5: Commit**：`codearts-bridge(T3-04): 持久化与对账 — 原子状态/审计留痕/幂等恢复`

### Task 18: 守护-目标对接（T3-05）

**Files:**
- Modify: `src/daemon.ts`；Create: `test/daemon-goals.test.ts`

**Interfaces:**
- Produces（完成 spec §7.2 API）：
  - `POST /goals { objective, verify?, workdir?, maxRounds? }` → 建 GoalState+启动 tick 循环（setInterval 5s + 事件驱动）→ `{ goalId }`
  - `GET /goals`、`GET /goals/:id`、`GET /goals/:id/logs?cursor=`、`POST /goals/:id/control { action }`
- Consumes: T3-03/T3-04、T2-01（transport 注入以便测试）。

- [ ] **Step 1: 写失败测试**（daemon + FakeTransport + 假时钟驱动）：
  - `start -> status 到 complete 全流程（fake 完成脚本）`
  - `control pause -> phase=paused 且不再注入；resume -> 注入继续；stop -> 终态`
  - `logs 分页：cursor 前进、顺序稳定`
  - `并发 start 两个目标互不影响（独立状态隔离）`
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: Commit**：`codearts-bridge(T3-05): 守护目标 API — 全流程/控制/日志分页/多目标隔离`

### Task 19: 插件目标工具与回呼（T3-06）

**Files:**
- Modify: `src/server.ts`；Create: `test/goal-tools.test.ts`

**Interfaces:**
- Produces：`codearts_goal_start/status/list/logs/control`（经 `daemonUrl` HTTP）；`codearts_daemon_status`（未运行→安装/启动指引，显式）；回呼：插件轮询 30s，目标终态/告警→`ctx.session.synthetic`（尽力通知，失败仅审计）。
- Consumes: T3-05 API、T1-08 工具模式。

- [ ] **Step 1: 写失败测试**（注入 fake fetch）：
  - `goal_start 代理 POST 并返回 goalId；daemon 拒绝（连接失败）-> BridgeError(DAEMON_UNAVAILABLE, remediation 含启动命令)`
  - `回呼：终态事件后 synthetic 被调用一次；session 缺失->仅审计`
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: Commit**：`codearts-bridge(T3-06): 目标工具与回呼 — 守护代理/显式不可用错误/终态通知`

### Task 20: systemd 服务与 watchdog（T3-07）

**Files:**
- Create: `src/core/service.ts`；Modify: `src/cli.ts`；Create: `test/service.test.ts`

**Interfaces:**
- Produces：`codearts-bridge service install|status|uninstall`；生成 `~/.config/systemd/user/codearts-bridge.service`（`Restart=always`）+ `codearts-bridge-watchdog.timer`（每分钟；探活逻辑仿 `bin/dsh-watchdog-probe.sh`：连续 2 次 HTTP 无响应→`systemctl --user restart`）。
- Consumes: T3-01 守护。

- [ ] **Step 1: 写失败测试**：`unit 文件生成内容断言（ExecStart 绝对路径、Restart=always、日志路径）`；`watchdog 脚本生成 + shellcheck 可读（bash -n）`；`install 幂等（重复执行不重复写）`
- [ ] **Step 2~4: TDD 循环**
- [ ] **Step 5: 真机安装观察步骤**（记录到任务说明）：`service install` → `systemctl --user daemon-reload && start` → `systemctl --user status` 绿；kill -9 守护 → 自动拉起；随后**保留安装**（M4 落地需要）
- [ ] **Step 6: Commit**：`codearts-bridge(T3-07): systemd 服务与 watchdog — 自愈单元/探活重启/幂等安装`

### Task 21: M3 故障矩阵（T3-08）

**Files:**
- Create: `test/matrix.test.ts`

**Interfaces:**
- Consumes: 全部 M3。

- [ ] **Step 1: 写矩阵测试**（daemon+插件层，FakeTransport/可控注入；每格为独立用例）：
  1. 模型错误（连续 retryable）→不停止直至完成（fake 第 5 次成功）
  2. 网络类错误注入（ECONNRESET/timeout 事件）→同上
  3. 杀回合进程（alive=false）→重建+断点续跑→完成
  4. 杀守护（stop+重新 start）→reconcile→续跑→完成（幂等断言）
  5. opencode 服务重启（插件重载：setup 重跑）→守护不受影响，工具恢复可用
  6. 回显防护（PTY 脚本注入含 `[GOAL-DONE]` 回显）→不误判
  7. 双过验收（自报 done + verify 命令失败→继续；再成功→complete）
  8. pause/resume/stop 在活跃目标上即时生效
- [ ] **Step 2: 全部通过**：`bun test` 全绿 + `typecheck`
- [ ] **Step 3: Commit**：`codearts-bridge(T3-08): M3 故障矩阵 — 八格全过，永不挂起语义闭环`

---

## M4 · 落地

### Task 22: 全局接入与使用文档（T4-01）

**Files:**
- Modify: `~/.config/opencode/opencode.jsonc`（备份后加插件条目，实测键名以 T1-01 结论为准）；Modify: `plugins/codearts-bridge/README.md`

**Interfaces:**
- Consumes: 全部。

- [ ] **Step 1: 全局接入**：备份全局配置 → 添加插件绝对路径条目 → 重启/重载 opencode 服务（`opencode service restart`）→ 在真实会话验证 `codearts_status` 可见可用（记录证据）
- [ ] **Step 2: README 完稿**：安装/加载/配置项/工具速查/AK-SK 配置指引（含门户链接与 `config.env` 示例）/tmux 可选说明/故障排查（daemon 未启动、PTY 宿主缺失、升级失败零损坏恢复）/审计与状态文件位置
- [ ] **Step 3: Commit**：`codearts-bridge(T4-01): 全局接入与使用文档 — opencode 加载实测结论、AK-SK/守护/排障说明`

### Task 23: 真机验收（T4-02）

**Files:**
- Create: `plugins/codearts-bridge/.tmp/acceptance-log.md`（证据记录，.tmp 不提交；完成摘要进操作记录）

- [ ] **Step 1: 真机小目标（PTY 模式）**：真实 codearts TUI + 一个可在 15 分钟内完成的小目标（含 verify 命令）；记录：轮次、注入、完成验收、审计摘录
- [ ] **Step 2: 中断演练**：目标进行中 `kill -9` 会话进程 → 自动重建续跑至完成；`kill -9` 守护 → systemd 拉起 + 对账续跑；全程录像/日志留证
- [ ] **Step 3: 若用户已配置 AK/SK**：structured 真机冒烟（`codearts_run` 一轮 + 小目标）；否则在报告中如实标注"未配置，PTY 已验收"（不虚报）
- [ ] **Step 4: 验收判据核对**（spec §10.1 M2/M3 判据逐条勾选）
- [ ] **Step 5: Commit**（无代码变更则记录摘要到操作记录任务）

### Task 24: 操作记录与经验沉淀（T4-03）

**Files:**
- Create: `操作记录/codearts-bridge集成落地-<日期>-操作日志记录.md`

- [ ] **Step 1: 按仓库规范写操作日志**（任务背景与验收判据/实施步骤/验证证据/问题与根因/经验总结/关联提交与文档）
- [ ] **Step 2: 高复用经验入经验库**（安装"先改名后部署"防护、跨 ZFS 数据集 copy 部署、PTY 两段式提交、opencode V2 插件加载实测结论）
- [ ] **Step 3: 最终验证**（chinasim-verification 手法）：`bun test` + `typecheck` + 真机证据复核 + spec 验收判据逐条对勾；产出完成摘要
- [ ] **Step 4: Commit**：`codearts-bridge(T4-03): 操作记录与经验沉淀 — 项目 A 完成，验收判据全过`

---

## 执行方式与纪律

- **执行方法：Subagent-driven**（仓库律：主 agent 监督、子 agent 实施）。每个任务派一个子 agent（prompt 自包含：任务卡全文 + 全局约束 + 工作区路径 + "禁止提问、自主决策"声明）；主 agent 在任务返回后：跑该任务测试 + 读 diff + 核对验收，再进入下一任务；每个里程碑结束做一次汇总评审（fresh reviewer 子 agent 或主 agent 交叉验证）。
- **回滚点**：每个任务的 Commit 即回滚点；里程碑回滚=回退到 M 起点提交。
- **风险（Top2）**：① `@opencode/plugin` 2.2.3 在 opencode 2.1.4 加载方式与文档有出入——T1-01 先行实测消险；② 真机 codearts 行为（登录态/网络）受厂商侧影响——fakes 全量先行，真机仅作验收冒烟。
- **不阻塞项**：AK/SK 未配置 → PTY 路径全量交付；tmux 未安装 → script 宿主全量交付。二者均不影响 M1–M4 完成。
- **范围登记（延后项）**：PTY 模式"空闲软重启"（spec §6.4 治理可选项）不在本计划内——结构化回合制已覆盖内存复位主路径，PTY 侧可由目标级重建（kill+断点续跑）覆盖；如实登记为后续增强。
