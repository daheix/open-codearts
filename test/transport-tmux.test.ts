/**
 * T2-03 tmux PTY 宿主测试（bun:test）。
 *
 * 主控裁定对照（2026-10-31）：
 * - R-tm1 探测与错误：每次 start 执行 `tmux -V` 探测（非缓存）；失败 →
 *   BridgeError(PTY_HOST_UNAVAILABLE)，remediation 提示安装 tmux 或
 *   ptyHost=script；禁静默切换到 script（用例：探测失败且无 new-session 调用；
 *   二次 start 重新探测）。
 * - R-tm2 start 幂等：先 has-session -t codearts-<slug>；命中 → 重连不重建；
 *   未命中 → new-session -d -s <target> <installDir>/codearts（argv 数组，
 *   禁 shell 字符串拼接）。start(ref) 对已亡会话 = 同名重建（spec 宿主重启
 *   对账语义："存活重连/否则重启会话"）。
 * - 修复环裁定①（2026-10-31）：PTY 双宿主经官方 wrapper `<installDir>/codearts`
 *   启动（全量内核 env 单一真相源）；wrapper 缺失 → WRAPPER_MISSING（禁静默
 *   回退 bin 直启；新增专测）。
 * - R-tm3 inject 两段式：send-keys（文本）与 send-keys（Enter）两次独立调用
 *   且保序；多行文本显式 INJECT_TEXT_MULTILINE（与 T2-02 同码）。
 * - R-tm4 stop/alive/snapshot：stop=kill-session（不存在→幂等）；
 *   alive=has-session 退出码；snapshot=capture-pane -p（含 meta）。
 * - R-tm6 语义对齐：abort=立即放弃（T9 基准，残存保留给下一次 observe）；
 *   stop 后 observe 终止（不产 done）；日志信号源与 T2-02 同语义
 *   （kernelDataDir tail service= 行，meta 如实标注可用性）。
 * - I1 评审修复（2026-10-31）：同名重建时活跃观察者按 stop 语义终止（不产
 *   done、立即结束），新对象 observer 干净起步——再次 observe 可用（不再
 *   OBSERVER_ACTIVE）；snapshot log meta 不分叉（旧 tailer 关闭如实转不可用、
 *   serviceLines 计数保留）。
 *
 * 隔离：tmux 命令执行器全部注入 fake（离线、不触真实 HOME/套接字）；本机未装
 * tmux，真机用例以 describe.skipIf(!HAS_TMUX) 标记（将 skip，有 tmux 环境才跑；
 * attach 语义不在测试面）。临时落点仅插件 test/.tmp/（用后即删）。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../src/core/config";
import { BridgeError } from "../src/core/errors";
import {
  createTmuxTransport,
  nodeTmuxExec,
  type TmuxExec,
  type TmuxRunResult,
} from "../src/core/transport/pty-tmux";
import { shQuote } from "../src/core/transport/shared";
import type { SessionRef, Signal } from "../src/core/transport/types";

/** 测试用临时根（工作目录内 .tmp/，用后即删，禁系统临时目录）。 */
const TMP_ROOT = path.join(import.meta.dir, ".tmp", "t11");

/**
 * 官方 wrapper fixture 安装目录（修复环裁定① 2026-10-31：PTY 双宿主一律经
 * `<installDir>/codearts` 官方 wrapper 启动，禁 bin 直启）。fake tmux 用例只验
 * 存在性与 new-session argv 形态，wrapper 不被真正执行；真机用例另行自建
 * fake-tui.sh 转发 wrapper（makeRealInstall）。
 */
const WRAPPER_INSTALL = path.join(TMP_ROOT, "install-fixture");
mkdirSync(WRAPPER_INSTALL, { recursive: true });
writeFileSync(path.join(WRAPPER_INSTALL, "codearts"), "#!/bin/sh\nexit 0\n", "utf8");
chmodSync(path.join(WRAPPER_INSTALL, "codearts"), 0o755);

/** 与真实环境完全隔离的配置（测试不触碰真实 HOME/安装目录）。 */
const CFG = loadConfig(
  { stateDir: "/nonexistent/codearts-bridge-tmux-test", installDir: WRAPPER_INSTALL },
  {},
);

/** 建一个带官方 wrapper 的临时 installDir（固定目录名：slug 断言的确定性前提；
 *  beforeEach 场景下 rmSync 先清场，afterEach 经 cleanups 清理）。 */
