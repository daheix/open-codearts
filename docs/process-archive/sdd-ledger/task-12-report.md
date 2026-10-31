# Task 12 报告 — T2-04 structured 传输（回合=进程）

- **Status: DONE**
- **Commit: `b5be623412`**（分支 `codearts-bridge`，BASE `4797bfb3eb`）
- 日期：2026-10-31 · 实施者：实施子代理（无用户交互通道，全程按任务派发上下文自主决策）

## 1. 实现内容

### 1.1 `src/core/transport/structured.ts`（新增，597 行）

`createStructuredTransport(exec): CodeartsTransport` — 结构化通道传输，**每回合 = 一个独立 `<installDir>/bin/codearts run <prompt> --format json --print-logs` 进程**（回合退出即回合结束，内核内存每回合归零——痛点②治理主路径）。

主控裁定逐条落实：

| 裁定 | 落实 |
|------|------|
| R-s1 回合=进程 | `inject(ref, prompt)` 即发起新回合：argv 数组直传（禁 shell 拼接，prompt 单 argv 元素、空格/多行不拆词）；`--session <id>` 续接；session id 从任意 JSON 对象行宽容提取（`sessionID`/`session_id`，**首现捕获不改写**）；非 JSON 行/未知 JSON 事件原文转 output 信号（不静默丢弃） |
| R-s2 AK/SK 前置 | 每次 `start` 执行 `readAksk(cfg.akskFile)`（非缓存）；缺失/不完整（AK、SK 任一为空）→ `BridgeError(AKSK_MISSING)`，remediation 含官方入口 `https://codearts.huaweicloud.com/portal/settings/cli-auth` 与 akskFile 写法（AK=/SK= 两行、0600）；**不静默转 PTY** |
| R-s3 env 装配 | 父进程全量环境（`{...process.env}`）+ `CODEARTS_CLI_AK`/`CODEARTS_CLI_SK` 注入；`OPENCODE_MODE` 不注入（R-s3 裁定，无实测证据表明必须） |
| R-s4 并发=1 | 活跃回合（spawn 后退出回调未到）中再 inject → `ROUND_ACTIVE`；stop = `detached:true` + `process.kill(-pid, SIGKILL)` 组杀（T2-02 教训：防孤儿内部 server），ESRCH 幂等、其余显式 `STRUCTURED_STOP_FAILED`；stop 为会话终态（后续 inject/start(ref) → `SESSION_NOT_ALIVE`）；回合退出 code=0 → 一次性 `done`、code≠0 → `error`（无 done；**会话不死亡**，可续接新回合——T3 重试依赖） |
| R-s5 映射表 | 文件头注释即唯一真相源（session.id→step / message.part→output(part.text 提取) / error→error(message 提取) / 其余与非 JSON→output 原文 / 退出码→done 或 error）；`classifyError(line)` 导出：ECONNRESET/timeout/429/503 → retryable，认证失败 → **fatal 且优先**（凭据缺失重试无意义），其余 undefined |

实现者决策（文件头已注明，供评审）：
- **签名偏差**：`(exec)` 单参 vs plan 卡 `(cfg, exec, aksk?)` — types.ts 唯一真相源以 `start(cfg)` 交付配置、R-s2 前置 `readAksk(cfg.akskFile)`；传入 aksk 会造成凭据双真相源并绕过前置检查。对齐 T2-02/T2-03 已接受的先例（progress.md 主控裁决：签名偏差接受）。
- **无时钟注入**：全事件驱动（行回调/退出回调直接驱动唤醒），无轮询循环，无 clock 需求（较两 PTY 宿主更简）。
- **`alive()` 语义**：`!closed`（会话可接受新回合即存活）——回合进程存活状态由 `snapshot.meta.activeRound`/`lastExit` 如实标注；与 PTY 宿主"进程死=会话死"的固有差异源于回合=进程模型（文件头已注明）。
- `start(cfg)` 不 spawn 任何进程（回合进程仅由 inject 发起）；stdout/stderr 合并行流、双流独立 StringDecoder、退出残段冲刷（末行无换行不丢）、spawn error 显式转 `code=null` 退出回调（绝不静默）。

### 1.2 `test/fixtures/fake-codearts/fake-run.ts`（新增，104 行）

`codearts run` 测试替身，7 场景按派发清单：`normal`（session.id+回复+exit 0，带 `--session` 输出"续接:<id>"）/ `stall`（输出后常驻，供组杀 /proc 验证）/ `error`（error 事件+exit 0）/ `crash`（stderr 非 JSON 行+exit 7）/ `echo`（回显回合 argv，端到端断言 argv 形态）/ `env`（**仅输出键存在性 set/unset，值绝不跨进程边界**）/ `session-continuation`。退出一律 `process.exitCode` + 自然结束（防 pipe 缓冲未刷）。

