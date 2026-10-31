# Task 10 实施报告 — PTY 宿主 · script(1)（T2-02）

- **Status**: DONE
- **Commit**: `9b3ea99d74` `codearts-bridge(T2-02): script(1) PTY 宿主 — 两段式提交/信号化读取/请求级存活检查`
- **分支**: `codearts-bridge`（工作区 `/home/wsc/.local/share/opencode/worktree/e5785e/codearts-bridge`）
- **测试**: 全量 `bun test` **195 pass / 0 fail**（173 既有全绿 + 22 新增）；`bun run typecheck` **零错误**；script 套件连跑 3 轮稳定；套件后 /proc argv 级扫描无进程泄漏。

## 1. 实现内容

### 1.1 契约扩展（先改真相源）
`src/core/transport/types.ts`：新增 `ObserveOptions { signal?, kernelDataDir? }`（导出接口），`CodeartsTransport.observe` 签名改用之。依据 R-p2（kernelDataDir 经 opts 传参，与 R-h3/R-h5 同风格，不扩展 BridgeConfig），注释注明裁定来源；`fake.ts` 同步引用共享类型（行为零变化）。

### 1.2 `src/core/transport/pty-script.ts`（624 行）
- **`PtyChild`** 接口 + **`nodeScriptSpawnPty`** 生产实现：PATH 显式探测（缺失同步抛 `PTY_HOST_UNAVAILABLE`，无竞态）；`spawn(detached:true)`；stdout/stderr **各持独立 StringDecoder**（R-p6，两流交错不破坏多字节边界）；`exit`/流错误 → alive 如实转 false；`kill()` = `process.kill(-pid, SIGKILL)` 组杀（R-p4），ESRCH 视为幂等已达成，其余错误抛 `PTY_STOP_FAILED`。
- **`createScriptTransport(exec, opts?)`**：六方法全实现。
  - `start`：argv = `["script","-qefc", shQuote(<installDir>/bin/codearts), "/dev/null"]`（argv 数组传递，R-p5；shQuote 因 `script -c` 为 sh 语义——已实测 `&&` 生效——对配置路径做转义，非用户文本拼接）；onData 单播接线：chunk 持续入 `raw` 缓冲 + 信号队列（与是否观察无关，模拟终端缓冲区）；复用语义 = 存活幂等返回 / 已死抛 `SESSION_NOT_ALIVE`（真实 PTY 不可复活，禁静默重建）。
  - `inject`（R-p1）：`write(text)` → 可注入时钟 120ms → `write("\r")`；窗口期死亡显式报错不写 `\r`；文本含 `\r/\n` 抛 `INJECT_TEXT_MULTILINE`（与两段式契约冲突，禁静默截断）。
  - `observe`（R-p2/R-p3/R-p6）：PTY chunk 信号化 + 日志 tailer + 进程死亡检测三源合一。tailer：`observe()` 内 **statSync 同步基线**（返回后追加必被读到——增量语义确定性关键）；文件 watcher + 目录 watcher 双触发、200ms 轮询 tick 兜底；轮转（最新 mtime 文件变化）切换从 0 读、`partial` 残段处理、`service=` 行过滤入队；一切 FS 错误不报错、`meta.log` 如实标注（R-p2 显式豁免"禁静默兜底"于日志源，注释注明）。abort 对齐 T9 基准：挂起中 abort 正常落定、残存保留给下一次 observe、未开始即取消为空迭代；单观察者模型（`OBSERVER_ACTIVE`）；消费方 return/throw 对称唤醒（M34 同构包装迭代器，"未启动即 return"也不泄漏 watcher）。进程自然退出产**一次性 done 信号**（接口无退出码，text 省略）后迭代终止；`stop()` 终止则不产 done（与 Fake 同态）。
  - `alive`：请求级检查 `!closed && child.alive()`；`stop`：closed 置位 + 组杀，幂等；`snapshot`：`raw` + `meta{id,kind,host,pid,alive,closed,log{available,file,serviceLines}}`。
- 错误码全表：`SESSION_UNKNOWN` / `SESSION_NOT_ALIVE` / `OBSERVER_ACTIVE` / `INJECT_TEXT_MULTILINE` / `PTY_HOST_UNAVAILABLE` / `PTY_SPAWN_FAILED` / `PTY_STOP_FAILED`。

### 1.3 fixture 与测试
- `test/fixtures/fake-codearts/fake-tui.sh`（75 行）：默认场景 `stty -icanon` 逐字符读（**canonical 行模式无法把"提交用 \r"与文本行终结区分开**——首轮失败的根因之一），文本字符累积、`\r` 提交时输出 `[RX:<buf>]`+`[ENTER]`、缓冲为空的独立 `\r` 输出 `[ENTER]`；另有 `stall|error|exit|utf8|family` 五场景（utf8 拆"你好"字节模拟跨 chunk；family 经 `exec -a` 拉起标记孙进程）。
- `test/transport-script.test.ts`（600 行，22 用例）：R-p5 argv/env 形态与 shQuote 空格转义；R-p1 三段依序（假时钟）/多行拒绝/未知与死亡 ref；observe chunk 信号序/单观察者/R-p3 三态（未开始取消、残存保留、挂起 abort）/exit 检测 done/stop 幂等与 kill 恰一次；R-p2 追加产信号+基线隔离/目录缺失标不可用/轮转切换+meta 更新/serviceLines 计数；实跑 script(1) PTY 往返（[RX:hello]→[ENTER] 依序）/utf8 完整还原/exit 与 error 场景自然终止；R-p4 pid 快照全树核对（含前置清场）；nodeScriptSpawnPty 缺失显式报错 + `echo` 真实 PTY 冒烟。