function makeWrapperInstall(relName: string): string {
  const dir = path.join(TMP_ROOT, relName);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const wrapper = path.join(dir, "codearts");
  writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(wrapper, 0o755);
  cleanups.push(async () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 本机是否安装 tmux（真机用例开关；本机未安装 → skip）。 */
const HAS_TMUX = Bun.which("tmux") !== null;

/* ───── 测试替身：有状态 tmux 命令执行器 fake ───── */

interface FakeTmux {
  exec: TmuxExec;
  /** 已执行（成功路径）的命令调用记录（args 不含 "tmux" 本体）。 */
  calls: Array<{ args: string[] }>;
  /** 设置 tmux 服务器侧会话是否存在（模拟外部消亡/外部创建）。 */
  setExists(v: boolean): void;
  /** 设置 capture-pane 将返回的 pane 内容（全量替换）。 */
  setPane(text: string): void;
  /** 追加 pane 内容（模拟增量输出）。 */
  appendPane(text: string): void;
  /** 令 tmux -V 探测失败（模拟 tmux 缺失）。 */
  failProbe(): void;
  /** 令下一次指定命令返回失败（exitCode=1 + stderr）。 */
  failNext(cmd: string, stderr: string): void;
}

function makeFakeTmux(opts: { exists?: boolean } = {}): FakeTmux {
  let exists = opts.exists ?? false;
  let probeBroken = false;
  let pane = "";
  const calls: Array<{ args: string[] }> = [];
  const failNext = new Map<string, string>();
  const exec: TmuxExec = {
    async run(args: string[]): Promise<TmuxRunResult> {
      const cmd = args[0] ?? "";
      if (probeBroken) {
        // 探测失败不记入 calls（未成功执行）；start 应在此中止
        return { stdout: "", stderr: "tmux: command not found", exitCode: 127 };
      }
      const fail = failNext.get(cmd);
      if (fail !== undefined) {
        failNext.delete(cmd);
        return { stdout: "", stderr: fail, exitCode: 1 };
      }
      calls.push({ args });
      switch (cmd) {
        case "-V":
          return { stdout: "tmux 3.4\n", stderr: "", exitCode: 0 };
        case "has-session":
          return exists
            ? { stdout: "", stderr: "", exitCode: 0 }
            : { stdout: "", stderr: "can't find session", exitCode: 1 };
        case "new-session":
          exists = true;
          return { stdout: "", stderr: "", exitCode: 0 };
        case "send-keys":
          return { stdout: "", stderr: "", exitCode: 0 };
        case "kill-session":
          exists = false;
          return { stdout: "", stderr: "", exitCode: 0 };
        case "capture-pane":
          return { stdout: pane, stderr: "", exitCode: 0 };
        default:
          throw new Error(`fakeTmux 未实现的命令：${cmd}`);
      }
    },
  };
  return {
    exec,
    calls,
    setExists: (v) => {
      exists = v;
    },
    setPane: (t) => {
      pane = t;
    },
    appendPane: (t) => {
      pane += t;
    },
    failProbe: () => {
      probeBroken = true;
    },
    failNext: (c, s) => {
      failNext.set(c, s);
    },
  };
}

/* ───── 测试辅助 ───── */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 可注入门控时钟：每个 tick 都停在 promise 上，由测试显式放行——observe
 * 轮询节奏完全确定（一条 tick = 一轮 has-session+capture）。
 */
function makeGatedClock() {
  const pending: Array<() => void> = [];
  const clock = (_ms: number): Promise<void> => new Promise((res) => pending.push(res));
  return {
    clock,
    tick(): void {
      for (const res of pending.splice(0)) res();
    },
  };
}

/** 慢时钟（真实微节奏）：日志源等真实 FS 异步场景用，防忙旋。 */
const slowClock = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 限时等待 next（超时抛错，避免用例悬挂）。 */
async function nextWithTimeout(
  iter: AsyncIterator<Signal>,
  timeoutMs = 3000,
): Promise<IteratorResult<Signal>> {
  const r = await Promise.race([iter.next(), sleep(timeoutMs).then(() => null)]);
  if (r === null) throw new Error(`nextWithTimeout 超时（${timeoutMs}ms）`);
  return r;
}

/** 限时收集信号直至谓词命中（超时抛错）。 */
async function collectUntil(
  iter: AsyncIterator<Signal>,
  until: (sig: Signal, acc: string) => boolean,
  timeoutMs = 3000,
): Promise<{ got: Signal[]; acc: string }> {
  const got: Signal[] = [];
  let acc = "";
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`collectUntil 超时（${timeoutMs}ms）；已收 ${got.length} 条，累计=${JSON.stringify(acc)}`);
    }
    const r = await Promise.race([iter.next(), sleep(remaining).then(() => null)]);
    if (r === null) throw new Error(`collectUntil 超时（等待 next 挂起）`);
    if (r.done) return { got, acc };
    got.push(r.value);
    if (r.value.text !== undefined) acc += r.value.text;
    if (until(r.value, acc)) return { got, acc };
  }
}

