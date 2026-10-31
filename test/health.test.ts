/**
 * T1-06 健康采样测试（bun:test）。
 *
 * 覆盖（任务书 Step1 + 主控裁定 R-h1..R-h5）：
 * - sizes：db/wal/dumps/logs 字节数与文件数（logs=log 目录递归总字节，dumps 为其中
 *   dump-*.heapsnapshot 子集，口径见 health.ts 头注）；
 * - kernelRssFromLog：按扫描序（kernel-*.log 文件 mtime 升序 + 行序）取最后一条 rssMB
 *   换算字节（R-h2"按行序取最后匹配"）；
 * - lastErrors：ERROR 前缀行 + 含关键词的 INFO/WARN 行；规范化摘要（剥离时间戳/耗时）、
 *   去重（×N 计数）、截断（显式标记）、上限 20 条、按时间序（R-h1）；
 * - 缺目录不抛错、零值如实报告（R-h4"容忍探测≠掩盖"）；IO 非 ENOENT 显式抛 BridgeError；
 * - PidProbe 注入（R-h5）：输出显式约定为十进制整数字节串；非法输出/探测失败显式报错。
 *
 * 隔离纪律（主控裁定）：绝不触碰真实 HOME；FS 落点全在 .tmp/health-test/，afterAll 清理。
 * kernelRssFromLog 用例特意让 mtime 较新的文件携带较旧的内嵌时间戳，钉死"扫描序而非
 * 时间戳序"这一裁定语义。
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../src/core/config";
import type { BridgeConfig } from "../src/core/config";
import { BridgeError } from "../src/core/errors";
import {
  HEALTH_MAX_ERROR_SUMMARY_CHARS,
  HEALTH_MAX_LAST_ERRORS,
  collectHealth,
} from "../src/core/health";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
const TEST_ROOT = path.join(PLUGIN_ROOT, ".tmp", "health-test");

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

/** 隔离配置（loadConfig 纯函数；路径全在本测试根内，绝不依赖真实 HOME）。 */
function cfgOf(): BridgeConfig {
  return loadConfig(
    {
      installDir: path.join(TEST_ROOT, "installers"),
      stateDir: path.join(TEST_ROOT, "state"),
    },
    {},
  );
}

/* ───── 真实日志样本（主控裁定 R-h1 提供的内核日志原样格式；新增行同格式仿写） ───── */

// 真实样本 1：error fetch + ECONNRESET（INFO 前缀 + 关键词命中）
const LINE_ECONNRESET = `INFO  2026-10-30T20:22:11.229 +25744ms service=proxy-fetch "error fetch:" fetchUrl={} error={message:"The socket connection was closed unexpectedly. For more information, pass \`verbose: true\` in the second argument to fetch()", name:"Error", code:"ECONNRESET", path:"https://…tar.gz"}`;
// 真实样本 2：error fetch + TimeoutError/timed out（INFO 前缀 + 关键词命中）
const LINE_TIMEOUT = `INFO  2026-10-30T20:35:15.779 +185ms service=proxy-fetch "error fetch:" fetchUrl=https://… error={message:"The operation timed out.", name:"TimeoutError", stack:""}`;
// 真实样本 3：ERROR 前缀行（custom-model-auth 403）
const LINE_AUTH_403 = `ERROR  2026-10-30T20:20:17.112 +1080ms service=custom-model-auth "request failed" baseUrl=… error=Request failed with status code 403 status=403`;
// 403 同型错误的重复出现：剥离时间戳/耗时后与 LINE_AUTH_403 同文本 → 去重 ×2
const LINE_AUTH_403_DUP = `ERROR  2026-10-30T20:58:00.000 +7ms service=custom-model-auth "request failed" baseUrl=… error=Request failed with status code 403 status=403`;
// WARN 前缀 + 关键词命中（timed out）
const LINE_WARN_TIMEOUT = `WARN  2026-10-30T20:27:00.000 +2ms service=provider-proxy "upstream timed out waiting" host=proxy.local`;
// ERROR 前缀行（upgrade 下载失败）
const LINE_UPGRADE = `ERROR  2026-10-30T21:00:00.000 +10ms service=upgrade "download failed" url=https://mirror.example.com/x.tar.gz error=ECONNRESET`;
// 无关键词普通 INFO 行（不得采集）
const LINE_PLAIN_INFO = `INFO  2026-10-30T20:26:00.000 +1ms service=session "poll ok" count=1`;
// 超长 ERROR 行（触发截断标记）
const LINE_LONG = `ERROR  2026-10-30T21:30:00.000 +1ms service=custom-model-loader "failed to decrypt apiKey for provider" providerKey=glm error={message:"${"x".repeat(600)}", name:"Error"}`;
// rssMB 自报（真实样本格式）；kernel-a 为较早文件（mtime 旧）
const LINE_RSS_A = `INFO  2026-10-30T20:49:52.104 +1ms service=om "当前进程内存使用情况" rssMB=100.50 heapUsedMB=155.13 heapTotalMB=90.35`;
// rssMB 自报：mtime 较新的 kernel-b 携带"更旧"的内嵌时间戳——按裁定仍取本条（扫描序）
const LINE_RSS_B = `INFO  2026-10-30T19:00:00.000 +2ms service=om "当前进程内存使用情况" rssMB=525.64 heapUsedMB=96.20`;

