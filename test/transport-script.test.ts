/**
 * T2-02 script(1) PTY 宿主测试（bun:test）。
 *
 * 主控裁定对照（2026-10-31）：
 * - R-p1 两段式注入：inject = write(text) → 可注入时钟等待 120ms → write("\r")
 *   （v0.2.6 教训：文本+回车同块会被粘贴识别吞掉）；时钟经 opts 注入保确定性。
 * - R-p2 日志信号源：observe 额外 tail <kernelDataDir>/log/kernel-*.log 增量，
 *   service= 行转 output 信号；日志源缺失/轮转不报错，可用性在 snapshot.meta
 *   如实标注（测试：追加 service 行产信号 / 缺失标不可用 / 基线前内容不产信号）。
 * - R-p3 abort 对齐（T9 基准）：observe 尊重 opts.signal——挂起等待中 abort
 *   迭代正常落定、残存信号不交付当前消费者但保留给下一次 observe（与
 *   FakeTransport 同态）、不抛错。
 * - R-p4 进程组终止：stop 连底层子进程树一并终止（detached + 组杀）；
 *   测试用 family 场景的标记孙进程经 /proc 扫描核对全树无残留。
 * - R-p5 PtyChild 注入：生产缺省实现 = `script -qefc <cmd> /dev/null`（argv
 *   数组传递）；测试注入 fake child 或对 bash fixture 真实 spawn（离线本地）。
 * - R-p6 UTF-8：StringDecoder 处理多字节跨 chunk（utf8 场景拆字节写入）。
 * - 修复环裁定①（2026-10-31）：PTY 双宿主经官方 wrapper `<installDir>/codearts`
 *   启动（全量内核 env 单一真相源，修真机 TUI 停在授权门的根因）；wrapper
 *   缺失 → WRAPPER_MISSING（禁静默回退 bin 直启；新增专测）。
 *
 * 错误路径（禁静默兜底，显式 BridgeError）：SESSION_UNKNOWN / SESSION_NOT_ALIVE /
 * OBSERVER_ACTIVE / INJECT_TEXT_MULTILINE / PTY_HOST_UNAVAILABLE / WRAPPER_MISSING。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, appendFileSync, rmSync, writeFileSync } from "node:fs";
import { accessSync, chmodSync, constants, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../src/core/config";
import { BridgeError } from "../src/core/errors";
import {
  createScriptTransport,
  nodeScriptSpawnPty,
  shQuote,
  type PtyChild,
} from "../src/core/transport/pty-script";
import type { SessionRef, Signal } from "../src/core/transport/types";

/** fake-tui fixture（wrapper 转发目标）。 */
const FIXTURE = path.join(import.meta.dir, "fixtures", "fake-codearts", "fake-tui.sh");

/** 测试用临时根（工作目录内 .tmp/，用后即删，禁系统临时目录）。 */
const TMP_ROOT = path.join(import.meta.dir, ".tmp", "t10");

/**
 * 官方 wrapper fixture 安装目录（修复环裁定① 2026-10-31：PTY 双宿主一律经
 * `<installDir>/codearts` 官方 wrapper 启动，禁 bin 直启）。wrapper 文件实为
 * fake-tui.sh 的转发脚本：fake-child 用例只验存在性与 argv 形态；真实 PTY 用例
 * 的 exec seam 自构造 script 命令（R-p5），均不真正执行该 wrapper。
 */
const WRAPPER_INSTALL = path.join(TMP_ROOT, "install-fixture");
mkdirSync(WRAPPER_INSTALL, { recursive: true });
writeFileSync(
  path.join(WRAPPER_INSTALL, "codearts"),
  `#!/usr/bin/env bash\nexec bash ${JSON.stringify(FIXTURE)} "$@"\n`,
  "utf8",
);
chmodSync(path.join(WRAPPER_INSTALL, "codearts"), 0o755);

/** 与真实环境完全隔离的配置（测试不触碰真实 HOME/安装目录）。 */
const CFG = loadConfig(
  { stateDir: "/nonexistent/codearts-bridge-script-test", installDir: WRAPPER_INSTALL },
  {},
);

