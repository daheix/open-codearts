/**
 * T2-04 structured 传输测试（bun:test）。
 *
 * 主控裁定对照（2026-10-31）：
 * - R-s1 回合=进程：每回合 spawn `<installDir>/bin/codearts run <prompt> --format
 *   json --print-logs`（argv 数组，禁 shell 拼接）；`--session <id>` 续接；session
 *   id 从事件行宽容提取（sessionID/session_id 首现）；非 JSON 行保留原文为 output
 *   信号（宽容解析，不静默丢弃）。
 * - R-s2 AK/SK 前置：start 前置检查 readAksk(cfg.akskFile)；缺失 →
 *   BridgeError(AKSK_MISSING)（remediation 含官方配置入口与 config.env 说明）；
 *   不静默转 PTY。
 * - R-s3 env 装配：沿用父进程全量环境 + 注入 CODEARTS_CLI_AK/SK；OPENCODE_MODE
 *   不注入（交由 run 子命令语义）。
 * - R-s4 并发=1：同一 ref 活跃回合中新回合显式错误（ROUND_ACTIVE）；kill=直接杀
 *   进程+进程组（detached+负 PID）；进程退出 → done/error 信号并清理。
 * - R-s5 事件→信号映射表（唯一真相源见 structured.ts 文件头）；classifyError：
 *   ECONNRESET/timeout/429/503 → retryable；认证失败 → fatal；其余 undefined。
 *
 * 隔离：fake exec 全离线（确定性、零进程）；真机链路经生产 seam
 * nodeRunSpawnProc 实跑 fake-run.ts fixture（wrapper + bun，绝不跑真实
 * codearts、不触真实 HOME）；FS 落点仅插件 test/.tmp/，afterEach 清理
 * （含 /proc 残留进程清扫，防用例中途失败跨用例污染）。
 */
import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { loadConfig, type BridgeConfig } from "../src/core/config";
import { BridgeError } from "../src/core/errors";
import {
  classifyError,
  createStructuredTransport,
  nodeRunSpawnProc,
  type ProcChild,
  type ProcExit,
} from "../src/core/transport/structured";
import type { SessionRef, Signal } from "../src/core/transport/types";

/** 测试用临时根（工作目录内 .tmp/，用后即删，禁系统临时目录）。 */
const TMP_ROOT = path.join(import.meta.dir, ".tmp", "t12");

/** fake-run.ts fixture 路径。 */
const FIXTURE = path.join(import.meta.dir, "fixtures", "fake-codearts", "fake-run.ts");

/* ───── 测试环境装配 ───── */