const KERNEL_A_LINES = [
  LINE_ECONNRESET,
  LINE_AUTH_403,
  LINE_RSS_A,
  LINE_PLAIN_INFO,
  LINE_WARN_TIMEOUT,
];

const KERNEL_B_LINES = [
  LINE_TIMEOUT,
  LINE_AUTH_403_DUP,
  LINE_UPGRADE,
  LINE_LONG,
  LINE_RSS_B,
];

/** 写入文本文件并返回其 UTF-8 字节数（期望值与实际写入共用同一计算，避免口径漂移）。 */
async function writeText(file: string, text: string): Promise<number> {
  await writeFile(file, text, "utf8");
  return Buffer.byteLength(text, "utf8");
}

interface HealthFixture {
  kernelDataDir: string;
  dbBytes: number;
  walBytes: number;
  dumpFiles: number;
  dumpBytes: number;
  logTotalBytes: number;
}

/**
 * 构造完整 cli-data 目录树（含 db/wal/内核日志/异构日志/转储/杂项/子目录）。
 * kernel-a mtime=2026-01-01、kernel-b mtime=2026-06-01 → 扫描序 a→b 与写入顺序无关。
 */
async function makeFullFixture(root: string): Promise<HealthFixture> {
  const kernelDataDir = path.join(root, "cli-data");
  const logDir = path.join(kernelDataDir, "log");
  await mkdir(path.join(logDir, "sub"), { recursive: true });

  const dbBytes = await writeText(path.join(kernelDataDir, "opencode.db"), "db".repeat(500));
  const walBytes = await writeText(path.join(kernelDataDir, "opencode.db-wal"), "wal".repeat(83));

  const bytesA = await writeText(path.join(logDir, "kernel-a.log"), KERNEL_A_LINES.join("\n") + "\n");
  const bytesB = await writeText(path.join(logDir, "kernel-b.log"), KERNEL_B_LINES.join("\n") + "\n");
  // 异构格式日志（experience-*.log 是另一套格式，不得参与解析，但计入目录总字节）
  const bytesE = await writeText(
    path.join(logDir, "experience-2026-10-30.0.log"),
    "[2026/10/30 00:00:19.000] [WARN] state-sizes extractionStates=0\n",
  );
  const dump1 = await writeText(path.join(logDir, "dump-1GB.heapsnapshot"), "d".repeat(40));
  const dump2 = await writeText(path.join(logDir, "dump-2GB.heapsnapshot"), "e".repeat(60));
  const notes = await writeText(path.join(logDir, "notes.txt"), "notes\n");
  const inner = await writeText(path.join(logDir, "sub", "inner.log"), "in\nok");

  // mtime 固定：kernel-a 最旧、kernel-b 较新（扫描序确定性，不依赖写入先后）
  await utimes(path.join(logDir, "kernel-a.log"), new Date(0), new Date("2026-01-01T00:00:00Z"));
  await utimes(path.join(logDir, "kernel-b.log"), new Date(0), new Date("2026-06-01T00:00:00Z"));

  return {
    kernelDataDir,
    dbBytes,
    walBytes,
    dumpFiles: 2,
    dumpBytes: dump1 + dump2,
    logTotalBytes: bytesA + bytesB + bytesE + dump1 + dump2 + notes + inner,
  };
}

