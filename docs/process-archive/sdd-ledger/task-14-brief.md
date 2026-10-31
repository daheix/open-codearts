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