/** sh 单引号转义（wrapper 内路径，数据源仅测试临时路径）。 */
function shq(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

interface Ctx {
  root: string;
  cfg: BridgeConfig;
}

/**
 * 建立与真实环境完全隔离的测试上下文：临时 aksk 文件（缺省 AK/SK 就绪）+
 * installDir。withBin=true 时再写 `<installDir>/bin/codearts` wrapper（sh 脚本
 * exec bun 运行 fake-run.ts；scenario 固化在 wrapper 中——传输层只认 bin 路径，
 * 场景切换经重写 wrapper 实现）。
 */
function makeCtx(
  opts: {
    withBin?: boolean;
    scenario?: string;
    aksk?: "full" | "ak-only" | "empty-sk" | "none";
  } = {},
): Ctx {
  const akskMode = opts.aksk ?? "full";
  mkdirSync(TMP_ROOT, { recursive: true });
  const root = mkdtempSync(path.join(TMP_ROOT, "ctx-"));
  const akskFile = path.join(root, "config.env");
  if (akskMode === "full") writeFileSync(akskFile, "AK=ak-test\nSK=sk-test\n");
  else if (akskMode === "ak-only") writeFileSync(akskFile, "AK=ak-test\n");
  else if (akskMode === "empty-sk") writeFileSync(akskFile, "AK=ak-test\nSK=\n");
  // none：不写文件（缺失）
  const installDir = path.join(root, "installers");
  mkdirSync(installDir, { recursive: true });
  if (opts.withBin) {
    writeBinWrapper(installDir, opts.scenario);
  }
  const cfg = loadConfig({ stateDir: path.join(root, "state"), installDir, akskFile }, {});
  return { root, cfg };
}

/** 写 `<installDir>/bin/codearts` wrapper（scenario 可选固化）。 */
function writeBinWrapper(installDir: string, scenario?: string): string {
  const binDir = path.join(installDir, "bin");
  mkdirSync(binDir, { recursive: true });
  const scenarioArg = scenario ? ` --scenario ${scenario}` : "";
  const binPath = path.join(binDir, "codearts");
  writeFileSync(binPath, `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(FIXTURE)}${scenarioArg} "$@"\n`);
  chmodSync(binPath, 0o755); // 显式 chmod：writeFileSync 的 mode 受 umask 掩蔽
  return binPath;
}

/* ───── 测试替身：fake ProcChild / fake exec ───── */

interface FakeProc extends ProcChild {
  pid: number;
  killed: number;
  isAlive: boolean;
  exits: ProcExit[];
  emitLine(line: string): void;
  exit(code: number | null, signal: string | null): void;
}

function makeFakeProc(pid: number): FakeProc {
  let lineCb: ((line: string) => void) | null = null;
  let exitCb: ((e: ProcExit) => void) | null = null;
  const p: FakeProc = {
    pid,
    killed: 0,
    isAlive: true,
    exits: [],
    onLine(cb) {
      lineCb = cb;
    },
    onExit(cb) {
      exitCb = cb;
    },
    kill() {
      p.killed++;
      p.isAlive = false;
    },
    alive() {
      return p.isAlive;
    },
    emitLine(line) {
      lineCb?.(line);
    },
    exit(code, signal) {
      p.isAlive = false;
      const e: ProcExit = { code, signal };
      p.exits.push(e);
      exitCb?.(e);
    },
  };
  return p;
}

/** fake exec：记录每次 spawnProc 的 (args, env)，按调用序产出 fake child。 */
function makeFakeExec() {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const procs: FakeProc[] = [];
  return {
    calls,
    procs,
    exec: {
      spawnProc(args: string[], env: NodeJS.ProcessEnv): ProcChild {
        calls.push({ args, env });
        const p = makeFakeProc(1000 + procs.length);
        procs.push(p);
        return p;
      },
    },
  };
}

/** 生产 seam 真实 spawn（离线本地 fixture）。 */
const realExec = {
  spawnProc(args: string[], env: NodeJS.ProcessEnv): ProcChild {
    return nodeRunSpawnProc(args, env);
  },
};

/* ───── 测试辅助 ───── */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 断言 fn 拒绝并以指定 code 的 BridgeError 落定（禁静默兜底——未抛即失败）。 */
async function expectBridgeError(fn: () => Promise<unknown>, code: string): Promise<BridgeError> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    expect((e as BridgeError).code).toBe(code);
    return e as BridgeError;
  }
  throw new Error(`期望抛出 BridgeError(${code})，但未抛出`);
}

/** 同步版 expectBridgeError（observe/start 同步抛错路径）。 */
function expectSyncBridgeError(fn: () => unknown, code: string): BridgeError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(BridgeError);
    expect((e as BridgeError).code).toBe(code);
    return e as BridgeError;
  }
  throw new Error(`期望同步抛出 BridgeError(${code})，但未抛出`);
}

/** 限时收集信号直至谓词命中（超时抛错，避免用例悬挂）。 */
async function collectUntil(
  iter: AsyncIterator<Signal>,
  until: (sig: Signal, acc: string) => boolean,
  timeoutMs = 8000,
): Promise<{ got: Signal[]; acc: string }> {
  const got: Signal[] = [];
  let acc = "";
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`collectUntil 超时（${timeoutMs}ms）；已收 ${got.length} 条，累计文本=${JSON.stringify(acc)}`);
    }
    const r = await Promise.race([iter.next(), sleep(remaining).then(() => null)]);
    if (r === null) throw new Error(`collectUntil 超时（等待 next 挂起）；累计文本=${JSON.stringify(acc)}`);
    if (r.done) return { got, acc };
    got.push(r.value);
    if (r.value.text !== undefined) acc += r.value.text;
    if (until(r.value, acc)) return { got, acc };
  }
}