/** 建立每用例独立的内核数据根（自动建父目录）。 */
function makeKernelDir(prefix: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  return mkdtempSync(path.join(TMP_ROOT, prefix));
}

/** 建一个带官方 wrapper 的临时 installDir（可自定义目录名前缀；用例自行清理）。 */
function makeWrapperInstall(prefix: string): string {
  mkdirSync(TMP_ROOT, { recursive: true });
  const dir = mkdtempSync(path.join(TMP_ROOT, prefix));
  const wrapper = path.join(dir, "codearts");
  writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(wrapper, 0o755);
  return dir;
}

/* ───── 测试替身：可记录的 Fake PtyChild 与 exec ───── */

interface FakeChild extends PtyChild {
  writes: string[];
  killCalls: number;
  isAlive: boolean;
  /** 模拟 PTY 输出 chunk 到达（StringDecoder 之前的数据已按字符串给出）。 */
  emit(chunk: string): void;
  /** 模拟底层进程死亡。 */
  die(): void;
}

function makeFakeChild(): FakeChild {
  let cb: ((chunk: string) => void) | null = null;
  const child: FakeChild = {
    pid: 424242,
    writes: [],
    killCalls: 0,
    isAlive: true,
    onData(fn) {
      cb = fn;
    },
    write(data) {
      child.writes.push(data);
    },
    kill() {
      child.killCalls++;
      child.isAlive = false;
    },
    alive() {
      return child.isAlive;
    },
    emit(chunk) {
      cb?.(chunk);
    },
    die() {
      child.isAlive = false;
    },
  };
  return child;
}

/** exec 记录器：捕获 spawnPty 的 (args, env) 并返回指定 child。 */
function recordingExec(child: PtyChild) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  return {
    calls,
    exec: {
      spawnPty(args: string[], env: NodeJS.ProcessEnv): PtyChild {
        calls.push({ args, env });
        return child;
      },
    },
  };
}

/** 多子进程 exec 记录器：每次 spawnPty 产出新 fake child（修复环裁定③ 重建语义测试用）。 */
function multiChildExec() {
  const children: FakeChild[] = [];
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  return {
    children,
    calls,
    exec: {
      spawnPty(args: string[], env: NodeJS.ProcessEnv): PtyChild {
        calls.push({ args, env });
        const c = makeFakeChild();
        c.pid = 500000 + children.length;
        children.push(c);
        return c;
      },
    },
  };
}

/** 真实 spawn：经 nodeScriptSpawnPty 以 script(1) 包装 bash fixture（离线本地）。 */
function realExec(scenario?: string): { exec: { spawnPty(args: string[], env: NodeJS.ProcessEnv): PtyChild } } {
  const cmd = `bash ${shQuote(FIXTURE)}${scenario ? ` --scenario ${scenario}` : ""}`;
  return {
    exec: {
      spawnPty(args: string[], env: NodeJS.ProcessEnv): PtyChild {
        // 透传传输层构造的 script 参数形态，仅替换 -c 的命令为 fixture（R-p5 允许真实 spawn）
        return nodeScriptSpawnPty(["script", "-qefc", cmd, "/dev/null"], env);
      },
    },
  };
}

/* ───── 测试辅助 ───── */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 限时收集信号直至谓词命中（超时抛错，避免用例悬挂）。 */
async function collectUntil(
  iter: AsyncIterator<Signal>,
  until: (sig: Signal, acc: string) => boolean,
  timeoutMs = 5000,
): Promise<{ got: Signal[]; acc: string }> {
  const got: Signal[] = [];
  let acc = "";
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`collectUntil 超时（${timeoutMs}ms）；已收 ${got.length} 条，累计文本=${JSON.stringify(acc)}`);
    const r = await Promise.race([
      iter.next(),
      sleep(remaining).then(() => null),
    ]);
    if (r === null) throw new Error(`collectUntil 超时（等待 next 挂起）；累计文本=${JSON.stringify(acc)}`);
    if (r.done) return { got, acc };
    got.push(r.value);
    if (r.value.text !== undefined) acc += r.value.text;
    if (until(r.value, acc)) return { got, acc };
  }
}

