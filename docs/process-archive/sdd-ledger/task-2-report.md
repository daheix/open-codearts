# Task 2 报告：配置与状态根（T1-02）

- **Status: DONE_WITH_CONCERNS**（核心交付全部完成、全量测试绿；1 项自主决策 + 2 项轻微 concern 见文末）
- **提交**：`54b039cbf0` `codearts-bridge(T1-02): 配置与状态根 — 默认值/优先级/env 文件解析/0700 目录`
- **工作区**：`/home/wsc/.local/share/opencode/worktree/e5785e/codearts-bridge`（分支 `codearts-bridge`）

## 1. 实现内容

| 文件 | 说明 |
|---|---|
| `plugins/codearts-bridge/src/core/config.ts` | 完整实现（340 行）：`BridgeConfig`/`Thresholds`/`Aksk` 类型；`loadConfig(overrides?, env?)` 纯函数（无 FS I/O），三层优先级 overrides > `CODEARTS_BRIDGE_*` > 默认值；`ensureStateDirs`（stateDir + goals/audit/health/logs/tmp，mode 0700）；`readAksk`（ENOENT→undefined，其他读错→显式抛出）。**T1-01 占位常量 `PLUGIN_ID`/`TOOL_NAMESPACE`/`SMOKE_TOOL_NAME`/`PLUGIN_VERSION` 原样保留**，server.ts 及其 4 测试不受影响 |
| `plugins/codearts-bridge/test/config.test.ts` | 18 用例 59 断言，覆盖任务书 4 组断言 + 非法输入显式报错 + 凭据不回显 + 幂等 |

### 关键设计决策（均写入代码注释）

1. **测试绝不触碰真实 HOME**（裁定 1）：`loadConfig` 为纯函数；默认值仅做字符串拼接（`os.homedir()`），断言它安全；所有 FS 落点经 overrides 注入 `plugins/codearts-bridge/.tmp/config-test/`（gitignore），`afterAll` 清理。
2. **readAksk 错误语义**（裁定 2）：ENOENT→`undefined`；EACCES/EISDIR 等→抛出（消息含路径+原因码，`cause` 保留原错误）；解析纪律：格式错误行/未知键/重复键显式抛出（未知键防拼写错误静默丢凭据）；错误消息只含键名/路径/行号，**绝不回显行内容**。
3. **环境变量映射表**（裁定 3）写入文件头注释：`INSTALL_DIR/STATE_DIR/TRANSPORT/PTY_HOST/DAEMON_URL/AKSK_FILE/AUTO_NUDGE`；`thresholds` 无 env 映射（嵌套对象仅 overrides 可设，避免碎片化键名）；空串 env 显式报错（不当作未设置）；`AUTO_NUDGE` 仅接受字面量 `"true"/"false"`。
4. **ensureStateDirs**（裁定 4）：mkdir(mode 0700) 后**显式 chmod 0700**（mkdir mode 被 umask 掩蔽，chmod 保证 umask 无关）；不改属主；幂等。
5. **阈值与 daemonUrl 默认**（裁定 5）：`{stallSeconds:60, retryCapSeconds:60, strikes:3, echoGuardMs:3000}`、`http://127.0.0.1:4577`；thresholds 每次返回新对象（防调用方改写污染，有测试钉死）。
6. **严格校验**（裁定 7）：transport/ptyHost 枚举、daemonUrl 必须为合法 http/https URL、路径字段必须绝对路径（FS 落点禁止依赖 cwd）、阈值非负有限数字、autoNudge 严格布尔——全部就地显式报错，无任何兜底。

## 2. TDD 证据

**RED**（Step 2，实现在缺位时）：
```
$ bun test test/config.test.ts
SyntaxError: Export named 'ensureStateDirs' not found in module '.../src/core/config.ts'
 0 pass / 1 fail / 1 error
```
**GREEN**（Step 4，实现后）：
```
$ bun test test/config.test.ts → 18 pass / 0 fail / 59 expect() calls (84ms)
$ bun test                    → 22 pass / 0 fail / 77 expect() calls（含 server.test.ts 4 用例）
$ bun run typecheck           → tsc --noEmit 零输出通过
```
单文件行数：config.ts 340 行 / config.test.ts 251 行，均 ≤1000 ✓。

## 3. 测试覆盖清单（对照任务书 Step 1）

- ✓ defaults：installDir/stateDir/daemonUrl/thresholds/akskFile/transport/ptyHost/autoNudge + thresholds 防污染
- ✓ 优先级：env 覆盖默认（含 akskFile 随 stateDir 派生）；overrides 压过 env；akskFile 显式覆盖；installDir/ptyHost env 覆盖
- ✓ ensureStateDirs：**umask 0777 下仍 0700**（证明显式 chmod，与 umask 无关）；幂等；已存在 0755 目录收紧为 0700 且 uid 不变
- ✓ readAksk：缺失→undefined（绝不抛）；KEY=VALUE 解析（注释/空行/CRLF/空白容忍）；单键/空文件；EISDIR 显式抛出含路径；格式错误行抛出且**不回显疑似凭据**；未知键抛出含键名不含键值；重复键抛出