/** 迭代器封装（显式 return 释放观察者）。 */
function iterOf(t: AsyncIterable<Signal>): AsyncIterator<Signal> {
  return t[Symbol.asyncIterator]();
}

/** /proc 全量 cmdline 扫描（进程残留核对）。 */
function procCmdlines(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      out.push(readFileSync(path.join("/proc", entry, "cmdline")).toString("utf8").replaceAll("\0", " "));
    } catch {
      // 进程已消失：跳过（扫描语义）
    }
  }
  return out;
}

const hasFixtureMarker = (lines: string[], scenario?: string): boolean =>
  lines.some((c) => c.includes("fake-run.ts") && (scenario === undefined || c.includes(`--scenario ${scenario}`)));

/** 测试侧清场：杀掉一切残留的 fake-run.ts 进程（用例中途失败时防跨用例污染）。 */
function killLeftovers(): void {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = readFileSync(path.join("/proc", entry, "cmdline")).toString("utf8");
      if (cmd.includes("fake-run.ts")) process.kill(Number(entry), "SIGKILL");
    } catch {
      // 进程已消失：清场目标已达成
    }
  }
}

afterEach(() => {
  killLeftovers();
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/* ═══════ R-s2 AK/SK 前置检查（start 门控） ═══════ */

describe("R-s2 AK/SK 前置检查（start 门控）", () => {
  it("aksk 文件缺失 → start 抛 AKSK_MISSING，remediation 含官方配置入口与文件路径；零 spawn（不静默转 PTY）", async () => {
    const ctx = makeCtx({ aksk: "none" });
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const err = await expectBridgeError(() => t.start(ctx.cfg), "AKSK_MISSING");
    expect(err.remediation).toContain("https://codearts.huaweicloud.com/portal/settings/cli-auth");
    expect(err.remediation).toContain(ctx.cfg.akskFile);
    expect(fake.calls.length).toBe(0); // 前置失败绝不 spawn
  });

  it("仅 AK 无 SK、或 SK 为空串 → 均 AKSK_MISSING（凭据不完整视同缺失，显式报错）", async () => {
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ctx1 = makeCtx({ aksk: "ak-only" });
    await expectBridgeError(() => t.start(ctx1.cfg), "AKSK_MISSING");
    const ctx2 = makeCtx({ aksk: "empty-sk" });
    await expectBridgeError(() => t.start(ctx2.cfg), "AKSK_MISSING");
    expect(fake.calls.length).toBe(0);
  });

  it("AK/SK 就绪 → start 成功：ref.kind=structured；start(ref) 幂等返回同 ref", async () => {
    const ctx = makeCtx();
    const t = createStructuredTransport(makeFakeExec().exec);
    const ref = await t.start(ctx.cfg);
    expect(ref.kind).toBe("structured");
    const again = await t.start(ctx.cfg, ref);
    expect(again).toEqual(ref);
  });

  it("start(ref) 每次都重新执行前置检查（非缓存）：凭据文件删除后 start(ref) → AKSK_MISSING", async () => {
    const ctx = makeCtx();
    const t = createStructuredTransport(makeFakeExec().exec);
    const ref = await t.start(ctx.cfg);
    rmSync(ctx.cfg.akskFile);
    await expectBridgeError(() => t.start(ctx.cfg, ref), "AKSK_MISSING");
  });
});

/* ═══════ R-s1 回合=进程：argv/env 装配（fake exec 断言） ═══════ */

describe("R-s1 回合=进程：argv/env 装配", () => {
  it("首回合 argv = [bin, run, <prompt>, --format, json, --print-logs]（无 --session；prompt 含空格保持单元素）；env 注入 AK/SK 且全量继承父环境、OPENCODE_MODE 不注入", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "你好 世界");
    expect(fake.calls.length).toBe(1);
    const call = fake.calls[0]!;
    expect(call.args).toEqual([
      path.join(ctx.cfg.installDir, "bin", "codearts"),
      "run",
      "你好 世界",
      "--format",
      "json",
      "--print-logs",
    ]);
    // R-s3：CODEARTS_CLI_AK/SK 注入；其余字段沿用父进程全量环境（wrapper 字段语义）
    expect(call.env.CODEARTS_CLI_AK).toBe("ak-test");
    expect(call.env.CODEARTS_CLI_SK).toBe("sk-test");
    expect(call.env.PATH).toBe(process.env.PATH);
    expect(call.env.OPENCODE_MODE).toBe(process.env.OPENCODE_MODE); // 不注入：与父进程一致
  });

  it("session id 捕获（sessionID 首现）→ 第二回合 argv 含 --session <id>；后续行携带不同 id 不改写（首现优先）", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p1");
    fake.procs[0]!.emitLine('{"type":"session.id","sessionID":"ses-1"}');
    fake.procs[0]!.exit(0, null);
    await t.inject(ref, "p2");
    const args2 = fake.calls[1]!.args;
    expect(args2).toContain("--session");
    expect(args2[args2.indexOf("--session") + 1]).toBe("ses-1");
    fake.procs[1]!.emitLine('{"type":"message.part","sessionID":"ses-OTHER","part":{"text":"x"}}');
    fake.procs[1]!.exit(0, null);
    await t.inject(ref, "p3");
    const args3 = fake.calls[2]!.args;
    expect(args3[args3.indexOf("--session") + 1]).toBe("ses-1");
  });

  it("session_id 蛇形键同样宽容捕获（无 type 字段的事件行也扫描）；捕获前回合 argv 无 --session", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p1");
    expect(fake.calls[0]!.args.includes("--session")).toBe(false);
    fake.procs[0]!.emitLine('{"foo":"bar","session_id":"ses-snake"}');
    fake.procs[0]!.exit(0, null);
    await t.inject(ref, "p2");
    const args2 = fake.calls[1]!.args;
    expect(args2[args2.indexOf("--session") + 1]).toBe("ses-snake");
  });

  it("空 prompt 显式拒绝（INJECT_TEXT_EMPTY），零 spawn", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await expectBridgeError(() => t.inject(ref, ""), "INJECT_TEXT_EMPTY");
    expect(fake.calls.length).toBe(0);
  });
});

