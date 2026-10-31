/**
 * T2-01 传输接口与 FakeTransport 测试（bun:test）。
 *
 * 主控裁定对照（2026-10-31）：
 * - R-tr1 接口最小完整：FakeTransport 实现任务书 CodeartsTransport 全部六方法，
 *   Signal/SessionRef/TransportKind 形态与任务书逐字段一致（测试侧钉死）。
 * - R-tr2 observe 尊重取消：opts.signal abort → 迭代正常结束（不抛错）。
 * - R-tr3 FakeTransport 可复用性（T3-03 监督状态机将直接使用）：
 *   ① 脚本化信号队列：push 预置 / emit 便捷追加，消费期间可继续追加；
 *   ② inject 记录 {text, at} 调用顺序（注入留痕，供"两步提交"断言）；
 *   ③ alive 可切换：stop → false；start 复用同一 ref → true；
 *   ④ stop 后 observe 终止且 alive=false；
 *   ⑤ 一切行为确定性可测：无计时依赖——`at` 由会话级调用序计数器提供
 *     （二选一裁定：选调用序，弃注入时钟；start 复用时归零；
 *     inject 与 emit 共享同一时间线刻度，与真实传输的事件序一致）。
 * - R-tr4 隔离：Fake 不 spawn 任何进程、无 FS/网络副作用，测试不触碰真实 HOME。
 *
 * 错误路径（禁静默兜底，显式 BridgeError）：
 * - SESSION_UNKNOWN：任何方法收到未知 ref（同步抛，不产生副作用）；
 * - SESSION_NOT_ALIVE：对已 stop 的 session inject；
 * - OBSERVER_ACTIVE：同一 ref 并发第二个 observe。
 */
import { describe, expect, it } from "bun:test";
import { loadConfig } from "../src/core/config";
import { BridgeError } from "../src/core/errors";
import { FakeTransport } from "../src/core/transport/fake";
import type { SessionRef, Signal } from "../src/core/transport/types";

/** 与真实环境完全隔离的配置（Fake 不读它，仅为满足 CodeartsTransport.start 签名）。 */
const CFG = loadConfig(
  { stateDir: "/nonexistent/codearts-bridge-fake-test", installDir: "/nonexistent/installers" },
  {},
);

/**
 * 收集型观察：消费信号直至脚本终结信号（done）或流自然终结（stop/abort）。
 * Fake 的 observe 在队列耗尽且会话未终结时保持挂起（R-tr3-①"期间可继续追加"
 * 的必然语义），故"跑完"必须由脚本 done 收尾或先 stop——本 helper 取 done 约定。
 * break 触发迭代器 return → 同步释放观察者名额。
 */
async function drain(
  t: FakeTransport,
  ref: SessionRef,
  signal?: AbortSignal,
): Promise<Signal[]> {
  const out: Signal[] = [];
  for await (const sig of t.observe(ref, signal ? { signal } : undefined)) {
    out.push(sig);
    if (sig.t === "done") break;
  }
  return out;
}

describe("FakeTransport.start / 会话生命周期", () => {
  it("start 无 ref：返回新 ref（kind 与构造一致、id 唯一递增、alive=true）", async () => {
    const t = new FakeTransport();
    const a = await t.start(CFG);
    const b = await t.start(CFG);
    expect(a.kind).toBe("pty");
    expect(b.kind).toBe("pty");
    expect(a.id).not.toBe(b.id);
    expect(await t.alive(a)).toBe(true);
    expect(await t.alive(b)).toBe(true);
  });

  it("start 构造参数可指定 kind=structured（R-tr1 TransportKind 两值）", async () => {
    const t = new FakeTransport({ kind: "structured" });
    const ref = await t.start(CFG);
    expect(ref.kind).toBe("structured");
    expect(t.kind).toBe("structured");
  });

  it("start 带 ref：复用已知 session（返回同一 ref、复活 alive）；未知 ref → 采纳为新会话（③ 跨守护对账对齐）", async () => {
    const t = new FakeTransport();
    const ref = await t.start(CFG);
    await t.stop(ref);
    expect(await t.alive(ref)).toBe(false);

    const again = await t.start(CFG, ref);
    expect(again).toEqual(ref);
    expect(await t.alive(ref)).toBe(true);

    // ③：未知但形态合法的 ref = 跨守护重启对账语义（与真实传输对齐）：采纳为新会话
    const ghost: SessionRef = { kind: "pty", id: "fake-999" };
    const adopted = await t.start(CFG, ghost);
    expect(adopted).toEqual(ghost);
    expect(await t.alive(ghost)).toBe(true);
    await expect(t.inject(ghost, "x")).resolves.toBeUndefined(); // 采纳后可注入
  });
});