/**
 * /proc 扫描：argv 元素命中谓词的进程 pid 列表（R-p4 全树核对）。
 * 用 argv 元素级匹配（marker 取 argv[0] 全等 / fixture 取元素包含路径），
 * 而非整串子串匹配——否则任何 cmdline 里恰好含同款字样的进程（例如外层
 * shell 的 -c 载荷、grep/pgrep 模式串）都会被误杀/误报（实测发生过）。
 */
function findProcs(match: (argv: string[]) => boolean): number[] {
  const out: number[] = [];
  for (const ent of readdirSync("/proc")) {
    if (!/^\d+$/.test(ent)) continue;
    try {
      const argv = readFileSync(`/proc/${ent}/cmdline`, "utf8")
        .split("\0")
        .filter((a) => a !== "");
      if (match(argv)) out.push(Number(ent));
    } catch {
      // 进程在扫描间隙消失：不计
    }
  }
  return out;
}

/** 标记孙进程（exec -a 改 argv[0]，全等匹配）。 */
const isMarkerProc = (argv: string[]): boolean => argv[0] === "codearts-tree-marker";

/** fixture 相关进程（fixture bash 或其 script 宿主：argv 元素含 fixture 文件名）。 */
const isFixtureProc = (argv: string[]): boolean => argv.some((a) => a.includes("fake-tui.sh"));