/* ═══════ R-s5 事件→信号映射（fake exec 确定性） ═══════ */

describe("R-s5 事件→信号映射", () => {
  it("映射表：session.id→step；message.part(part.text)→output；type=error(message)→error；非 JSON 行→output(原文)；未知 JSON 对象→output(原文)；顺序保持", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p");
    const p = fake.procs[0]!;
    p.emitLine('{"type":"session.id","sessionID":"ses-m"}');
    p.emitLine('{"type":"message.part","part":{"type":"text","text":"第一段"}}');
    p.emitLine("this is not json（日志噪声样本）");
    p.emitLine('{"type":"error","message":" boom "}');
    p.emitLine('{"type":"custom.event","payload":1}');
    p.emitLine('{"type":"message.part","part":{"text":"末段"}}');
    p.exit(0, null);
    const it = iterOf(t.observe(ref));
    const r1 = await it.next();
    expect(r1.value!.t).toBe("step"); // session.id → step
    expect(r1.value!.text).toBe('{"type":"session.id","sessionID":"ses-m"}');
    const r2 = await it.next();
    expect(r2.value!.t).toBe("output");
    expect(r2.value!.text).toBe("第一段"); // part.text 提取
    const r3 = await it.next();
    expect(r3.value!.t).toBe("output");
    expect(r3.value!.text).toBe("this is not json（日志噪声样本）"); // 非 JSON 原文保留
    const r4 = await it.next();
    expect(r4.value!.t).toBe("error");
    expect(r4.value!.text).toBe(" boom "); // message 提取
    const r5 = await it.next();
    expect(r5.value!.t).toBe("output");
    expect(r5.value!.text).toBe('{"type":"custom.event","payload":1}'); // 未知 JSON 原文
    const r6 = await it.next();
    expect(r6.value!.t).toBe("output");
    expect(r6.value!.text).toBe("末段");
    const r7 = await it.next();
    expect(r7.value!.t).toBe("done"); // 退出码 0 → done
    expect(r7.value!.text).toBeUndefined();
    const r8 = await it.next();
    expect(r8.done).toBe(true); // 迭代自然结束
  });

  it("退出码 0 → 一次性 done；done 后迭代结束（不重复交付）", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p");
    fake.procs[0]!.exit(0, null);
    const { got } = await collectUntil(iterOf(t.observe(ref)), (sig) => sig.t === "done");
    expect(got.filter((s) => s.t === "done").length).toBe(1);
  });

  it("退出码 7 → error 信号（text 含 code=7）、无 done、迭代结束（回合失败路径）", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p");
    fake.procs[0]!.exit(7, null);
    const it = iterOf(t.observe(ref));
    const r = await collectUntil(it, (sig) => sig.t === "error" && (sig.text ?? "").includes("code=7"));
    expect(r.got.some((s) => s.t === "done")).toBe(false);
    const next = await it.next();
    expect(next.done).toBe(true);
  });

  it("error 事件后正常退出 0 → error 与 done 都交付（error 事件 ≠ 回合失败，回合失败只看退出码）", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p");
    fake.procs[0]!.emitLine('{"type":"error","message":"warn-ish"}');
    fake.procs[0]!.exit(0, null);
    const { got } = await collectUntil(iterOf(t.observe(ref)), (sig) => sig.t === "done");
    expect(got.some((s) => s.t === "error" && s.text === "warn-ish")).toBe(true);
    expect(got.some((s) => s.t === "done")).toBe(true);
  });

  it("回合结束后再 observe → 立即正常结束的空迭代（不悬挂；回合=进程，空闲会话无信号流）", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p");
    fake.procs[0]!.emitLine('{"type":"message.part","part":{"text":"x"}}');
    fake.procs[0]!.exit(0, null);
    const it1 = iterOf(t.observe(ref));
    await collectUntil(it1, (sig) => sig.t === "done"); // 第一次观察消费完
    await it1.return?.(); // 释放观察者（单观察者模型）
    const it2 = iterOf(t.observe(ref));
    const r = await Promise.race([it2.next(), sleep(500).then(() => null)]);
    expect(r).not.toBeNull(); // 未悬挂
    expect(r!.done).toBe(true); // 且立即正常结束
  });

  it("snapshot：raw = output/error 信号文本按序累积（每行一条 \\n，step/done 不入 raw）；meta{host/codeartsSessionId/rounds/lastExit/alive}", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p");
    const p = fake.procs[0]!;
    p.emitLine('{"type":"session.id","sessionID":"ses-r"}');
    p.emitLine('{"type":"message.part","part":{"text":"甲"}}');
    p.emitLine('{"type":"error","message":"乙"}');
    p.exit(0, null);
    await collectUntil(iterOf(t.observe(ref)), (sig) => sig.t === "done");
    const snap = await t.snapshot(ref);
    expect(snap.raw).toBe("甲\n乙\n");
    expect(snap.meta.host).toBe("structured");
    expect(snap.meta.codeartsSessionId).toBe("ses-r");
    expect(snap.meta.rounds).toBe(1);
    expect(snap.meta.alive).toBe(true); // 回合结束 ≠ 会话死亡（可续接新回合）
    expect(snap.meta.lastExit).toEqual({ code: 0, signal: null });
  });

  it("raw 封顶（终审修复波 F1）：超限输出丢弃最旧字节保留最新 512KB 尾部；meta.rawDroppedBytes 如实计数（审计可见，非静默）", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p");
    const p = fake.procs[0]!;
    const big = "x".repeat(600 * 1024);
    p.emitLine(JSON.stringify({ type: "message.part", part: { text: big } }));
    p.emitLine('{"type":"message.part","part":{"text":"TAIL-MARK"}}');
    p.exit(0, null);
    const snap = await t.snapshot(ref);
    expect(Buffer.byteLength(snap.raw, "utf8")).toBeLessThanOrEqual(512 * 1024);
    expect(snap.raw.endsWith("TAIL-MARK\n")).toBe(true); // 以尾部内容结尾（尾滚动）
    // 精确对账：累积总量（600K 文本 + 每条 \n + 10B 尾标）− cap = 丢弃量
    expect(snap.meta.rawDroppedBytes).toBe(600 * 1024 + 1 + 10 - 512 * 1024);
  });
});