### 1.3 `test/transport-structured.test.ts`（新增，707 行，28 用例）

fake exec（离线零进程、确定性）+ 生产 seam `nodeRunSpawnProc` 真实 spawn（wrapper=sh exec bun fixture，绝不跑真实 codearts、不触真实 HOME）。FS 落点仅 `test/.tmp/t12/`，afterEach 清理（含 /proc 残留进程清扫防跨用例污染）。

覆盖矩阵：R-s2 前置（4）· argv/env 装配（4）· 事件→信号映射（6）· classifyError（2）· 并发与生命周期 R-s4（6：ROUND_ACTIVE/stop 幂等/终态/SESSION_UNKNOWN/OBSERVER_ACTIVE/abort T9 基准四态）· 生产 seam 真机链路（6：bin 缺失/normal 全链/--session 端到端含空格 prompt/env 键存在+值不泄漏/crash exit 7/stall+stop /proc 组杀实证）。

## 2. TDD 证据

- **RED**：fixture+测试先行，`bun test test/transport-structured.test.ts` → `error: Cannot find module '../src/core/transport/structured'`（0 pass / 1 fail）。
- **GREEN**：实现后聚焦 28/28 pass；期间修复 2 处**测试侧**缺陷（首轮 26/28：两用例因 collectUntil 未 return 迭代器致第二次 observe OBSERVER_ACTIVE——用例自身违反单观察者模型，实现无误）；typecheck 修复 2 处（AsyncIterator.return 可选调用、fixture 全局脚本 `prompt` 与 lib.dom 撞名→改名 roundPrompt）。
- **稳定性**：聚焦用例连续 3 轮全绿；全量跑一轮曾被 SIGKILL（见 §5），复跑 2 轮全绿。

## 3. 测试结果

```
bun test    → 251 pass / 1 skip / 0 fail（基线 223+1skip，本任务 +28）
typecheck   → tsc --noEmit 零错误（rc=0）
行数门禁    → 597 / 707 / 104 行，全部 ≤1000
既有文件    → 零改动（types.ts 未需扩展；shared.ts 仅 import 未改）
```

## 4. 文件清单

| 文件 | 变更 | 行数 |
|------|------|------|
| `plugins/codearts-bridge/src/core/transport/structured.ts` | 新增 | 597 |
| `plugins/codearts-bridge/test/transport-structured.test.ts` | 新增 | 707 |
| `plugins/codearts-bridge/test/fixtures/fake-codearts/fake-run.ts` | 新增 | 104 |

## 5. 自审发现（完整性/质量/YAGNI/测试真实性）

- **完整性**：plan 卡 5 条测试清单全数覆盖且有真机链路版（session 续接断言 argv、env 键存在性、crash 句柄回收经 lastExit/exitSeen、AKSK_MISSING 门控、事件映射归类）。
- **YAGNI**：砍掉 plan 卡的 `aksk?` 参数（理由见签名偏差）与无用的 clock/opts；未加日志 tailer（信号源即回合进程，无需 kernel 日志）。
- **测试真实性**：组杀验证不靠 sleep 时长而靠 /proc 扫描；env 值断言"不泄漏"（负向断言 ak-test/sk-test 不在输出中）；凭据值在 fake exec 断言中也不落日志。
- **边界记录**：stop 组杀触发的子进程退出回调仍会如实入账 error 信号（会话已 closed，信号随终态队列保留）——已在代码注释注明为有意行为（记录事实，非兜底）。

## 6. 遗留问题 / 担忧

1. **一轮全量 `bun test` 曾被 SIGKILL**（复跑 2 轮全绿、聚焦 3 轮全绿）。机器当时 load≈10.6（AGENTS.md 已知高负载坑）。非测试缺陷证据不足、非确定性复现；若复现建议查 OOM（dmesg 无权限）。
2. **事件格式为宽容假设**：`message.part`/`error`/`session.id` 的字段路径（part.text/message）基于 plan 卡 fixture 事件名与宽容原则设计，真实 `codearts run --format json` 输出格式未实测（F2 只实测了认证门控）；未知事件一律原文 output 兜住格式偏差，接真实 CLI 后如需精化映射只改 `handleLine` 一处。
3. **M 候选（不阻塞）**：空行会产出 text="" 的 output 信号（宽容口径的忠实体现，T3 消费侧如觉噪声可在监督层过滤）；`classifyError` 子串匹配存在理论误报（如 "f4290"），属裁定口径内（分类线索非解析器）。
4. **stop 后 stale 信号**：closed 会话队列中的 kill 退出 error 信号，下次 observe 会先交付该信号再终止——语义与 Fake/script 残存保留一致，但 T3-04 对账层消费 stopped 会话时须知悉。