/** pid 存活判定（僵尸进程 /proc/<pid> 仍存在，cmdline 为空——按存在性核比较严格）。 */
function existsPid(pid: number): boolean {
  try {
    accessSync(`/proc/${pid}`, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** 轮询直至谓词成立或超时（真实时间，限时毫秒级）。 */
async function pollUntil(p: () => boolean, timeoutMs: number, what: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!p()) {
    if (Date.now() > deadline) throw new Error(`pollUntil 超时：${what}`);
    await sleep(25);
  }
}

/** 每用例注册清理动作（observe 迭代终结 + stop + 临时目录），防 watcher/进程泄漏悬挂。 */
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/** 为一个用例创建 script 传输（默认真实时钟；两段式时延测试注入假时钟）。 */
function makeTransport(
  exec: { spawnPty(args: string[], env: NodeJS.ProcessEnv): PtyChild },
  opts?: { clock?: (ms: number) => Promise<void> },
) {
  const t = createScriptTransport(exec, opts);
  cleanups.push(async () => {
    /* 无全局会话清单；各用例自行 stop（幂等） */
  });
  return t;
}

/* ───── 用例 ───── */

describe("createScriptTransport.start / R-p5 argv 形态", () => {
  it("start 经 exec.spawnPty 以 argv 数组传递 script 参数与 env（禁 shell 拼接注入）", async () => {
    const child = makeFakeChild();
    const { calls, exec } = recordingExec(child);
    const t = makeTransport(exec);
    const ref = await t.start(CFG);
    expect(ref.kind).toBe("pty");
    expect(ref.id).toMatch(/^script-/);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args).toEqual([
      "script",
      "-qefc",
      shQuote(`${CFG.installDir}/codearts`),
      "/dev/null",
    ]);
    expect(calls[0]!.env).toBe(process.env);
  });

  it("官方 wrapper 缺失 → WRAPPER_MISSING（禁静默回退 bin 直启；spawnPty 零调用）", async () => {
    mkdirSync(TMP_ROOT, { recursive: true });
    const empty = mkdtempSync(path.join(TMP_ROOT, "no-wrapper-"));
    const cfgBad = loadConfig({ stateDir: "/nonexistent/s", installDir: empty }, {});
    const { calls, exec } = recordingExec(makeFakeChild());
    const t = makeTransport(exec);
    await expect(t.start(cfgBad)).rejects.toMatchObject({ code: "WRAPPER_MISSING" });
    expect(calls).toHaveLength(0); // 未发生任何 spawn：不回退 <installDir>/bin/codearts 直启
  });

  it("installDir 含空格时命令串经 shQuote 转义（script -c 为 sh 语义）", async () => {
    const spaced = makeWrapperInstall("dir with space-");
    const cfg2 = loadConfig(
      { stateDir: "/nonexistent/s", installDir: spaced },
      {},
    );
    const { calls, exec } = recordingExec(makeFakeChild());
    const t = makeTransport(exec);
    await t.start(cfg2);
    expect(calls[0]!.args![2]).toBe(shQuote(path.join(spaced, "codearts")));
  });

  it("start 复用：存活会话幂等返回同 ref；已死会话 → 同名重建（③）；未知 ref → 跨守护采纳重建（③）；非法 ref 显式拒绝", async () => {
    const h = multiChildExec();
    const t = makeTransport(h.exec);
    const ref = await t.start(CFG);
    const again = await t.start(CFG, ref);
    expect(again).toEqual(ref);
    expect(h.children.length).toBe(1); // 存活幂等：不重复 spawn

    h.children[0]!.die();
    const rebuilt = await t.start(CFG, ref); // ③：已死同名会话 → 重建活会话
    expect(rebuilt).toEqual(ref);
    expect(await t.alive(rebuilt)).toBe(true);
    expect(h.children.length).toBe(2);

    const adopted = await t.start(CFG, { kind: "pty", id: "script-42" }); // ③：跨守护重启（未知 ref）→ 采纳重建
    expect(adopted.id).toBe("script-42");
    expect(await t.alive(adopted)).toBe(true);

    // 非法 ref（kind 不符 / 空 id）：显式拒绝，零 spawn
    const before = h.calls.length;
    await expect(t.start(CFG, { kind: "structured", id: "script-1" })).rejects.toMatchObject({
      code: "SESSION_UNKNOWN",
    });
    await expect(t.start(CFG, { kind: "pty", id: "" })).rejects.toMatchObject({
      code: "SESSION_UNKNOWN",
    });
    expect(h.calls.length).toBe(before);
  });
});

describe("修复环第 1 轮（真机 T4-02 缺陷③④）：死会话重建与 alive 布尔契约", () => {
  it("③ 已死会话 start(ref) 重建细节：新 child 承载新生命期（raw/队列清空、pid 更新）；已死 child 无残余可补杀", async () => {
    const h = multiChildExec();
    const t = makeTransport(h.exec);
    const ref = await t.start(CFG);
    h.children[0]!.emit("旧生命期输出");
    h.children[0]!.die(); // 外部杀进程（非 stop）：child 已死，无进程组残留
    const ref2 = await t.start(CFG, ref);
    expect(ref2).toEqual(ref);
    expect(h.children[0]!.killCalls).toBe(0); // 已死进程不补杀（存活守卫：仅残余进程才组杀）
    expect(h.children.length).toBe(2);
    h.children[1]!.emit("fresh");
    const snap = await t.snapshot(ref2);
    expect(snap.raw).toBe("fresh"); // 旧输出不属新生命期（与 tmux 同名重建同口径）
    expect(snap.meta.pid).toBe(h.children[1]!.pid);
    expect(snap.meta.alive).toBe(true);
  });

  it("③ 重建回传前自检：spawn 后 child 即刻死亡 → PTY_START_FAILED 显式报错（不回传死 ref）", async () => {
    const h = multiChildExec();
    const t = makeTransport(h.exec);
    const ref = await t.start(CFG);
    // 替换 spawn 行为：下一 spawn 直接产出已死 child（模拟 wrapper 启动即崩）
    h.exec.spawnPty = (args, env) => {
      const c = makeFakeChild();
      c.die();
      return c;
    };
    h.children[0]!.die();
    await expect(t.start(CFG, ref)).rejects.toMatchObject({ code: "PTY_START_FAILED" });
  });

  it("④ alive 是布尔查询：未知 ref → false（不抛错）；已 stop ref → false（不抛错）", async () => {
    const t = makeTransport(multiChildExec().exec);
    await expect(t.alive({ kind: "pty", id: "script-999" })).resolves.toBe(false); // 守护重启对账必经路径
    await expect(t.alive({ kind: "structured", id: "script-1" })).resolves.toBe(false); // kind 不符亦 false
    const ref = await t.start(CFG);
    await t.stop(ref);
    await expect(t.alive(ref)).resolves.toBe(false);
  });
});

describe("R-p1 两段式注入", () => {
  it("inject = write(text) → 可注入时钟等待 120ms → write(\"\\r\")，三次调用依序", async () => {
    const child = makeFakeChild();
    const { exec } = recordingExec(child);
    const order: string[] = [];
    const clock = async (ms: number): Promise<void> => {
      order.push(`clock:${ms}`);
    };
    const t = makeTransport(exec, { clock });
    const ref = await t.start(CFG);
    await t.inject(ref, "继续");
    expect(order).toEqual(["clock:120"]);
    expect(child.writes).toEqual(["继续", "\r"]);
  });

  it("② 多行注入（修复环裁定② 2026-10-31）：多行文本合法——整块一次性写入（TUI 粘贴语义）→ 120ms → 独立 \\r 提交", async () => {
    const child = makeFakeChild();
    const { exec } = recordingExec(child);
    const order: string[] = [];
    const clock = async (ms: number): Promise<void> => {
      order.push(`clock:${ms}`);
    };
    const t = makeTransport(exec, { clock });
    const ref = await t.start(CFG);
    const text = "【/goal 契约】\n目标：实现登录页\n步骤协议：[GOAL-STEP n/N] …";
    await t.inject(ref, text);
    expect(child.writes).toEqual([text, "\r"]); // 整块写入 + 独立提交（两段式时序保留）
    expect(order).toEqual(["clock:120"]);
  });

  it("inject 对未知 ref → SESSION_UNKNOWN；对已 stop 会话 → SESSION_NOT_ALIVE 且不写", async () => {
    const child = makeFakeChild();
    const t = makeTransport(recordingExec(child).exec);
    await expect(t.inject({ kind: "pty", id: "nope" }, "x")).rejects.toMatchObject({
      code: "SESSION_UNKNOWN",
    });
    const ref = await t.start(CFG);
    await t.stop(ref);
    await expect(t.inject(ref, "x")).rejects.toMatchObject({ code: "SESSION_NOT_ALIVE" });
    expect(child.writes).toEqual([]);
  });
});

describe("observe：PTY 输出信号化（fake child 确定性用例）", () => {
  it("chunk 按序成为 output 信号；单观察者：并发第二 observe 显式 OBSERVER_ACTIVE", async () => {
    const child = makeFakeChild();
    const t = makeTransport(recordingExec(child).exec);
    const ref = await t.start(CFG);
    child.emit("alpha");
    child.emit("beta");

    const iter = t.observe(ref)[Symbol.asyncIterator]();
    const r1 = await iter.next();
    expect(r1.value).toMatchObject({ t: "output", text: "alpha" });
    expect(() => t.observe(ref)).toThrow(BridgeError);
    const r2 = await iter.next();
    expect(r2.value).toMatchObject({ t: "output", text: "beta" });
    await iter.return?.(undefined);
    // 迭代结束后观察者名额释放，可再次 observe
    const iter2 = t.observe(ref)[Symbol.asyncIterator]();
    await iter2.return?.(undefined);
  });

  it("R-p3 abort：未开始即取消 → 空迭代；残存保留给下一次 observe；挂起中 abort → 正常落定（T9 基准同态）", async () => {
    const child = makeFakeChild();
    const t = makeTransport(recordingExec(child).exec);
    const ref = await t.start(CFG);
    child.emit("residual");

    // ① 已 abort 的 signal 传入：立即正常结束的空迭代（残存不消费、不销毁）
    const ac1 = new AbortController();
    ac1.abort();
    const got: Signal[] = [];
    for await (const sig of t.observe(ref, { signal: ac1.signal })) got.push(sig);
    expect(got).toEqual([]);

    // ② 残存保留给下一次 observe（与 FakeTransport 行为同态）
    const iter = t.observe(ref)[Symbol.asyncIterator]();
    expect((await iter.next()).value).toMatchObject({ text: "residual" });
    await iter.return?.(undefined);

    // ③ 挂起等待中 abort：pending next 正常落定（done=true，不抛错）
    const ac2 = new AbortController();
    const iter2 = t.observe(ref, { signal: ac2.signal })[Symbol.asyncIterator]();
    const pending = iter2.next(); // 队列空 → 挂起
    ac2.abort();
    expect((await pending).done).toBe(true);
    await iter2.return?.(undefined);
  });

  it("exit 检测：底层进程死后 alive=false，observe 产出 done 信号后自然结束（不挂起）", async () => {
    const child = makeFakeChild();
    const t = makeTransport(recordingExec(child).exec);
    const ref = await t.start(CFG);
    const iter = t.observe(ref)[Symbol.asyncIterator]();
    child.die(); // 底层进程死亡（无 onExit 接口，经轮询 tick 检测）
    const { got } = await collectUntil(iter, (sig) => sig.t === "done", 3000);
    expect(got.at(-1)!.t).toBe("done");
    expect(await t.alive(ref)).toBe(false);
    expect((await iter.next()).done).toBe(true);
  });

  it("stop：child.kill 恰调一次、alive=false、挂起 observe 正常终止、stop 幂等、后续 observe 立即空迭代", async () => {
    const child = makeFakeChild();
    const t = makeTransport(recordingExec(child).exec);
    const ref = await t.start(CFG);
    child.emit("before-stop");
    const iter = t.observe(ref)[Symbol.asyncIterator]();
    expect((await iter.next()).value).toMatchObject({ text: "before-stop" });
    const pending = iter.next();
    await t.stop(ref);
    expect((await pending).done).toBe(true);
    expect(child.killCalls).toBe(1);
    expect(await t.alive(ref)).toBe(false);

    await t.stop(ref); // 幂等：不再 kill
    expect(child.killCalls).toBe(1);
    const got: Signal[] = [];
    for await (const sig of t.observe(ref)) got.push(sig);
    expect(got).toEqual([]);
  });
});

describe("observe：日志信号源（R-p2，实跑 fixture）", () => {
  it("追加 service=om 行 → output 信号；基线前已存在行不产信号", async () => {
    const { exec } = realExec("stall");
    const t = makeTransport(exec);
    const ref = await t.start(CFG);

    const kdir = makeKernelDir("log-");
    const logDir = path.join(kdir, "log");
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "kernel-a.log");
    writeFileSync(logFile, "INFO boot ok\nWARN old service=om-before\n");
    cleanups.push(async () => rmSync(kdir, { recursive: true, force: true }));

    const iter = t.observe(ref, { kernelDataDir: kdir })[Symbol.asyncIterator]();
    // observe 返回后（基线已定）再追加增量行
    appendFileSync(logFile, "INFO new service=om-after\n");
    const { got, acc } = await collectUntil(iter, (_s, acc2) => acc2.includes("om-after"));
    expect(got.every((s) => s.t === "output")).toBe(true);
    expect(acc).toContain("om-after");
    expect(acc).not.toContain("om-before");
    await iter.return?.(undefined);
    await t.stop(ref);
  });

  it("日志文件缺失（目录不存在）→ 不报错、无日志信号；snapshot.meta.log 如实标注不可用", async () => {
    const { exec } = realExec("stall");
    const t = makeTransport(exec);
    const ref = await t.start(CFG);
    const iter = t.observe(ref, { kernelDataDir: path.join(TMP_ROOT, "no-such-dir") })[Symbol.asyncIterator]();
    const p = iter.next();
    const r = await Promise.race([p, sleep(600).then(() => null)]);
    expect(r).toBeNull(); // 600ms 内无任何日志信号（亦未抛错）
    await t.stop(ref); // 唤醒挂起 next → 迭代正常终止
    expect((await p).done).toBe(true);
    const snap = await t.snapshot(ref);
    expect(snap.meta.log).toMatchObject({ available: false, file: null });
  });

  it("轮转：observe 中旧文件删除、新文件建立并写入 service 行 → 信号来自新文件且 meta.log.file 更新", async () => {
    const { exec } = realExec("stall");
    const t = makeTransport(exec);
    const ref = await t.start(CFG);

    const kdir = makeKernelDir("rot-");
    const logDir = path.join(kdir, "log");
    mkdirSync(logDir, { recursive: true });
    const fileA = path.join(logDir, "kernel-a.log");
    writeFileSync(fileA, "old baseline\n");
    cleanups.push(async () => rmSync(kdir, { recursive: true, force: true }));

    const iter = t.observe(ref, { kernelDataDir: kdir })[Symbol.asyncIterator]();
    // 轮转：删 A 建 B（mtime 更新 → newest 切换），B 从头读（全新内容）
    rmSync(fileA);
    const fileB = path.join(logDir, "kernel-b.log");
    appendFileSync(fileB, "INFO rotated service=om-rotated\n");
    const { acc } = await collectUntil(iter, (_s, a) => a.includes("om-rotated"));
    expect(acc).toContain("service=om-rotated");
    expect(acc).not.toContain("old baseline");

    const snap = await t.snapshot(ref);
    expect(snap.meta.log).toMatchObject({ available: true, file: "kernel-b.log" });
    await iter.return?.(undefined);
    await t.stop(ref);
  });
});