/* ═══════ classifyError（R-s5 纯函数） ═══════ */

describe("classifyError（R-s5 错误分级）", () => {
  it("ECONNRESET / timeout / 429 / 503 → retryable（大小写不敏感、行内子串命中）", () => {
    expect(classifyError("read ECONNRESET connection broken")).toBe("retryable");
    expect(classifyError("Request TIMEOUT after 30s")).toBe("retryable");
    expect(classifyError("HTTP 429 Too Many Requests")).toBe("retryable");
    expect(classifyError("upstream 503 Service Unavailable")).toBe("retryable");
  });

  it("认证失败 → fatal 且优先于 retryable；其余 → undefined", () => {
    expect(classifyError("认证失败，没有设置环境变量CODEARTS_CLI_AK/CODEARTS_CLI_SK")).toBe("fatal");
    expect(classifyError("认证失败且上游 503")).toBe("fatal"); // fatal 优先：重试无意义
    expect(classifyError(" everything is fine ")).toBeUndefined();
    expect(classifyError("")).toBeUndefined();
  });
});

/* ═══════ R-s4 并发与生命周期 ═══════ */

describe("R-s4 并发与生命周期", () => {
  it("活跃回合中 inject → ROUND_ACTIVE（并发=1）；回合结束后可再注入新回合", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p1");
    await expectBridgeError(() => t.inject(ref, "p2"), "ROUND_ACTIVE");
    fake.procs[0]!.exit(0, null);
    await t.inject(ref, "p3"); // 不误报
    expect(fake.calls.length).toBe(2);
  });

  it("stop：kill 进程（fake 记数）、alive=false、挂起 observe 立即结束且不产 done、stop 幂等", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p");
    const it = iterOf(t.observe(ref));
    const pending = it.next(); // 挂起等待
    await t.stop(ref);
    const r = await pending;
    expect(r.done).toBe(true); // 不产 done 信号，直接终止（与 Fake/PTY 同态）
    expect(fake.procs[0]!.killed).toBe(1);
    expect(await t.alive(ref)).toBe(false);
    await t.stop(ref); // 幂等
    expect(fake.procs[0]!.killed).toBe(1);
  });

  it("stop 后：inject → SESSION_NOT_ALIVE（终态拒绝注入）；start(ref) → 重建活会话（③ 裁定：可再发起新回合）", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p");
    fake.procs[0]!.exit(0, null);
    await t.stop(ref);
    await expectBridgeError(() => t.inject(ref, "q"), "SESSION_NOT_ALIVE");
    const ref2 = await t.start(ctx.cfg, ref); // ③：重建（终态复位）
    expect(ref2).toEqual(ref);
    expect(await t.alive(ref2)).toBe(true);
    await t.inject(ref2, "r"); // 重建后可发起新回合
    expect(fake.calls.length).toBe(2);
  });

  it("④ alive 布尔查询：未知 ref / kind 不符 → false（不抛错）", async () => {
    const ctx = makeCtx();
    const t = createStructuredTransport(makeFakeExec().exec);
    await t.start(ctx.cfg);
    const ghost: SessionRef = { kind: "structured", id: "structured-999" };
    const wrongKind: SessionRef = { kind: "pty", id: "structured-1" };
    await expect(t.alive(ghost)).resolves.toBe(false);
    await expect(t.alive(wrongKind)).resolves.toBe(false);
  });

  it("未知 ref（未注册 / kind 不符）→ 各方法 SESSION_UNKNOWN；alive 除外（④ 布尔查询）", async () => {
    const ctx = makeCtx();
    const t = createStructuredTransport(makeFakeExec().exec);
    await t.start(ctx.cfg);
    const ghost: SessionRef = { kind: "structured", id: "structured-999" };
    const wrongKind: SessionRef = { kind: "pty", id: "structured-1" };
    await expectBridgeError(() => t.inject(ghost, "x"), "SESSION_UNKNOWN");
    await expectBridgeError(() => t.inject(wrongKind, "x"), "SESSION_UNKNOWN");
    expectSyncBridgeError(() => t.observe(ghost), "SESSION_UNKNOWN");
    await expectBridgeError(() => t.stop(ghost), "SESSION_UNKNOWN");
    await expectBridgeError(() => t.snapshot(ghost), "SESSION_UNKNOWN");
  });

  it("并发第二 observe → OBSERVER_ACTIVE（单观察者）；结束后可重新 observe", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p");
    const it1 = iterOf(t.observe(ref));
    expectSyncBridgeError(() => t.observe(ref), "OBSERVER_ACTIVE");
    await it1.return?.(); // 释放观察者
    const it3 = iterOf(t.observe(ref)); // 释放后可重新 observe
    const pending = it3.next();
    fake.procs[0]!.emitLine('{"type":"message.part","part":{"text":"y"}}');
    const r = await pending;
    expect(r.value!.text).toBe("y");
    await it3.return?.();
  });

  it("abort（T9 基准）：未开始即取消→空迭代；消费部分后 abort→立即放弃（残存保留给下一次 observe）；挂起等待中 abort→正常落定不抛错", async () => {
    const ctx = makeCtx();
    const fake = makeFakeExec();
    const t = createStructuredTransport(fake.exec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p");
    // ① 未开始即取消：空迭代
    const ctrl0 = new AbortController();
    ctrl0.abort();
    const r0 = await iterOf(t.observe(ref, { signal: ctrl0.signal })).next();
    expect(r0.done).toBe(true);
    // ② 两条入队，消费一条后 abort → 立即放弃，"b" 留给下一次 observe
    const p = fake.procs[0]!;
    p.emitLine('{"type":"message.part","part":{"text":"a"}}');
    p.emitLine('{"type":"message.part","part":{"text":"b"}}');
    const ctrl = new AbortController();
    const it1 = iterOf(t.observe(ref, { signal: ctrl.signal }));
    const r1 = await it1.next();
    expect(r1.value!.text).toBe("a");
    ctrl.abort();
    const r2 = await it1.next();
    expect(r2.done).toBe(true); // abort → 立即放弃，不交付 "b"
    await it1.return?.();
    // ③ 残存保留：新观察者交付 "b"
    const it3 = iterOf(t.observe(ref));
    const r3 = await it3.next();
    expect(r3.value!.text).toBe("b");
    await it3.return?.();
    // ④ 挂起等待中 abort → next 正常落定（done），不抛错
    const ctrl2 = new AbortController();
    const it4 = iterOf(t.observe(ref, { signal: ctrl2.signal }));
    const pending = it4.next(); // 队列已空、回合未结束 → 挂起
    ctrl2.abort();
    const r4 = await pending;
    expect(r4.done).toBe(true);
  });
});