/** 建立每用例独立的内核数据根（自动建父目录）。 */
function makeKernelDir(prefix: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(path.join(TMP_ROOT, prefix));
}

/** 每用例注册清理动作（临时目录/真机 kill-server），防泄漏。 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/* ───── 用例 ───── */

describe("R-tm1 探测与显式错误", () => {
  it("tmux -V 失败 → PTY_HOST_UNAVAILABLE（remediation 含装 tmux / ptyHost=script），且不执行 new-session（禁静默降级）", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec);
    fake.failProbe();
    let err: BridgeError | null = null;
    try {
      await t.start(CFG);
    } catch (e) {
      err = e as BridgeError;
    }
    expect(err).toBeInstanceOf(BridgeError);
    expect(err!.code).toBe("PTY_HOST_UNAVAILABLE");
    expect(err!.remediation).toContain("tmux");
    expect(err!.remediation).toContain("ptyHost=script");
    expect(fake.calls.filter((c) => c.args[0] === "new-session")).toHaveLength(0);
  });

  it("探测非缓存：每次 start 都重新执行 tmux -V（前次成功不豁免后次失败）", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec);
    await t.start(CFG);
    expect(fake.calls[0]!.args).toEqual(["-V"]);
    fake.failProbe();
    await expect(t.start(CFG)).rejects.toMatchObject({ code: "PTY_HOST_UNAVAILABLE" });
  });
});

