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