describe("collectHealth sizes（db/wal/dumps/logs）", () => {
  it("db/wal 字节数、dumps 文件数与字节、log 目录递归总字节均正确", async () => {
    const fx = await makeFullFixture(path.join(TEST_ROOT, "sizes"));
    const snap = await collectHealth(cfgOf(), { kernelDataDir: fx.kernelDataDir });

    expect(snap.dbBytes).toBe(fx.dbBytes);
    expect(snap.walBytes).toBe(fx.walBytes);
    expect(snap.dumps.files).toBe(fx.dumpFiles);
    expect(snap.dumps.bytes).toBe(fx.dumpBytes);
    // logs=整个 log 目录递归总字节（含 dumps 子集、异构日志、杂项与子目录）
    expect(snap.logs.bytes).toBe(fx.logTotalBytes);
  });

  it("kernelRssFromLog：按扫描序取最后一条 rssMB（mtime 新者胜出，即使内嵌时间戳更旧）", async () => {
    const fx = await makeFullFixture(path.join(TEST_ROOT, "rss"));
    const snap = await collectHealth(cfgOf(), { kernelDataDir: fx.kernelDataDir });
    expect(snap.kernelRssFromLog).toBe(Math.round(525.64 * 1024 * 1024));
  });
});

describe("collectHealth lastErrors（R-h1 采集/去重/截断/上限/时序）", () => {
  it("采集 ERROR 前缀与关键词 INFO/WARN 行；去重 ×2；普通 INFO 不采集；按时间序", async () => {
    const fx = await makeFullFixture(path.join(TEST_ROOT, "errors"));
    const snap = await collectHealth(cfgOf(), { kernelDataDir: fx.kernelDataDir });
    const errs = snap.lastErrors;

    // 6 个唯一错误：ECONNRESET fetch / WARN timeout / TimeoutError fetch / 403(×2) / upgrade / 超长截断
    expect(errs.length).toBe(6);

    // 按内嵌时间戳升序（lastSeen 口径）：20:22 → 20:27 → 20:35 → 20:58(403 重复) → 21:00 → 21:30
    expect(errs[0]).toStartWith(`INFO service=proxy-fetch "error fetch:"`);
    expect(errs[0]).toContain("ECONNRESET");
    expect(errs[1]).toBe(`WARN service=provider-proxy "upstream timed out waiting" host=proxy.local`);
    expect(errs[2]).toContain("TimeoutError");
    expect(errs[3]).toStartWith(`ERROR service=custom-model-auth "request failed"`);
    expect(errs[3]).toEndWith("status=403 ×2");
    expect(errs[4]).toStartWith(`ERROR service=upgrade "download failed"`);
    expect(errs[5]).toContain("[截断");

    // 普通无关键词 INFO 行不得混入
    for (const e of errs) expect(e).not.toContain("poll ok");
  });

  it("超长行截断：摘要长度受限且带显式截断标记（禁静默截断）", async () => {
    const fx = await makeFullFixture(path.join(TEST_ROOT, "truncate"));
    const snap = await collectHealth(cfgOf(), { kernelDataDir: fx.kernelDataDir });
    const long = snap.lastErrors.at(-1);
    expect(long).toBeDefined();
    expect(long).toContain("[截断");
    expect(long!.length).toBeLessThanOrEqual(HEALTH_MAX_ERROR_SUMMARY_CHARS + 40);
    expect(long!.length).toBeGreaterThan(HEALTH_MAX_ERROR_SUMMARY_CHARS);
  });

  it("上限 20 条：25 条不同错误只保留最近 20 条且保持时间序", async () => {
    const kernelDataDir = path.join(TEST_ROOT, "cap", "cli-data");
    const logDir = path.join(kernelDataDir, "log");
    await mkdir(logDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) {
      const mm = String(i).padStart(2, "0");
      lines.push(`ERROR  2026-10-30T00:${mm}:00.000 +0ms service=t "boom-${i}"`);
    }
    await writeFile(path.join(logDir, "kernel-c.log"), lines.join("\n") + "\n", "utf8");

    const snap = await collectHealth(cfgOf(), { kernelDataDir });
    expect(snap.lastErrors.length).toBe(HEALTH_MAX_LAST_ERRORS);
    expect(snap.lastErrors[0]).toContain('"boom-5"');
    expect(snap.lastErrors.at(-1)).toContain('"boom-24"');
    for (const e of snap.lastErrors) expect(e).not.toContain('"boom-4"');
  });
});