describe("R-tm2 start 幂等与会话命名", () => {
  it("新会话：has-session 未命中 → new-session -d -s codearts-<slug> <installDir>/codearts 官方 wrapper（argv 数组、路径 shQuote）", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec);
    const ref = await t.start(CFG);
    expect(ref.kind).toBe("pty");
    expect(ref.id).toMatch(/^codearts-install-fixture-[0-9a-f]{8}$/);
    expect(fake.calls.map((c) => c.args)).toEqual([
      ["-V"],
      ["has-session", "-t", ref.id],
      ["new-session", "-d", "-s", ref.id, shQuote(`${CFG.installDir}/codearts`)],
    ]);
  });

  it("start 幂等重连：会话已存在（跨守护重启场景）→ has-session 命中 → 不重建，返回同名 ref", async () => {
    const fake = makeFakeTmux({ exists: true });
    const t = createTmuxTransport(fake.exec);
    const ref = await t.start(CFG);
    expect(ref.id).toMatch(/^codearts-/);
    expect(fake.calls.filter((c) => c.args[0] === "new-session")).toHaveLength(0);
    const again = await t.start(CFG);
    expect(again).toEqual(ref);
    expect(fake.calls.filter((c) => c.args[0] === "new-session")).toHaveLength(0);
  });

  it("start(ref)：tmux 存活 → 重连同 ref（无 new-session）；已亡 → 同名重建（对账语义：重启会话）", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec);
    const ref = await t.start(CFG);
    const before = fake.calls.filter((c) => c.args[0] === "new-session").length;
    const again = await t.start(CFG, ref);
    expect(again).toEqual(ref);
    expect(fake.calls.filter((c) => c.args[0] === "new-session")).toHaveLength(before);

    fake.setExists(false); // 外部消亡
    const rebuilt = await t.start(CFG, ref);
    expect(rebuilt).toEqual(ref); // 同名（state 中引用保持有效）
    const news = fake.calls.filter((c) => c.args[0] === "new-session");
    expect(news).toHaveLength(before + 1);
    expect(news[0]!.args).toEqual(["new-session", "-d", "-s", ref.id, shQuote(`${CFG.installDir}/codearts`)]);
  });

  it("installDir 含空格：new-session 命令参数经 shQuote（tmux 将命令参数交 sh 解析）", async () => {
    const spaced = makeWrapperInstall("dir with space");
    const cfg2 = loadConfig(
      { stateDir: "/nonexistent/s", installDir: spaced },
      {},
    );
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec);
    const ref = await t.start(cfg2);
    const news = fake.calls.filter((c) => c.args[0] === "new-session");
    expect(news[0]!.args[4]).toBe(shQuote(path.join(spaced, "codearts")));
    expect(ref.id).toMatch(/^codearts-dir-with-space-[0-9a-f]{8}$/);
  });

  it("官方 wrapper 缺失 → WRAPPER_MISSING（需 new-session 时；禁静默回退 bin 直启）", async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    const empty = mkdtempSync(path.join(TMP_ROOT, "no-wrapper-"));
    cleanups.push(async () => rmSync(empty, { recursive: true, force: true }));
    const cfgBad = loadConfig({ stateDir: "/nonexistent/s", installDir: empty }, {});
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec);
    await expect(t.start(cfgBad)).rejects.toMatchObject({ code: "WRAPPER_MISSING" });
    expect(fake.calls.filter((c) => c.args[0] === "new-session")).toHaveLength(0);
    // 存活会话重连不消费 wrapper：未注册路径不触发检查（重连语义不受影响）
  });

  it("会话名确定性：同 cfg 跨传输实例同名（重连锚点）；不同 installDir 不同名", async () => {
    const t1 = createTmuxTransport(makeFakeTmux().exec);
    const t2 = createTmuxTransport(makeFakeTmux().exec);
    const ref1 = await t1.start(CFG);
    const ref2 = await t2.start(CFG);
    expect(ref1.id).toBe(ref2.id);
    const cfg2 = loadConfig(
      { stateDir: "/nonexistent/s", installDir: makeWrapperInstall("other-install") },
      {},
    );
    const ref3 = await t1.start(cfg2);
    expect(ref3.id).toMatch(/^codearts-other-install-[0-9a-f]{8}$/);
    expect(ref3.id).not.toBe(ref1.id);
  });

  it("非法 ref（kind 不符 / 空 id）→ SESSION_UNKNOWN，不产生任何 tmux 调用", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec);
    await expect(t.start(CFG, { kind: "structured", id: "codearts-x" })).rejects.toMatchObject({
      code: "SESSION_UNKNOWN",
    });
    await expect(t.start(CFG, { kind: "pty", id: "" })).rejects.toMatchObject({
      code: "SESSION_UNKNOWN",
    });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("R-tm3 两段式注入", () => {
  it("inject = [send-keys -l -t <t> <text>, send-keys -t <t> Enter] 两次独立调用且保序", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec);
    const ref = await t.start(CFG);
    fake.calls.length = 0;
    await t.inject(ref, "继续");
    // 保序断言：存活检查（has-session）→ 文本段（-l 字面）→ Enter 段（发键）
    expect(fake.calls.map((c) => c.args)).toEqual([
      ["has-session", "-t", ref.id],
      ["send-keys", "-l", "-t", ref.id, "继续"],
      ["send-keys", "-t", ref.id, "Enter"],
    ]);
  });

  it("多行文本 → INJECT_TEXT_MULTILINE（与 T2-02 同码）且不产生任何 send-keys", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec);
    const ref = await t.start(CFG);
    fake.calls.length = 0;
    await expect(t.inject(ref, "a\rb")).rejects.toMatchObject({ code: "INJECT_TEXT_MULTILINE" });
    await expect(t.inject(ref, "a\nb")).rejects.toMatchObject({ code: "INJECT_TEXT_MULTILINE" });
    expect(fake.calls.filter((c) => c.args[0] === "send-keys")).toHaveLength(0);
  });

  it("未知 ref → SESSION_UNKNOWN；会话已亡 → SESSION_NOT_ALIVE 且不注入", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec);
    await expect(t.inject({ kind: "pty", id: "codearts-nope" }, "x")).rejects.toMatchObject({
      code: "SESSION_UNKNOWN",
    });
    const ref = await t.start(CFG);
    fake.setExists(false);
    fake.calls.length = 0;
    await expect(t.inject(ref, "x")).rejects.toMatchObject({ code: "SESSION_NOT_ALIVE" });
    expect(fake.calls.filter((c) => c.args[0] === "send-keys")).toHaveLength(0);
  });
});