describe("FakeTransport.inject 注入留痕（R-tr3-②）", () => {
  it("inject 按 {text, at} 记录调用顺序，at 随调用序递增", async () => {
    const t = new FakeTransport();
    const ref = await t.start(CFG);
    await t.inject(ref, "第一步");
    await t.inject(ref, "第二步");
    await t.inject(ref, "第三步");
    expect(t.injections).toHaveLength(3);
    expect(t.injections.map((i) => i.text)).toEqual(["第一步", "第二步", "第三步"]);
    expect(t.injections.map((i) => i.at)).toEqual([0, 1, 2]);
    // 留痕含 ref（多会话场景可区分归属）
    expect(t.injections.every((i) => i.ref.id === ref.id)).toBe(true);
  });

  it("inject 对已 stop 的 session 显式抛 SESSION_NOT_ALIVE 且不留痕", async () => {
    const t = new FakeTransport();
    const ref = await t.start(CFG);
    await t.inject(ref, "活着");
    await t.stop(ref);
    try {
      await t.inject(ref, "死了");
      expect.unreachable();
    } catch (e) {
      expect((e as BridgeError).code).toBe("SESSION_NOT_ALIVE");
    }
    expect(t.injections.map((i) => i.text)).toEqual(["活着"]);
  });

  it("inject/observe/stop/snapshot 对未知 ref 一律显式抛 SESSION_UNKNOWN；alive 除外（④ 布尔查询 → false）", async () => {
    const t = new FakeTransport();
    const ghost: SessionRef = { kind: "pty", id: "nope" };
    await expect(t.inject(ghost, "x")).rejects.toMatchObject({ code: "SESSION_UNKNOWN" });
    await expect(t.stop(ghost)).rejects.toMatchObject({ code: "SESSION_UNKNOWN" });
    await expect(t.snapshot(ghost)).rejects.toMatchObject({ code: "SESSION_UNKNOWN" });
    await expect(t.alive(ghost)).resolves.toBe(false); // ④：布尔查询不抛错
    expect(() => t.observe(ghost)).toThrow(BridgeError);
  });
});

describe("FakeTransport.observe 脚本化产出（R-tr3-①⑤）", () => {
  it("push 预置脚本：observe 按序产出全部信号（Signal 形态逐字段钉死）", async () => {
    const t = new FakeTransport();
    const ref = await t.start(CFG);
    t.push(ref, { t: "output", at: 100, text: "alpha" });
    t.push(ref, { t: "step", at: 101 });
    t.push(ref, { t: "done", at: 102, text: "final" });
    const got = await drain(t, ref);
    expect(got).toEqual([
      { t: "output", at: 100, text: "alpha" },
      { t: "step", at: 101 },
      { t: "done", at: 102, text: "final" },
    ]);
  });

  it("消费期间可继续追加：耗尽后挂起等待新 push，醒来继续按序产出（无计时依赖）", async () => {
    const t = new FakeTransport();
    const ref = await t.start(CFG);
    t.emit(ref, "output", "first");

    const iter = t.observe(ref)[Symbol.asyncIterator]();
    const r1 = await iter.next();
    expect(r1.done).toBe(false);
    expect(r1.value).toEqual({ t: "output", at: 0, text: "first" });

    // 队列已空：next() 挂起（返回 pending promise，确定性——不依赖任何定时器）
    const p2 = iter.next();
    let resolved = false;
    void p2.then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);

    // 消费期间追加两条，按序醒来产出（emit 与 inject 共享时间线：inject 占 at=1）
    await t.inject(ref, "mid-inject");
    const late = t.emit(ref, "output", "late-1");
    t.emit(ref, "output", "late-2");
    expect(late.at).toBe(2);
    const r2 = await p2;
    expect(r2.value).toEqual(late);
    expect((await iter.next()).value).toMatchObject({ text: "late-2" });

    // 无更多脚本也未 stop：迭代仍挂起；stop 唤醒后正常终止（挂起中的 next 得 done）
    const p3 = iter.next();
    expect((await Promise.race([p3, Promise.resolve("pending")])) === "pending").toBe(true);
    await t.stop(ref);
    expect((await p3).done).toBe(true);
  });

  it("emit 的 at 由会话级调用序计数器提供（start 复用后归零）", async () => {
    const t = new FakeTransport();
    const ref = await t.start(CFG);
    t.emit(ref, "idle");
    t.emit(ref, "output", "x");
    t.emit(ref, "error", "boom");
    t.emit(ref, "done"); // 脚本终结信号（drain 消费到 done 即止）
    const got = await drain(t, ref);
    expect(got.map((s) => s.at)).toEqual([0, 1, 2, 3]);
    // start 复用同一 ref：计数器归零（新生命期，确定性起点）
    const reborn = await t.start(CFG, ref);
    expect(reborn).toEqual(ref);
    t.emit(ref, "done", "again");
    const got2 = await drain(t, ref);
    expect(got2.map((s) => s.at)).toEqual([0]);
  });
});