describe("collectHealth 容忍探测与非 ENOENT 错误（R-h4）", () => {
  it("kernelDataDir 整体缺失：零值快照、不抛错（缺失本身是健康状态的一部分）", async () => {
    const snap = await collectHealth(cfgOf(), {
      kernelDataDir: path.join(TEST_ROOT, "missing", "cli-data"),
    });
    expect(snap.dbBytes).toBe(0);
    expect(snap.walBytes).toBe(0);
    expect(snap.dumps).toEqual({ files: 0, bytes: 0 });
    expect(snap.logs.bytes).toBe(0);
    expect(snap.lastErrors).toEqual([]);
    expect(snap.kernelRssFromLog).toBeUndefined();
    expect(snap.rssBytes).toBeUndefined();
  });

  it("opencode.db 路径存在但不是常规文件（目录）→ FS_PATH_NOT_FILE 显式抛出", async () => {
    const kernelDataDir = path.join(TEST_ROOT, "db-is-dir", "cli-data");
    await mkdir(path.join(kernelDataDir, "opencode.db"), { recursive: true });
    try {
      await collectHealth(cfgOf(), { kernelDataDir });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe("FS_PATH_NOT_FILE");
    }
  });

  it("log 路径是常规文件（readdir ENOTDIR）→ FS_READ_FAILED 显式抛出", async () => {
    const kernelDataDir = path.join(TEST_ROOT, "log-is-file", "cli-data");
    await mkdir(kernelDataDir, { recursive: true });
    await writeFile(path.join(kernelDataDir, "log"), "not a dir\n");
    try {
      await collectHealth(cfgOf(), { kernelDataDir });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe("FS_READ_FAILED");
    }
  });
});

describe("collectHealth PidProbe 注入（R-h5）", () => {
  it("注入合法十进制整数字节串 → rssBytes 为该数值；未注入 → undefined", async () => {
    const fx = await makeFullFixture(path.join(TEST_ROOT, "pid-ok"));
    const withProc = await collectHealth(cfgOf(), {
      kernelDataDir: fx.kernelDataDir,
      proc: async () => " 52577 ",
    });
    expect(withProc.rssBytes).toBe(52577);

    const noProc = await collectHealth(cfgOf(), { kernelDataDir: fx.kernelDataDir });
    expect(noProc.rssBytes).toBeUndefined();
  });

  it("非法输出（非整数/负数/空串）→ PID_PROBE_INVALID 显式抛出，禁止静默解析", async () => {
    const fx = await makeFullFixture(path.join(TEST_ROOT, "pid-bad"));
    for (const bad of ["abc", "-5", "12.5", ""]) {
      try {
        await collectHealth(cfgOf(), { kernelDataDir: fx.kernelDataDir, proc: async () => bad });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(BridgeError);
        expect((e as BridgeError).code).toBe("PID_PROBE_INVALID");
      }
    }
  });

  it("proc 自身拒绝 → PID_PROBE_FAILED 且 cause 保留（不掩盖探测方错误）", async () => {
    const fx = await makeFullFixture(path.join(TEST_ROOT, "pid-fail"));
    const cause = new Error("ps 不可用");
    try {
      await collectHealth(cfgOf(), {
        kernelDataDir: fx.kernelDataDir,
        proc: async () => {
          throw cause;
        },
      });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe("PID_PROBE_FAILED");
      expect((e as { cause?: unknown }).cause).toBe(cause);
    }
  });
});