describe("R-tm4 stop / alive / snapshot", () => {
  it("stop = kill-session -t；alive 转 false；stop 幂等（第二次不再 kill-session）", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec);
    const ref = await t.start(CFG);
    expect(await t.alive(ref)).toBe(true);
    fake.calls.length = 0;
    await t.stop(ref);
    expect(fake.calls.filter((c) => c.args[0] === "kill-session")).toEqual([
      { args: ["kill-session", "-t", ref.id] },
    ]);
    expect(await t.alive(ref)).toBe(false);
    await t.stop(ref);
    expect(fake.calls.filter((c) => c.args[0] === "kill-session")).toHaveLength(1);
  });

  it("stop 对已消失会话幂等（kill-session 报不存在 → 不抛错、标记 closed）", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec);
    const ref = await t.start(CFG);
    fake.setExists(false); // 外部已消亡
    fake.failNext("kill-session", "can't find session");
    await expect(t.stop(ref)).resolves.toBeUndefined(); // R-tm4：不存在 → 幂等
    expect(await t.alive(ref)).toBe(false);
  });

  it("alive = has-session 退出码；未知 ref → SESSION_UNKNOWN", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec);
    const ref = await t.start(CFG);
    expect(await t.alive(ref)).toBe(true);
    fake.setExists(false);
    expect(await t.alive(ref)).toBe(false);
    await expect(t.alive({ kind: "pty", id: "codearts-nope" })).rejects.toMatchObject({
      code: "SESSION_UNKNOWN",
    });
  });

  it("snapshot：raw = capture-pane -p 输出；meta 含 host=tmux/target/alive/log；会话亡 → raw 空 + alive:false", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec);
    const ref = await t.start(CFG);
    fake.setPane("line-1\nline-2\n");
    const snap = await t.snapshot(ref);
    expect(snap.raw).toBe("line-1\nline-2\n");
    expect(snap.meta).toMatchObject({
      id: ref.id,
      kind: "pty",
      host: "tmux",
      target: ref.id,
      alive: true,
      closed: false,
      log: { available: false, file: null, serviceLines: 0 },
    });
    fake.setExists(false);
    const dead = await t.snapshot(ref);
    expect(dead.raw).toBe("");
    expect(dead.meta).toMatchObject({ alive: false });
  });
});