/* ═══════ 生产 seam nodeRunSpawnProc（真实进程，离线 fixture） ═══════ */

describe("nodeRunSpawnProc 生产 seam（真实进程，离线 fixture）", () => {
  it("bin 缺失 → inject 显式 STRUCTURED_SPAWN_FAILED；回合计数不增（spawn 前抛出）", async () => {
    const ctx = makeCtx({ withBin: false }); // installDir 无 bin/codearts
    const t = createStructuredTransport(realExec);
    const ref = await t.start(ctx.cfg);
    const err = await expectBridgeError(() => t.inject(ref, "p"), "STRUCTURED_SPAWN_FAILED");
    expect(err.remediation).toBeDefined();
    const snap = await t.snapshot(ref);
    expect(snap.meta.rounds).toBe(0);
  });

  it("e2e normal 全链：session.id→step、message.part→output×2、exit 0→done；raw/meta 如实", async () => {
    const ctx = makeCtx({ withBin: true, scenario: "normal" });
    const t = createStructuredTransport(realExec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "构建检查");
    const { got } = await collectUntil(iterOf(t.observe(ref)), (sig) => sig.t === "done");
    expect(got[0]!.t).toBe("step");
    expect(got[0]!.text ?? "").toContain("ses-fake-001");
    expect(got.some((s) => s.t === "output" && s.text === "回复:构建检查")).toBe(true);
    expect(got.some((s) => s.t === "output" && s.text === "done-part")).toBe(true);
    expect(got[got.length - 1]!.t).toBe("done");
    const snap = await t.snapshot(ref);
    expect(snap.meta.codeartsSessionId).toBe("ses-fake-001");
    expect(snap.meta.rounds).toBe(1);
    expect(snap.meta.lastExit).toEqual({ code: 0, signal: null });
    expect(snap.raw).toBe("回复:构建检查\ndone-part\n");
  });

  it("e2e 会话续接：第二回合（echo 场景）argv 经 wrapper 端到端含 --session ses-fake-001 与完整 prompt（空格不拆词）", async () => {
    const ctx = makeCtx({ withBin: true, scenario: "normal" });
    const t = createStructuredTransport(realExec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "你好 世界");
    const it1 = iterOf(t.observe(ref));
    await collectUntil(it1, (sig) => sig.t === "done");
    await it1.return?.(); // 释放观察者
    // 第二回合换 echo 场景 wrapper（同 installDir 重写 bin；spawn 逐回合读文件）
    writeBinWrapper(ctx.cfg.installDir, "echo");
    await t.inject(ref, "第二轮 指令");
    const { acc } = await collectUntil(iterOf(t.observe(ref)), (sig) => sig.t === "done");
    expect(acc).toContain("--session");
    expect(acc).toContain("ses-fake-001");
    expect(acc).toContain("第二轮 指令"); // prompt 含空格经 "$@" 透传不拆词（禁 shell 拼接的实证）
  });

  it("e2e env 注入：子进程 env 键存在性 set（值绝不跨进程边界——fixture 只输出 set/unset）", async () => {
    const ctx = makeCtx({ withBin: true, scenario: "env" });
    const t = createStructuredTransport(realExec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p");
    const { acc } = await collectUntil(iterOf(t.observe(ref)), (sig) => sig.t === "done");
    expect(acc).toContain('"CODEARTS_CLI_AK":"set"');
    expect(acc).toContain('"CODEARTS_CLI_SK":"set"');
    expect(acc).not.toContain("ak-test"); // 值未泄漏到子进程输出
    expect(acc).not.toContain("sk-test");
  });

  it("e2e crash：stderr 非 JSON 行→output(原文)；exit 7→error 信号含 code=7、无 done；meta.lastExit.code=7", async () => {
    const ctx = makeCtx({ withBin: true, scenario: "crash" });
    const t = createStructuredTransport(realExec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p");
    const it = iterOf(t.observe(ref));
    const { got } = await collectUntil(it, (sig) => sig.t === "error" && (sig.text ?? "").includes("code=7"));
    expect(got.some((s) => s.t === "output" && (s.text ?? "").includes("kernel panic"))).toBe(true);
    expect(got.some((s) => s.t === "done")).toBe(false);
    const snap = await t.snapshot(ref);
    expect((snap.meta.lastExit as ProcExit).code).toBe(7);
  });

  it("e2e stall + stop：进程组终止（detached+负 PID）——/proc 扫描 stop 前有、stop 后无残留", async () => {
    const ctx = makeCtx({ withBin: true, scenario: "stall" });
    const t = createStructuredTransport(realExec);
    const ref = await t.start(ctx.cfg);
    await t.inject(ref, "p");
    await collectUntil(iterOf(t.observe(ref)), (sig) => sig.t === "step"); // stall 已输出 session.id：进程就绪
    expect(hasFixtureMarker(procCmdlines(), "stall")).toBe(true);
    await t.stop(ref);
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && hasFixtureMarker(procCmdlines(), "stall")) {
      await sleep(100);
    }
    expect(hasFixtureMarker(procCmdlines(), "stall")).toBe(false);
    expect(await t.alive(ref)).toBe(false);
  }, 15000);
});
