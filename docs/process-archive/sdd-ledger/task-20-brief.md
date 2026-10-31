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