describe("observe：真实 PTY 往返（script -qefc 实跑 fixture，R-p5/R-p6）", () => {
  it("注入文本回显 [RX:<text>] 与 [ENTER] 依序成为 output 信号（两段式提交端到端）", async () => {
    const { exec } = realExec();
    const t = makeTransport(exec);
    const ref = await t.start(CFG);
    const iter = t.observe(ref)[Symbol.asyncIterator]();
    cleanups.push(async () => {
      await t.stop(ref);
    });
    await t.inject(ref, "hello");
    const { acc } = await collectUntil(iter, (_s, a) => a.includes("[ENTER]"));
    // 回显顺序：注入文本回显/fixture 回显在前，[ENTER] 在后
    expect(acc).toContain("[RX:hello]");
    expect(acc.indexOf("[RX:hello]")).toBeLessThan(acc.indexOf("[ENTER]"));
    await iter.return?.(undefined);
  });

  it("R-p6 UTF-8 跨 chunk：多字节序列拆两半写入 → 信号文本完整还原\"你好\"", async () => {
    const { exec } = realExec("utf8");
    const t = makeTransport(exec);
    const ref = await t.start(CFG);
    const iter = t.observe(ref)[Symbol.asyncIterator]();
    const { acc } = await collectUntil(iter, (_s, a) => a.includes("你好"));
    expect(acc).toContain("你好");
    await iter.return?.(undefined);
    await t.stop(ref);
  });

  it("exit 场景：进程死后 alive=false 且 observe 结束（done 信号后迭代终止，不挂起）", async () => {
    const { exec } = realExec("exit");
    const t = makeTransport(exec);
    const ref = await t.start(CFG);
    const iter = t.observe(ref)[Symbol.asyncIterator]();
    const { got } = await collectUntil(iter, (s) => s.t === "done");
    expect(got.at(-1)!.t).toBe("done");
    expect(await t.alive(ref)).toBe(false); // done 已产出：进程死亡已确认
    expect((await iter.next()).done).toBe(true);
  });

  it("error 场景（exit=3）：同样产出 done 信号并终止（退出码属 TUI 语义，宿主如实转达结束）", async () => {
    const { exec } = realExec("error");
    const t = makeTransport(exec);
    const ref = await t.start(CFG);
    const iter = t.observe(ref)[Symbol.asyncIterator]();
    const { acc } = await collectUntil(iter, (s) => s.t === "done");
    expect(acc).toContain("[FAKE-ERROR]");
    expect((await iter.next()).done).toBe(true);
  });
});

