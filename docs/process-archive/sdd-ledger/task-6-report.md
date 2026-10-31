# Task 6（T1-06）健康采样 — 实施报告

- **Status**: DONE
- **Commit**: `c0a855b0cd` `codearts-bridge(T1-06): 健康采样 — DB/WAL/转储/日志/内核自报 RSS/最近错误`
- **分支**: `codearts-bridge`（worktree `/home/wsc/.local/share/opencode/worktree/e5785e/codearts-bridge`，主检出未触碰）

## 1. 实现内容

### `src/core/health.ts`（新增，392 行）

导出：

```ts
export interface HealthSnapshot {
  rssBytes?: number;                       // PidProbe 注入（R-h5）
  dbBytes: number; walBytes: number;       // opencode.db / opencode.db-wal
  dumps: { files: number; bytes: number }; // dump-*.heapsnapshot
  logs: { bytes: number };                 // log 目录递归总字节
  lastErrors: string[];                    // ≤20 条规范化错误摘要
  kernelRssFromLog?: number;               // 最近一条 rssMB 换算字节（R-h2）
}
export interface CollectHealthOptions {
  kernelDataDir?: string;            // R-h3：函数参数，未扩展 BridgeConfig
  proc?: () => Promise<string>;      // R-h5：十进制整数字节串（显式约定唯一形态）
}
export async function collectHealth(cfg: BridgeConfig, opts: CollectHealthOptions = {}): Promise<HealthSnapshot>;
export const HEALTH_MAX_LAST_ERRORS = 20;
export const HEALTH_MAX_ERROR_SUMMARY_CHARS = 500;
export const HEALTH_ERROR_KEYWORDS: readonly string[]; // error fetch/ECONNRESET/timed out/TimeoutError
```

主控裁定落点（均已写入代码注释）：

- **R-h1**：采集 = `ERROR` 前缀行 ∪ 含关键词的 `INFO`/`WARN` 行；规范化摘要 = 剥离易变字段（时间戳/耗时，保留 `SEV <rest>`）→ 超 500 字符截断并附 `…[截断,原长=N字符]` 显式标记（禁静默截断）→ 按剥离后文本去重、重复出现记 `×N`（保留最后出现时间参与排序，防"20 槽被同一错误刷屏"）→ 上限 20 → 按内嵌时间戳升序输出；行结构不符裁定时原样上报（异常格式如实保留而非丢弃）。行解析正则严格对齐真实格式 `SEV␣␣<ISO> +<dur> service=…`。
- **R-h2**：`service=om "当前进程内存使用情况" rssMB=<n>` 按**扫描序**取最后一条（文件 mtime 升序→文件内行序），`Math.round(MB×1024×1024)`。
- **R-h3**：`kernelDataDir` 为函数参数，缺省 `~/.codeartsdoer/cli-data`（`homedir()` 推导）；`BridgeConfig` 未动。
- **R-h4**：ENOENT → 对应字段零值/`undefined` 不抛（头注写明这是"只读状态采集语义而非掩盖错误"）；非 ENOENT（ENOTDIR/EACCES…）→ 显式抛 `BridgeError`。db/wal 路径存在但非常规文件 → `FS_PATH_NOT_FILE`（同 install.ts 纪律）。
- **R-h5**：`proc` 输出显式约定为**十进制整数字节字符串**（前后空白容忍；`abc`/`-5`/`12.5`/空串 → `PID_PROBE_INVALID`，禁静默解析）；proc 拒绝 → `PID_PROBE_FAILED` 且 cause 保留；未注入 → `rssBytes=undefined`。
- **隔离**：纯只读，无任何写入；测试 fixture 全在插件 `.tmp/health-test/`，`afterAll` 清理，绝不触碰真实 HOME。

新错误码：`HEALTH_LOG_READ_FAILED`、`PID_PROBE_INVALID`、`PID_PROBE_FAILED`；复用 `FS_READ_FAILED`/`FS_STAT_FAILED`/`FS_PATH_NOT_FILE`。

### 勘查确证（网络/实物检索台账）

| 结论 | 证据 |
|------|------|
| WAL 文件名为 `opencode.db-wal`（非任务书字面 `.wal` 歧义解） | ① 内核二进制 `strings` 出现 `opencode.db-wal`/`opencode.db-shm`；② 本机存在实文件 `~/.codeartsdoer/codearts-data/opencode.db-wal` |
| kernel 日志行格式与裁定样本一致 | 真实 `~/.codeartsdoer/cli-data/log/kernel-*.log` 抽样：`INFO  <ISO> +<dur> service=om "当前进程内存使用情况" rssMB=252.20 …`、`ERROR  … service=custom-model-auth "request failed" … status=403` |
| `experience-*.log` 为异构格式（`[日期] [级别] …`），不纳入解析、计入目录总字节 | 真实文件头部抽样 |
| dumps 位于 `log/` 顶层，真实环境 6 件 1.3GB | `ls`/`awk` 统计，与采样输出逐位一致 |

