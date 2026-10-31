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