describe("R-p4 stop 进程组终止（实跑 family 场景，/proc 全树核对）", () => {
  it("stop 后宿主 script、fixture bash、标记孙进程全部消失；stop 幂等", async () => {
    // 清场：清掉此前异常残留的本套件 fixture 进程（argv 精确匹配，不误伤他者）
    for (const pid of [...findProcs(isMarkerProc), ...findProcs(isFixtureProc)]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // 已消失：不计
      }
    }
    await pollUntil(
      () => findProcs(isMarkerProc).length === 0 && findProcs(isFixtureProc).length === 0,
      3000,
      "前置清场应完成",
    );

    const { exec } = realExec("family");
    const t = makeTransport(exec);
    const ref = await t.start(CFG);
    cleanups.push(async () => {
      await t.stop(ref);
    });
    // 等标记孙进程出现（fixture 启动 + 后台拉起）
    await pollUntil(() => findProcs(isMarkerProc).length > 0, 5000, "标记孙进程应出现");
    // pid 快照：stop 前的本树全体成员（宿主 script + fixture bash + 孙进程）
    const before = new Set<number>([...findProcs(isMarkerProc), ...findProcs(isFixtureProc)]);
    expect(before.size).toBeGreaterThanOrEqual(3);

    await t.stop(ref);
    // 全树无残留：快照中每个 pid 均消失（组杀 + PTY master 关闭 SIGHUP 级联）
    await pollUntil(
      () => [...before].every((p) => !existsPid(p)),
      3000,
      "进程树应全部终止",
    );
    expect(await t.alive(ref)).toBe(false);

    await t.stop(ref); // 幂等
    expect(await t.alive(ref)).toBe(false);
  });
});