### 口径决策（歧义自主裁决，均已在注释声明）

1. **logs.bytes = log 目录递归总字节**（含 dumps 子集）：任务书原文"logs=log 目录总字节"取字面义；dumps 是其中最劣子集的单列分解（二者非互斥）。真实环境验证：2,333,906,250 与 `du -sb` 逐位一致。
2. **去重语义 = 剥离时间戳/耗时后按文本去重 + ×N 计数**：带原始时间戳的"去重"永远去不掉重复错误（时间必不同），与裁定"去重"意图矛盾；×N 保留频率信息（痛点②可观测化的核心信号），非静默折叠。
3. **kernelRssFromLog"最近一条"= 扫描序最后匹配**（R-h2 原文"按行序取最后匹配"）：非内嵌时间戳序；测试特意用 mtime 新/内嵌时间戳旧的用例钉死该语义。
4. **符号链接不计入目录字节、不下探**：目录总量口径固定为"常规文件字节和"，防外逃与环；竞态删除的文件按不存在计（日志轮转常态）。

## 2. TDD 证据

- **RED**：`bun test test/health.test.ts` → `error: Cannot find module '../src/core/health'`，0 pass / 1 fail（模块未实现，符合预期）。
- **GREEN**：实现后聚焦 11 pass / 0 fail（72 expect）；全量 `bun test` **115 pass / 0 fail**（原 104 + 新增 11），`bun run typecheck` 零错误。
- 过程中 typecheck 报 2 错（`Dirent` 导入源、`noUncheckedIndexedAccess` 下 `m[2]` 索引守卫），已修复后复跑全绿。

## 3. 真实环境只读演练（非测试，一次性脚本用后即删）

对本机真实 `~/.codeartsdoer/cli-data`（52 个 kernel 日志/325MB，db 1.1GB，dumps 1.3GB）跑 `collectHealth`：

- `dbBytes=1113268224`（与 `ls -la` 一致）；`walBytes=0`（当前无活动 WAL，缺失→0 生效）
- `dumps={files:6, bytes:1302015607}`、`logs.bytes=2333906250` —— 与 shell 统计**逐位一致**
- `lastErrors` 20 条：含真实 403/remote-session/proxy-fetch 错误，截断标记 `…[截断,原长=649字符]` 生效
- `kernelRssFromLog=176213197`（≈168MB，最近一条自报 rssMB=168.02 换算正确）
- **实测采样耗时 14.4s**（全量流式扫 325MB）——已如实写入头注性能注记（见"遗留"）

## 4. 文件清单

| 文件 | 变更 |
|------|------|
| `plugins/codearts-bridge/src/core/health.ts` | 新增 392 行（≤1000 ✓） |
| `plugins/codearts-bridge/test/health.test.ts` | 新增 300 行、11 用例 |

## 5. 自审发现

- **测试真实性**：fixture 用裁定提供的真实样本行原样（含 `error fetch`/`ECONNRESET`/`TimeoutError`/403 三条）；mtime 用 `utimes` 固定消除顺序依赖；>20 条用例程序化生成 25 条可预测序列。
- **YAGNI**：未做增量扫描、未给 lastErrors 加结构化时间戳字段（接口保持 `string[]`）、未扩展 BridgeConfig——均为 M2 决策点。
- 一个小的语义余量：`scanLogFile` 把 `onLine` 异常也包成 `HEALTH_LOG_READ_FAILED`——`onLine` 是纯状态更新不会抛，语义无实际影响。

## 6. 遗留问题/担忧

1. **采样耗时 14.4s（真实环境）**：全量扫读 325MB 的最小正确实现。M2 接入托管进程时应做增量扫描（按文件 offset 续扫）或限制采样频率；已在头注与提交信息记录实测数据，供 M2 设计依据。
2. **kernelRssFromLog 的"扫描序"依赖 mtime**：同秒内多文件轮转时 tie-break 退化为文件名序（极端边界，健康采样可接受）；增量扫描落地后自然消除。
3. **无 default 路径的直接测试**：按隔离裁定（不触碰真实 HOME），缺省 `~/.codeartsdoer/cli-data` 分支无测试覆盖（`homedir()` 不可注入）；所有测试走显式 `kernelDataDir`，缺省分支仅一行 `??` 拼接，风险极低。