describe("observe：pane 增量信号（gated clock 确定性）", () => {
  it("基线确定性：observe 前已有 pane 内容不产信号；observe 后增量 → output 信号", async () => {
    const g = makeGatedClock();
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec, { clock: g.clock });
    const ref = await t.start(CFG);
    fake.setPane("old-content");
    const iter = t.observe(ref)[Symbol.asyncIterator]();
    const p = iter.next();
    g.tick(); // 一轮：建基线（old-content，不产信号）→ 再无增量 → 停在门控
    await Promise.race([p, sleep(30).then(() => null)]); // 等微任务链沉淀
    expect(fake.calls.filter((c) => c.args[0] === "capture-pane").length).toBeGreaterThanOrEqual(1);
    fake.appendPane("+new"); // 增量
    g.tick(); // 下一轮：capture 差分 → 信号
    const r = await Promise.race([p, sleep(3000).then(() => null)]);
    expect(r).not.toBeNull(); // 增量已交付（超时保护）
    expect(r!.done).toBe(false);
    expect(r!.value).toMatchObject({ t: "output", text: "+new" }); // 基线前内容不交付
    await iter.return?.(undefined);
  });

  it("重绘差分：pane 内容非前缀演进（屏幕重绘）→ 全量新内容如实转达为一条 output", async () => {
    const g = makeGatedClock();
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec, { clock: g.clock });
    const ref = await t.start(CFG);
    const iter = t.observe(ref)[Symbol.asyncIterator]();
    const p = iter.next();
    g.tick(); // 建基线（空）
    await Promise.race([p, sleep(30).then(() => null)]);
    fake.setPane("REDRAWN"); // 非前缀演进
    g.tick();
    const r = await Promise.race([p, sleep(3000).then(() => null)]);
    expect(r).not.toBeNull(); // 重绘全量已交付（超时保护）
    expect(r!.value).toMatchObject({ t: "output", text: "REDRAWN" });
    await iter.return?.(undefined);
  });

  it("单观察者：并发第二 observe → OBSERVER_ACTIVE；结束后可重新 observe", async () => {
    const g = makeGatedClock();
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec, { clock: g.clock });
    const ref = await t.start(CFG);
    const iter = t.observe(ref)[Symbol.asyncIterator]();
    const p = iter.next();
    expect(() => t.observe(ref)).toThrow(BridgeError);
    g.tick();
    await iter.return?.(undefined);
    await p; // 消费挂起请求，防悬挂
    const iter2 = t.observe(ref)[Symbol.asyncIterator]();
    await iter2.return?.(undefined);
  });

  it("abort（T9 基准）：未开始即取消 → 空迭代；挂起等待中 abort → 正常落定不抛错", async () => {
    const g = makeGatedClock();
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec, { clock: g.clock });
    const ref = await t.start(CFG);
    // ① 已 abort 的 signal 传入：立即正常结束的空迭代
    const ac1 = new AbortController();
    ac1.abort();
    const got: Signal[] = [];
    for await (const sig of t.observe(ref, { signal: ac1.signal })) got.push(sig);
    expect(got).toEqual([]);
    // ③ 挂起等待中 abort：pending next 正常落定（done=true，不抛错）
    const ac2 = new AbortController();
    const iter = t.observe(ref, { signal: ac2.signal })[Symbol.asyncIterator]();
    const pending = iter.next();
    g.tick(); // 进入门控等待（队列空）
    ac2.abort();
    expect((await pending).done).toBe(true);
    await iter.return?.(undefined);
  });

  it("残存保留给下一次 observe：一次日志增量两条信号，消费一条后 abort，残余由下一次 observe 交付", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec, { clock: slowClock });
    const ref = await t.start(CFG);
    const kdir = makeKernelDir("res-");
    const logDir = path.join(kdir, "log");
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "kernel-r.log");
    writeFileSync(logFile, "base\n");
    cleanups.push(async () => rmSync(kdir, { recursive: true, force: true }));

    const ac = new AbortController();
    const iter1 = t.observe(ref, { kernelDataDir: kdir, signal: ac.signal })[Symbol.asyncIterator]();
    appendFileSync(logFile, "A service=res-1\nA service=res-2\n"); // 一次增量 → 两条信号入队
    const r1 = await nextWithTimeout(iter1);
    expect(r1.value).toMatchObject({ t: "output" });
    expect(String(r1.value.text)).toContain("res-1");
    ac.abort(); // res-2 尚未消费 → 残存保留
    await nextWithTimeout(iter1); // 迭代正常落定（done）
    const iter2 = t.observe(ref, { kernelDataDir: kdir })[Symbol.asyncIterator]();
    const r2 = await collectUntil(iter2, (_s, a) => a.includes("res-2"));
    expect(r2.acc).toContain("res-2");
    await iter2.return?.(undefined);
  });

  it("stop 后 observe 终止（挂起 next 落定、不产 done 信号）；stop 后再 observe 立即空迭代", async () => {
    const g = makeGatedClock();
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec, { clock: g.clock });
    const ref = await t.start(CFG);
    const iter = t.observe(ref)[Symbol.asyncIterator]();
    const pending = iter.next();
    g.tick(); // 进入门控等待
    await t.stop(ref);
    expect((await pending).done).toBe(true);
    const got: Signal[] = [];
    for await (const sig of t.observe(ref)) got.push(sig);
    expect(got).toEqual([]); // stop 后 observe 立即空迭代
  });

  it("会话外部消亡：observe 产一次性 done 信号后迭代正常结束（不挂起、不重复 done）", async () => {
    const g = makeGatedClock();
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec, { clock: g.clock });
    const ref = await t.start(CFG);
    const iter = t.observe(ref)[Symbol.asyncIterator]();
    const p = iter.next();
    g.tick(); // 进入门控等待
    fake.setExists(false); // 外部 kill-session（非本 transport stop）
    g.tick(); // 下一轮：存活探测失败 → done
    const r = await Promise.race([p, sleep(3000).then(() => null)]);
    expect(r).not.toBeNull(); // done 已交付（超时保护）
    expect(r!.value).toMatchObject({ t: "done" });
    expect((await iter.next()).done).toBe(true); // 随后迭代正常结束
  });

  it("会话已亡且未 stop 时 observe → SESSION_NOT_ALIVE（tmux pane 已消失，无缓冲可交付，显式报错）", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec, { clock: slowClock });
    const ref = await t.start(CFG);
    fake.setExists(false);
    const iter = t.observe(ref)[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toMatchObject({ code: "SESSION_NOT_ALIVE" });
  });
});

