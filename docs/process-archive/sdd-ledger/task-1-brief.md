### Task 1: 包骨架与加载验证（T1-01）

**Files:**
- Create: `plugins/codearts-bridge/package.json`、`tsconfig.json`、`bunfig.toml`（限 test 配置）、`.gitignore`（忽略 `.tmp/`、`node_modules/`）、`src/server.ts`、`src/core/config.ts`（仅常量占位）、`test/server.test.ts`

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