describe("snapshot / alive", () => {
  it("raw 按 PTY 输出累积；meta 含 id/host/pid/alive/closed/log（观察前 log 不可用态如实标注）", async () => {
    const child = makeFakeChild();
    const t = makeTransport(recordingExec(child).exec);
    const ref = await t.start(CFG);
    child.emit("part-1");
    child.emit("part-2");
    const snap = await t.snapshot(ref);
    expect(snap.raw).toBe("part-1part-2");
    expect(snap.meta).toMatchObject({
      id: ref.id,
      kind: "pty",
      host: "script",
      pid: 424242,
      alive: true,
      closed: false,
      log: { available: false, file: null, serviceLines: 0 },
    });
    expect(await t.alive(ref)).toBe(true);
  });

  it("raw 封顶（终审修复波 F1）：超限 PTY 输出丢弃最旧字节保留最新 512KB 尾部；meta.rawDroppedBytes 如实计数", async () => {
    const child = makeFakeChild();
    const t = makeTransport(recordingExec(child).exec);
    const ref = await t.start(CFG);
    child.emit("y".repeat(600 * 1024));
    child.emit("TAIL-MARK");
    const snap = await t.snapshot(ref);
    expect(Buffer.byteLength(snap.raw, "utf8")).toBeLessThanOrEqual(512 * 1024);
    expect(snap.raw.endsWith("TAIL-MARK")).toBe(true); // 以尾部内容结尾（尾滚动）
    // 精确对账：累积总量（600K + 9B 尾标）− cap = 丢弃量
    expect(snap.meta.rawDroppedBytes).toBe(600 * 1024 + 9 - 512 * 1024);
  });

  it("serviceLines 计数与 log 可用性在观察后如实反映", async () => {
    const { exec } = realExec("stall");
    const t = makeTransport(exec);
    const ref = await t.start(CFG);
    const kdir = makeKernelDir("meta-");
    const logDir = path.join(kdir, "log");
    mkdirSync(logDir, { recursive: true });
    const logFile = path.join(logDir, "kernel-m.log");
    writeFileSync(logFile, "base\n");
    cleanups.push(async () => {
      rmSync(kdir, { recursive: true, force: true });
      await t.stop(ref);
    });

    const iter = t.observe(ref, { kernelDataDir: kdir })[Symbol.asyncIterator]();
    appendFileSync(logFile, "A service=om-1\n");
    await collectUntil(iter, (_s, a) => a.includes("om-1"));
    const snap = await t.snapshot(ref);
    expect(snap.meta.log).toMatchObject({ available: true, file: "kernel-m.log", serviceLines: 1 });
    await iter.return?.(undefined);
  });
});

describe("nodeScriptSpawnPty 生产缺省实现", () => {
  it("PATH 上不存在的可执行文件 → PTY_HOST_UNAVAILABLE 显式报错（不 spawn、无竞态）", () => {
    try {
      nodeScriptSpawnPty(["codearts-bridge-no-such-bin-xyz"], {});
      expect.unreachable();
    } catch (e) {
      expect((e as BridgeError).code).toBe("PTY_HOST_UNAVAILABLE");
    }
  });

  it("本机 script(1) 存在：可包装 /bin/echo 并产出输出（真实 PTY 冒烟）", async () => {
    const child = nodeScriptSpawnPty(["script", "-qefc", "echo smoke-ok", "/dev/null"], process.env);
    const chunks: string[] = [];
    child.onData((c) => chunks.push(c));
    await pollUntil(() => !child.alive(), 5000, "echo 应退出");
    expect(chunks.join("")).toContain("smoke-ok");
  });
});