describe("I1 评审修复：同名重建时活跃观察者终止与状态干净起步", () => {
  it("重建=旧观察者按 stop 语义终止（不产 done、立即结束）；再次 observe 成功可用（不再 OBSERVER_ACTIVE）", async () => {
    const g = makeGatedClock();
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec, { clock: g.clock });
    const ref = await t.start(CFG);
    const iter1 = t.observe(ref)[Symbol.asyncIterator]();
    const p1 = iter1.next();
    g.tick(); // 基线轮（空 pane）→ 停在门控等待
    await Promise.race([p1, sleep(30).then(() => null)]);
    fake.setExists(false); // 会话外部消亡（旧观察者尚不知情、仍挂起）
    await t.start(CFG, ref); // 同名重建：旧观察者应被 stop 语义终止
    const r1 = await Promise.race([p1, sleep(3000).then(() => null)]);
    expect(r1).not.toBeNull(); // 旧观察已终止（超时保护）
    expect(r1!.done).toBe(true); // 直接落定结束：未交付任何信号（stop 语义不产 done）
    // 新对象 observer 干净起步：再次 observe 不抛 OBSERVER_ACTIVE 且可正常交付
    fake.setPane("base");
    const iter2 = t.observe(ref, { kernelDataDir: path.join(TMP_ROOT, "no-such-dir") })[
      Symbol.asyncIterator
    ]();
    const p2 = iter2.next();
    g.tick(); // 新 pane 基线轮（base，不产信号）→ 停在门控
    await Promise.race([p2, sleep(30).then(() => null)]);
    fake.appendPane("+out");
    g.tick(); // 差分 → output 信号
    const r2 = await Promise.race([p2, sleep(3000).then(() => null)]);
    expect(r2).not.toBeNull(); // 再次观察成功可用（超时保护）
    expect(r2!.done).toBe(false);
    expect(r2!.value).toMatchObject({ t: "output", text: "+out" });
    await iter2.return?.(undefined);
  });

  it("重建后 snapshot log meta 不分叉：旧 tailer 关闭如实转不可用，serviceLines 计数保留", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec, { clock: slowClock });
    const ref = await t.start(CFG);
    const kdir = makeKernelDir("reb-");
    const logDir = path.join(kdir, "log");
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "kernel-reb.log");
    writeFileSync(logFile, "base\n");
    cleanups.push(async () => rmSync(kdir, { recursive: true, force: true }));

    const iter1 = t.observe(ref, { kernelDataDir: kdir })[Symbol.asyncIterator]();
    appendFileSync(logFile, "X service=rebuild-1\n");
    await collectUntil(iter1, (_s, a) => a.includes("rebuild-1")); // 消费一条 service 信号
    fake.setExists(false);
    await t.start(CFG, ref); // 同名重建（旧观察者被 stop 语义终止）
    const r1 = await Promise.race([iter1.next(), sleep(3000).then(() => null)]);
    expect(r1).not.toBeNull(); // 旧迭代已终止（超时保护）
    expect(r1!.done).toBe(true); // 不再挂起、不产 done 信号
    // snapshot log meta：旧 tailer 已 close → 如实不可用（修复前读到分叉的陈旧
    // available:true）；serviceLines 为本传输账目、跨重建保留
    const snap = await t.snapshot(ref);
    expect(snap.meta.log).toMatchObject({ available: false, file: null, serviceLines: 1 });
    expect(snap.meta).toMatchObject({ alive: true, closed: false }); // snapshot 正常
  });
});

describe("R-tm6 日志信号源（与 T2-02 同语义）", () => {
  it("追加 service= 行 → output 信号；基线前已存在行不产信号；serviceLines 跨观察累计且结束后 available:false", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec, { clock: slowClock });
    const ref = await t.start(CFG);
    const kdir = makeKernelDir("log-");
    const logDir = path.join(kdir, "log");
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "kernel-a.log");
    writeFileSync(logFile, "INFO boot ok\nWARN old service=om-before\n");
    cleanups.push(async () => rmSync(kdir, { recursive: true, force: true }));

    const iter = t.observe(ref, { kernelDataDir: kdir })[Symbol.asyncIterator]();
    appendFileSync(logFile, "INFO new service=om-after\n");
    const { got, acc } = await collectUntil(iter, (_s, a) => a.includes("om-after"));
    expect(got.every((s) => s.t === "output")).toBe(true);
    expect(acc).toContain("om-after");
    expect(acc).not.toContain("om-before");
    // 观察进行中：tail 活跃，可用性与计数如实反映（R-p2/R-tm6 同语义）
    const live = await t.snapshot(ref);
    expect(live.meta.log).toMatchObject({ available: true, file: "kernel-a.log", serviceLines: 1 });
    await iter.return?.(undefined);
    // 观察结束：available/file 转不可用态；serviceLines 跨观察累计（留痕不丢）
    const snap = await t.snapshot(ref);
    expect(snap.meta.log).toMatchObject({ available: false, file: null, serviceLines: 1 });
  });

  it("日志目录缺失 → 不报错、无日志信号；snapshot.meta.log 如实标注不可用", async () => {
    const fake = makeFakeTmux();
    const t = createTmuxTransport(fake.exec, { clock: slowClock });
    const ref = await t.start(CFG);
    const iter = t.observe(ref, { kernelDataDir: path.join(TMP_ROOT, "no-such-dir") })[
      Symbol.asyncIterator
    ]();
    const p = iter.next();
    const r = await Promise.race([p, sleep(400).then(() => null)]);
    expect(r).toBeNull(); // 400ms 内无任何日志信号（亦未抛错）
    await t.stop(ref); // 唤醒挂起 next → 迭代正常终止
    expect((await p).done).toBe(true);
    const snap = await t.snapshot(ref);
    expect(snap.meta.log).toMatchObject({ available: false, file: null });
  });
});