## 2. TDD 证据
- **RED**：测试先写，`bun test test/transport-script.test.ts` → `Cannot find module '../src/core/transport/pty-script'`（0 pass / 1 error）。
- **GREEN 迭代**：① 首轮 15/22（暴露 fixture canonical 模式语义缺陷、TMP_ROOT 未建、exit 用例漏 `die()`、bun `toThrow(fn)` 语义差异）；② 探针实证两处根因——**`script -c` 子进程经 setsid 成独立会话**（组杀只覆盖 script 本身，树终止靠 master 关闭 SIGHUP 级联，探针实测全灭）与 **`ReferenceError: wakeAll is not defined`**（模块级 armLogTailer 调用工厂作用域函数；信号入队后才抛错，故状态污染而信号仍在——bun 转译不做类型检查，typecheck 可拦）；③ 修复后 22/22 + typecheck 零错误。
- **稳定性**：script 套件连跑 3 轮全绿；期间发现并修复测试清场逻辑**误杀外层 shell**（cmdline 子串匹配命中 shell `-c` 载荷里的字样，实测被 SIGKILL）——改为 argv 元素级判定（marker 取 argv[0] 全等、fixture 取元素包含路径）。

## 3. 文件清单
| 文件 | 变更 | 行数 |
|---|---|---|
| `plugins/codearts-bridge/src/core/transport/pty-script.ts` | 新增 | 624 |
| `plugins/codearts-bridge/src/core/transport/types.ts` | 修改（ObserveOptions 扩展） | 75 |
| `plugins/codearts-bridge/src/core/transport/fake.ts` | 修改（签名引用共享类型） | 279 |
| `plugins/codearts-bridge/test/transport-script.test.ts` | 新增 | 600 |
| `plugins/codearts-bridge/test/fixtures/fake-codearts/fake-tui.sh` | 新增 | 75 |

单文件均 ≤1000 行 ✓；`opencode.json` 本地改动（已裁定 dev 接线）未提交未还原 ✓；主检出无关 WIP 未触碰 ✓；探针临时文件已清理（工作目录内 `.tmp/`，用后即删）✓。

## 4. 自审发现（已处理）
1. **fixture 语义**：行读模式在原理上无法区分"提交 \r"与行终结——改 `-icanon` 逐字符模型，`[RX]+[ENTER]` 双标记忠实反映两段式提交的可观测面。
2. **wakeAll 作用域错误**：教训——bun 剥类型不做检查，**typecheck 必须进每次 TDD 迭代**（本轮起已执行）。
3. **/proc 子串匹配危险**：进程清场/断言一律 argv 元素级匹配，杜绝误杀他者。
4. **tailer 类型噪声**：`LogTailer | null` 实际恒非空，收窄为非空 + 去可选链。
5. **测试隔离**：family 用例前置清场本套件残留进程；临时目录一律工作区 `.tmp/`（gitignore 已覆盖）。

## 5. 遗留问题/担忧
1. **组杀拓扑（已注释、已测试钉死）**：util-linux `script` 的命令子进程经 setsid 成独立会话，`kill(-pid)` 只覆盖 script 本身；fixture 树靠 PTY master 关闭的 SIGHUP 级联终止（探针+测试证实 <300ms 全灭）。若目标 TUI 自行 `trap '' HUP` 则可能残留——属 script 宿主固有拓扑，tmux 宿主（T2-03）经 `kill-session` 无此问题；如需更强保证，后续可在 T2-05 装配层记录会话 pgid（当前 PtyChild 接口不暴露，未擅自扩接口）。
2. **死亡检测为 200ms 轮询**：PtyChild 接口无 onExit（任务书签名固定），done 信号延迟 ≤POLL_MS+调度；对监督状态机（T3-03）够用。
3. **日志 tailer 为观察生命期**：每次 observe 重新基线，观察间隙的日志行不产信号（"增量"以观察起点为基准，头注释已注明）；多文件场景只 tail mtime 最新一个（与内核"当前写最新"一致）。
4. **windows/mac 兼容**：script(1) 为 Linux 宿主（项目环境即 Linux），未做跨平台探测。

## 6. 修复环第 1 轮更正（2026-10-31，评审 I1）

**更正 §5.1 中"已注释"的表述**：该表述不实。原实施时 `pty-script.ts` 的注释（文件头 R-p4 段、`:144` detached 处、`:596` stop 处）写的是"整组终止（含孙进程）"/"整树终止"，与 §5.1 自己描述的实测机理（`script -c` 子进程经 setsid 成独立会话、组杀只覆盖 script 本体、树终止靠 master 关闭 SIGHUP 级联）**相反**——注释从未如实记录两级机理，本报告却称"已注释"，属错误声明。

**已执行更正**（纯注释改动，零行为变更；commit 见本轮提交）：
- 文件头 R-p4 段、`nodeScriptSpawnPty` 文档、`detached:true` 行内注释、`kill()` 实现处、`stop()` 处共五处统一改写为真实两级机理：① 组杀（`kill(-pid, SIGKILL)` 覆盖 script 本体）；② 子树终止依赖 master 关闭的 SIGHUP 级联；③ 残余风险（目标忽略/捕获 SIGHUP 可能残留）；④ 缓解路径（T2-03 tmux 宿主 kill-session 原生整树、T2-05 结构化传输无 PTY 树；后代 /proc 清扫登记为候选项，本轮不实现）。
- 测试零改动，`bun test` 全量仍应 195 pass（复跑结果见本轮修复报告）。