describe("FakeTransport.observe 尊重取消（R-tr2）", () => {
  it("挂起等待中 abort：迭代正常结束（done=true，不抛错），未消费残存信号按'立即放弃'语义丢弃", async () => {
    const t = new FakeTransport();
    const ref = await t.start(CFG);
    const ac = new AbortController();
    const iter = t.observe(ref, { signal: ac.signal })[Symbol.asyncIterator]();
    const pending = iter.next(); // 队列空，挂起
    ac.abort();
    const r = await pending;
    expect(r.done).toBe(true);
  });

  it("已 abort 的 signal：observe 立即正常结束（空迭代，不占用观察者）", async () => {
    const t = new FakeTransport();
    const ref = await t.start(CFG);
    t.emit(ref, "output", "unconsumed");
    const ac = new AbortController();
    ac.abort();
    const got = await drain(t, ref, ac.signal);
    expect(got).toEqual([]);
    // 未占用观察者：之后仍可正常 observe（手动消费 1 条后 return 收尾）
    const iter = t.observe(ref)[Symbol.asyncIterator]();
    const r = await iter.next();
    expect(r.value).toMatchObject({ text: "unconsumed" });
    await iter.return?.(undefined);
  });
});

describe("FakeTransport.observe 单观察者约束", () => {
  it("同一 ref 并发第二个 observe 显式抛 OBSERVER_ACTIVE；未启动的迭代器 return 后即释放", async () => {
    const t = new FakeTransport();
    const ref = await t.start(CFG);
    const first = t.observe(ref);
    try {
      t.observe(ref);
      expect.unreachable();
    } catch (e) {
      expect((e as BridgeError).code).toBe("OBSERVER_ACTIVE");
    }
    // 未启动（从未 next）的迭代器显式 return：观察者同步释放
    await first[Symbol.asyncIterator]().return?.(undefined);
    // 释放后可重新 observe；以 stop 终结空流（队列空且未终结时 observe 保持挂起）
    await t.stop(ref);
    expect(await drain(t, ref)).toEqual([]);
  });

  it("挂起 next 期间调用 return()：pending next 与 return 均落定，观察者名额释放（M34 对称唤醒）", async () => {
    const t = new FakeTransport();
    const ref = await t.start(CFG);
    const iter = t.observe(ref)[Symbol.asyncIterator]();
    const pending = iter.next(); // 队列空 → 挂起于 waitFor（与 abort 用例同态）
    const ret = iter.return?.(undefined); // 消费方显式终结：须对称唤醒挂起等待
    expect(ret).toBeDefined(); // 迭代器协议要求 return 存在（本实现显式提供）
    expect((await pending).done).toBe(true);
    expect((await ret)?.done).toBe(true);
    // 名额已释放：可再次 observe（以 done 脚本信号收尾，drain 约定）
    t.emit(ref, "done", "after-return");
    expect((await drain(t, ref)).map((s) => s.text)).toEqual(["after-return"]);
  });
});

describe("FakeTransport.stop / alive 切换（R-tr3-③④）", () => {
  it("stop 后：alive=false、正在挂起的 observe 正常终止、再次 observe 立即正常结束（空）", async () => {
    const t = new FakeTransport();
    const ref = await t.start(CFG);
    t.emit(ref, "output", "before-stop");

    const iter = t.observe(ref)[Symbol.asyncIterator]();
    const r1 = await iter.next();
    expect(r1.value).toMatchObject({ text: "before-stop" });
    const pending = iter.next(); // 挂起
    await t.stop(ref);
    expect((await pending).done).toBe(true);

    // stop 后：alive=false；后续 observe 立即正常结束；stop 幂等
    expect(await t.alive(ref)).toBe(false);
    expect(await drain(t, ref)).toEqual([]);
    await t.stop(ref);
    expect(await t.alive(ref)).toBe(false);
  });

  it("stop 后 snapshot 仍可读历史（留痕不丢）", async () => {
    const t = new FakeTransport();
    const ref = await t.start(CFG);
    t.emit(ref, "output", "keep-me");
    await t.stop(ref);
    const snap = await t.snapshot(ref);
    expect(snap.raw).toBe("keep-me");
  });
});

describe("FakeTransport.snapshot", () => {
  it("raw 按序拼接 output/error 的 text；meta 反映会话状态计数", async () => {
    const t = new FakeTransport();
    const ref = await t.start(CFG);
    t.emit(ref, "output", "a");
    t.emit(ref, "error", "b");
    t.emit(ref, "step"); // 无 text：不进 raw
    t.emit(ref, "output", "c");
    const snap = await t.snapshot(ref);
    expect(snap.raw).toBe("abc");
    expect(snap.meta).toMatchObject({
      id: ref.id,
      kind: "pty",
      alive: true,
      closed: false,
      injections: 0,
      signalCount: 4,
    });
  });

  it("inject 留痕计入 meta.injections", async () => {
    const t = new FakeTransport();
    const ref = await t.start(CFG);
    await t.inject(ref, "go");
    const snap = await t.snapshot(ref);
    expect(snap.meta).toMatchObject({ injections: 1 });
  });
});