describe("nodeTmuxExec 生产缺省实现", () => {
  it("PATH 上无 tmux → run 同步抛 PTY_HOST_UNAVAILABLE（先探测后 spawn，无竞态）", async () => {
    const exec = nodeTmuxExec({ PATH: "" });
    await expect(exec.run(["-V"])).rejects.toMatchObject({ code: "PTY_HOST_UNAVAILABLE" });
  });
});

/* ───── 真机用例（本机未装 tmux → skip；attach 语义不测） ───── */

describe.skipIf(!HAS_TMUX)("真机 tmux 用例（需本机安装 tmux）", () => {
  /** 真机 fixture：临时 installDir，官方 wrapper <installDir>/codearts 为 fake-tui.sh
   *  包装（读行回显；修复环裁定①：PTY 经官方 wrapper 启动）。 */
  function makeRealInstall(): { installDir: string } {
    mkdirSync(TMP_ROOT, { recursive: true });
    const installDir = mkdtempSync(path.join(TMP_ROOT, "real-install-"));
    mkdirSync(path.join(installDir, "bin"), { recursive: true });
    const wrapper = path.join(installDir, "codearts");
    const fixture = path.join(import.meta.dir, "fixtures", "fake-codearts", "fake-tui.sh");
    writeFileSync(wrapper, `#!/usr/bin/env bash\nexec bash ${JSON.stringify(fixture)} --scenario stall\n`);
    chmodSync(wrapper, 0o755);
    cleanups.push(async () => rmSync(installDir, { recursive: true, force: true }));
    return { installDir };
  }

  /** 真机 exec：独立 TMUX_TMP_DIR 套接字目录隔离，退出时 kill-server 清场。 */
  function realExec(): TmuxExec {
    mkdirSync(TMP_ROOT, { recursive: true });
    const sockDir = mkdtempSync(path.join(TMP_ROOT, "tmux-sock-"));
    const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMP_DIR: sockDir };
    cleanups.push(async () => {
      try {
        await nodeTmuxExec(env).run(["kill-server"]);
      } catch {
        // 清场尽力而为（服务器可能已随末会话退出）
      }
      rmSync(sockDir, { recursive: true, force: true });
    });
    return nodeTmuxExec(env);
  }

  it("start → alive → inject 回显可见于 capture → start(ref) 重连 → stop → alive=false（stop 幂等）", async () => {
    const { installDir } = makeRealInstall();
    const cfg = loadConfig(
      { stateDir: path.join(TMP_ROOT, "real-state"), installDir },
      {},
    );
    const t = createTmuxTransport(realExec());
    const ref = await t.start(cfg);
    expect(ref.id).toMatch(/^codearts-/);
    expect(await t.alive(ref)).toBe(true);

    await t.inject(ref, "hello");
    const deadline = Date.now() + 5000;
    let raw = "";
    while (Date.now() < deadline) {
      raw = (await t.snapshot(ref)).raw;
      if (raw.includes("[RX:hello]") && raw.includes("[ENTER]")) break;
      await sleep(50);
    }
    expect(raw).toContain("[RX:hello]"); // 两段式提交端到端（文本回显 + Enter 提交）
    expect(raw.indexOf("[RX:hello]")).toBeLessThan(raw.indexOf("[ENTER]"));

    const again = await t.start(cfg, ref); // 幂等重连：不重建
    expect(again).toEqual(ref);

    await t.stop(ref);
    expect(await t.alive(ref)).toBe(false);
    await t.stop(ref); // 幂等
    expect(await t.alive(ref)).toBe(false);
  }, 15000);
});