## 4. 自审发现

- **已处理**：初版 transport/ptyHost/daemonUrl 的 env 值被 `envValue` 读取两次（纯函数无行为差异但不整洁）→ 重构为单次读取局部变量后复跑全绿。
- **YAGNI 检查**：未引入 dotenv 库、未做 config 文件加载（属后续任务卡）、未导出 `DEFAULT_THRESHOLDS`（内部常量即可）。
- **测试真实性**：18 用例全部走真实断言（无恒真）；umask 测试真实设置 `process.umask(0o777)` 并 try/finally 还原；EACCES 用目录路径（EISDIR）替代——跨环境确定性（root 下 chmod 000 仍可读），同样满足"非 ENOENT 读错→抛出"契约。

## 5. 自主决策与遗留 concern

**自主决策 1（brief 未指定 autoNudge 默认值）**：取 `false`——主动提醒（nudge）属侵入性行为，须显式开启（宁缺毋滥）；已在类型注释与报告登记。

**Concern 1（轻微）**：`readAksk` 对"未知键显式抛出"比常规 dotenv 解析严格——若后续 akskFile 需承载更多键（如 region），须同步扩展白名单；当前按"显式报错优先于静默忽略"裁定执行（防拼写错误静默丢凭据）。

**Concern 2（轻微）**：`akskFile` 为空文件/纯注释时返回 `{}`（文件存在但无凭据），与 `undefined`（文件不存在）可区分；调用方（后续任务卡）需明确两态语义，本任务不代替其决策。

## 6. 关联

- 需求：`task-2-brief.md`（Interfaces 契约逐条落实）
- 前置：`58eba495fc`（T1-01 包骨架）、`8bb2fc1d50`（T1-01 评审修复）
- 无遗留失败测试；`.tmp/config-test/` 已清理（空 `.tmp/` 目录残留为 gitignore 项，无害）

---

## 7. 修正记录：autoNudge 默认值 `false` → `true`（主控裁决 2026-10-31，进入任务评审前）

**裁决内容（逐字）**：`autoNudge` 默认值由 `false` 改为 **`true`**。理由：目标会话的存在意义就是"跑到底"；停滞 60s 既不自动续跑也不告警 = 静默挂起，直接违背产品核心承诺（spec §6.3.2"目标永不挂起"）与仓库禁静默铁律。`false` 保留为显式退出的高级选项（语义注释写明）；逐目标覆盖随 T3-05 定义。原报告"自主决策 1"（宁缺毋滥取 `false`）**就此作废**，以本裁决为准。

**改动内容**：

| 文件 | 改动 |
|---|---|
| `src/core/config.ts` | ① `BridgeConfig.autoNudge` 字段注释改为"默认 true（主控裁决 2026-10-31：目标会话默认自动续跑；false 为显式退出的高级选项）"；② `loadConfig` 兜底值 `envBool(env, "AUTO_NUDGE") ?? false` → `?? true`，并新增注释块写明裁决理由（停滞静默挂起违背"目标永不挂起"；false 为显式退出；逐目标覆盖 T3-05 定义） |
| `test/config.test.ts` | ① defaults 用例断言 `cfg.autoNudge` 为 `true`（注释标注裁决来源）；② 原"env 覆盖默认值"用例的 `AUTO_NUDGE` 由 `"true"` 改为 `"false"`——env 显式 false 压过默认 true（既保持 env 覆盖测试有效性，又覆盖显式退出路径）；③ "overrides 压过 env" 用例新增 `autoNudge: false` overrides + env `"true"` 组合，断言结果为 `false`——显式 overrides 退出压过 env 开启仍生效 |

**覆盖测试（修正后语义）**：
- 默认 `true`（defaults 用例）
- env `AUTO_NUDGE=false` 覆盖默认 → `false`（env 覆盖用例，显式退出经 env 生效）
- overrides `autoNudge: false` 压过 env `"true"` → `false`（显式退出最高优先级仍生效）
- 非法 env 值（`"yes"`）显式报错不变（原有用例）

**命令与输出**：
```
$ bun test           → 22 pass / 0 fail / 78 expect() calls (397ms)（22 用例不变，断言 77→78）
$ bun run typecheck  → tsc --noEmit 零输出通过
```

**裁决执行说明**：本修正由主控会话裁决、修复实施者执行（原实施会话不可复用）；改动范围严格限于 `src/core/config.ts` 与 `test/config.test.ts` 两文件，语义注释按裁决原文表述，`false` 的"高级显式退出"语义已写入类型注释与 `loadConfig` 实现注释。
