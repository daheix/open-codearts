/**
 * T4-05 doctor 环境体检测试（bun:test）。
 *
 * 覆盖：
 * - 纯判定函数（judgeXxx / compareVersions / aggregate / humanBytes）：
 *   观察值 → CheckResult 的全部业务分支（✓/⚠/✗ 与修复指引）；
 * - IO 采集器（collectXxx）：注入 fake exec/fetch 与临时目录 FS，
 *   绝不触碰真实 HOME、绝不真实联网、绝不调用真实 systemctl；
 * - doctorCommand 聚合：人类可读 + 结构化 JSON 双输出、聚合退出码。
 *
 * 隔离纪律（与 service.test.ts 同）：exec/fetch/homeDir/kernelDataDir 全部注入；
 * FS 落点全部在 .tmp/doctor-test/ 临时目录（afterAll 清理）。
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../src/core/config";
import type { BridgeConfig } from "../src/core/config";
import { BridgeError } from "../src/core/errors";
import {
  DOCTOR_CHECK_IDS,
  DOCTOR_DISK_DUMPS_WARN_BYTES,
  DOCTOR_DISK_LOGS_WARN_BYTES,
  DOCTOR_DISK_WAL_WARN_BYTES,
  aggregate,
  collectBun,
  collectCodeartsCli,
  collectCredential,
  collectDaemonHealth,
  collectDisk,
  collectNetwork,
  collectOpencode,
  collectSystemd,
  compareVersions,
  doctorCommand,
  humanBytes,
  judgeBun,
  judgeCodeartsCli,
  judgeCredential,
  judgeDaemonHealth,
  judgeDisk,
  judgeNetwork,
  judgeOpencode,
  judgeSystemd,
  runDoctorChecks,
} from "../src/core/doctor";
import type {
  CodeartsObservation,
  CredentialObservation,
  DaemonHealthObservation,
  DiskObservation,
  DoctorCheck,
  DoctorDeps,
  NetworkObservation,
} from "../src/core/doctor";
import { fakeExec, makeInstallFixture } from "./fixtures/install-fixtures";
import type { Exec } from "../src/core/install";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
const TEST_ROOT = path.join(PLUGIN_ROOT, ".tmp", "doctor-test");

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

/** 捕获 console 输出执行 fn（finally 必然还原，防污染其他用例输出）。 */
async function captureConsole<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const result = await fn();
    return { result, logs, errors };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

/* ───── compareVersions / humanBytes 纯函数 ───── */

describe("compareVersions 语义化版本比较", () => {
  it("逐段数值比较：小于/等于/大于", () => {
    expect(compareVersions("2.0.28", "2.1.0")).toBe(-1);
    expect(compareVersions("2.1.0", "2.1.0")).toBe(0);
    expect(compareVersions("2.2.5", "2.1.0")).toBe(1);
    expect(compareVersions("10.0.0", "9.99.99")).toBe(1); // 数值而非字典序
  });

  it("非法形态显式抛 BridgeError（禁静默钳位）", () => {
    expect(() => compareVersions("dev", "2.1.0")).toThrow(BridgeError);
    expect(() => compareVersions("2.1", "2.1.0")).toThrow(BridgeError);
    expect(() => compareVersions("2.1.0", "")).toThrow(BridgeError);
  });
});

describe("humanBytes 字节人类可读格式", () => {
  it("B/KB/MB/GB 换算", () => {
    expect(humanBytes(0)).toBe("0B");
    expect(humanBytes(512)).toBe("512B");
    expect(humanBytes(1024)).toBe("1.0KB");
    expect(humanBytes(500 * 1024 * 1024)).toBe("500.0MB");
    expect(humanBytes(2 * 1024 * 1024 * 1024)).toBe("2.0GB");
  });
});

/* ───── 判定函数（纯逻辑） ───── */

describe("judgeOpencode ① 插件宿主判定", () => {
  it("未检出 → warn（宿主缺失不阻塞桥接核心，但插件无法加载）", () => {
    const c = judgeOpencode({ present: false });
    expect(c.level).toBe("warn");
    expect(c.remediation).toContain("opencode");
    expect(c.remediation).toContain("2.1");
  });

  it("版本 ≥2.1 → ok", () => {
    const c = judgeOpencode({ present: true, version: "2.2.5" });
    expect(c.level).toBe("ok");
    expect(c.summary).toContain("2.2.5");
  });

  it("版本 <2.1 → warn（V2 插件契约不满足）", () => {
    const c = judgeOpencode({ present: true, version: "2.0.28" });
    expect(c.level).toBe("warn");
    expect(c.summary).toContain("2.0.28");
    expect(c.remediation).toContain("2.1");
  });

  it("版本无法解析 → warn（如实呈现，禁假定满足）", () => {
    const c = judgeOpencode({ present: true, version: undefined });
    expect(c.level).toBe("warn");
  });
});

describe("judgeBun ② 运行时判定", () => {
  it("未检出 → fail（一切子命令依赖 bun）", () => {
    const c = judgeBun({ present: false });
    expect(c.level).toBe("fail");
    expect(c.remediation).toContain("bun.sh/install");
  });

  it("在场含版本 → ok；在场无版本 → ok（版本信息性）", () => {
    expect(judgeBun({ present: true, version: "1.4.2" }).level).toBe("ok");
    expect(judgeBun({ present: true, version: undefined }).level).toBe("ok");
  });
});

describe("judgeCodeartsCli ③ 安装管家判定", () => {
  it("探测异常 → fail（状态损坏需处理，禁当作正常）", () => {
    const c = judgeCodeartsCli({ error: "AUTOUPDATE_INVALID: 解析失败" });
    expect(c.level).toBe("fail");
    expect(c.summary).toContain("AUTOUPDATE_INVALID");
  });

  it("未安装 → warn（structured 传输不可用，指引升级命令安装）", () => {
    const c = judgeCodeartsCli({});
    expect(c.level).toBe("warn");
    expect(c.remediation).toContain("upgrade-cli");
  });

  it("健康安装 → ok", () => {
    const c = judgeCodeartsCli({
      status: {
        path: "/x/bin/codearts",
        present: true,
        version: "26.10.9",
        sha256: "a".repeat(64),
        backupPath: "/x/bin/codearts.bak-26.10.9",
        backupValid: true,
        autoupdateFlag: false,
        pinState: "consistent",
        drift: false,
      },
    });
    expect(c.level).toBe("ok");
    expect(c.summary).toContain("26.10.9");
  });

  it("autoupdate 开启 → warn（指引关停）", () => {
    const c = judgeCodeartsCli({
      status: {
        path: "/x/bin/codearts",
        present: true,
        version: "26.10.9",
        backupPath: "/x/bin/codearts.bak-26.10.9",
        backupValid: true,
        autoupdateFlag: true,
        pinState: "consistent",
        drift: false,
      },
    });
    expect(c.level).toBe("warn");
    expect(c.summary).toContain("autoupdate");
  });

  it("钉版漂移 + 备份失效 → warn 汇总两条问题", () => {
    const c = judgeCodeartsCli({
      status: {
        path: "/x/bin/codearts",
        present: true,
        version: "26.10.9",
        backupPath: "/x/bin/codearts.bak-26.10.9",
        backupValid: false,
        autoupdateFlag: false,
        pinState: "drift",
        drift: true,
      },
    });
    expect(c.level).toBe("warn");
    expect(c.summary).toContain("漂移");
    expect(c.summary).toContain("备份");
  });
});

describe("judgeCredential ④ 凭据判定", () => {
  it("AK/SK 配置 → ok（structured 可用）", () => {
    const c = judgeCredential({ authJsonExists: false, aksk: { AK: "a", SK: "s" } });
    expect(c.level).toBe("ok");
    expect(c.detail?.["mode"]).toBe("aksk");
  });

  it("仅 CLI 登录态 → ok（mode=auth）", () => {
    const c = judgeCredential({ authJsonExists: true });
    expect(c.level).toBe("ok");
    expect(c.detail?.["mode"]).toBe("auth");
  });

  it("两者皆无 → warn（structured 不可用，指引配置）", () => {
    const c = judgeCredential({ authJsonExists: false });
    expect(c.level).toBe("warn");
    expect(c.remediation).toContain("AK");
  });

  it("凭据文件读取异常 → fail（损坏需显式处理）", () => {
    const c = judgeCredential({ authJsonExists: false, error: "格式错误 line=2" });
    expect(c.level).toBe("fail");
  });
});

describe("judgeSystemd ⑤ 单元状态判定", () => {
  const fullUnits = { daemon: true, watchdogService: true, watchdogTimer: true };

  it("systemctl 不可用 → warn（非 systemd 环境）", () => {
    const c = judgeSystemd({ systemctlAvailable: false });
    expect(c.level).toBe("warn");
    expect(c.remediation).toContain("daemon");
  });

  it("单元未安装 → warn（指引 service install）", () => {
    const c = judgeSystemd({
      systemctlAvailable: true,
      units: { daemon: false, watchdogService: false, watchdogTimer: false },
    });
    expect(c.level).toBe("warn");
    expect(c.remediation).toContain("service install");
  });

  it("三单元在场且 active → ok", () => {
    const c = judgeSystemd({
      systemctlAvailable: true,
      units: fullUnits,
      active: { daemon: true, watchdogTimer: true },
    });
    expect(c.level).toBe("ok");
  });

  it("单元在场但守护非 active → warn（含 journal 排查指引）", () => {
    const c = judgeSystemd({
      systemctlAvailable: true,
      units: fullUnits,
      active: { daemon: false, watchdogTimer: true },
    });
    expect(c.level).toBe("warn");
    expect(c.remediation).toContain("journalctl");
  });

  it("watchdog timer 非 active → warn（守护自愈看门缺位）", () => {
    const c = judgeSystemd({
      systemctlAvailable: true,
      units: fullUnits,
      active: { daemon: true, watchdogTimer: false },
    });
    expect(c.level).toBe("warn");
  });

  it("守护单元在场但 watchdog 单元缺失 → warn", () => {
    const c = judgeSystemd({
      systemctlAvailable: true,
      units: { daemon: true, watchdogService: false, watchdogTimer: false },
    });
    expect(c.level).toBe("warn");
  });
});

describe("judgeDaemonHealth ⑥ 守护健康判定", () => {
  it("可达 → ok；不可达 → warn（附启动指引）", () => {
    expect(judgeDaemonHealth({ ok: true }).level).toBe("ok");
    const c = judgeDaemonHealth({ ok: false, reason: "ECONNREFUSED" });
    expect(c.level).toBe("warn");
    expect(c.summary).toContain("ECONNREFUSED");
    expect(c.remediation).toContain("daemon");
  });
});

describe("judgeDisk ⑦ 磁盘占用判定", () => {
  const base: DiskObservation = {
    dbBytes: 10 * 1024 * 1024,
    walBytes: 1024,
    dumps: { files: 0, bytes: 0 },
    logsBytes: 5 * 1024 * 1024,
  };

  it("占用低于阈值 → ok", () => {
    expect(judgeDisk(base).level).toBe("ok");
  });

  it("dump 堆快照超阈值 → warn（建议 hygiene 清理）", () => {
    const c = judgeDisk({ ...base, dumps: { files: 3, bytes: DOCTOR_DISK_DUMPS_WARN_BYTES + 1 } });
    expect(c.level).toBe("warn");
    expect(c.summary).toContain("dump");
    expect(c.remediation).toContain("hygiene");
  });

  it("WAL 超阈值 → warn（建议 checkpoint）", () => {
    const c = judgeDisk({ ...base, walBytes: DOCTOR_DISK_WAL_WARN_BYTES + 1 });
    expect(c.level).toBe("warn");
    expect(c.summary).toContain("WAL");
  });

  it("日志超阈值 → warn", () => {
    const c = judgeDisk({ ...base, logsBytes: DOCTOR_DISK_LOGS_WARN_BYTES + 1 });
    expect(c.level).toBe("warn");
  });

  it("采集异常 → fail", () => {
    expect(judgeDisk({ ...base, error: "FS_STAT_FAILED" }).level).toBe("fail");
  });
});

describe("judgeNetwork ⑧ 网络可达性判定", () => {
  it("可达（任意 HTTP 应答）→ ok", () => {
    expect(judgeNetwork({ reachable: true, status: 200 }).level).toBe("ok");
    expect(judgeNetwork({ reachable: true, status: 403 }).level).toBe("ok");
  });

  it("不可达 → warn（不阻塞：仅升级/安装通道受影响）", () => {
    const c: DoctorCheck = judgeNetwork({ reachable: false, reason: "timeout" });
    expect(c.level).toBe("warn");
    expect(c.summary).toContain("timeout");
  });
});

describe("aggregate 聚合判定", () => {
  it("混合作业：fail>0 → 退出码 1；仅 warn → 退出码 0", () => {
    const mk = (id: string, level: DoctorCheck["level"]): DoctorCheck => ({ id, level, summary: id });
    const onlyWarn = aggregate([mk("a", "ok"), mk("b", "warn")]);
    expect(onlyWarn.exitCode).toBe(0);
    expect(onlyWarn.warn).toBe(1);
    const withFail = aggregate([mk("a", "ok"), mk("b", "warn"), mk("c", "fail")]);
    expect(withFail.exitCode).toBe(1);
    expect(withFail.fail).toBe(1);
  });
});

/* ───── IO 采集器（注入 fake） ───── */

describe("collectOpencode 采集", () => {
  it("正常解析 stdout 版本", async () => {
    const obs = await collectOpencode(fakeExec({ stdout: "2.2.5\n" }, []));
    expect(obs).toEqual({ present: true, version: "2.2.5" });
  });

  it("spawn 失败（ENOENT）→ present=false", async () => {
    const obs = await collectOpencode({ run: async () => Promise.reject(Object.assign(new Error("x"), { code: "ENOENT" })) });
    expect(obs.present).toBe(false);
  });

  it("退出码非 0 → 在场但版本未知（如实呈现）", async () => {
    const obs = await collectOpencode(fakeExec({ code: 1, stderr: "boom" }, []));
    expect(obs.present).toBe(true);
    expect(obs.version).toBeUndefined();
  });
});

describe("collectBun 采集", () => {
  it("PATH 探测成功", async () => {
    const obs = await collectBun(TEST_ROOT, fakeExec({ stdout: "1.4.2\n" }, []));
    expect(obs).toEqual({ present: true, version: "1.4.2" });
  });

  it("PATH 失败 → 回落 ~/.bun/bin/bun 探测", async () => {
    const bunBin = path.join(TEST_ROOT, ".bun", "bin", "bun");
    await mkdir(path.dirname(bunBin), { recursive: true });
    await writeFile(bunBin, "#!/bin/sh\necho 1.4.2\n");
    let calls = 0;
    const exec: Exec = {
      run: async (cmd) => {
        calls++;
        if (cmd[0] === "bun") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        expect(cmd[0]).toBe(bunBin);
        return { code: 0, stdout: "1.4.2\n", stderr: "" };
      },
    };
    const obs = await collectBun(TEST_ROOT, exec);
    expect(obs).toEqual({ present: true, version: "1.4.2" });
    expect(calls).toBe(2);
  });

  it("两路皆失败 → present=false", async () => {
    const obs = await collectBun(TEST_ROOT, {
      run: async () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    });
    expect(obs).toEqual({ present: false });
  });
});

describe("collectCodeartsCli 采集", () => {
  it("健康 fixture → status 在场", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "ca-healthy"), "healthy");
    const cfg = loadConfig({ installDir: fx.installDir, stateDir: fx.stateDir }, {});
    const obs: CodeartsObservation = await collectCodeartsCli(cfg, fx.exec);
    expect(obs.status?.present).toBe(true);
    expect(obs.status?.version).toBe("26.10.9");
    expect(obs.error).toBeUndefined();
  });

  it("损坏配置（autoupdate 非布尔）→ error 观察", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "ca-bad"), "healthy");
    await writeFile(fx.cliPath, JSON.stringify({ autoupdate: "yes" }), "utf8");
    const cfg = loadConfig({ installDir: fx.installDir, stateDir: fx.stateDir }, {});
    const obs = await collectCodeartsCli(cfg, fx.exec);
    expect(obs.status).toBeUndefined();
    expect(obs.error).toContain("AUTOUPDATE_INVALID");
  });
});

describe("collectCredential 采集", () => {
  it("auth.json 在场 → authJsonExists=true", async () => {
    const kd = path.join(TEST_ROOT, "cli-data");
    await mkdir(kd, { recursive: true });
    await writeFile(path.join(kd, "auth.json"), "{}", "utf8");
    const cfg = loadConfig({ stateDir: path.join(TEST_ROOT, "state") }, {});
    const obs: CredentialObservation = await collectCredential(cfg, { kernelDataDir: kd });
    expect(obs.authJsonExists).toBe(true);
    expect(obs.aksk).toBeUndefined();
  });

  it("AK/SK 文件在场 → 解析成功（值不进观察结果，防泄漏）", async () => {
    const stateDir = path.join(TEST_ROOT, "state-aksk");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "config.env"), "AK=abc\nSK=xyz\n", "utf8");
    const cfg = loadConfig({ stateDir }, {});
    const obs = await collectCredential(cfg, { kernelDataDir: path.join(TEST_ROOT, "no-kd") });
    expect(obs.aksk).toEqual({ AK: "abc", SK: "xyz" });
  });

  it("AK/SK 文件损坏 → error（含行号，不含值）", async () => {
    const stateDir = path.join(TEST_ROOT, "state-bad");
    await mkdir(stateDir, { recursive: true });
    await writeFile(path.join(stateDir, "config.env"), "BROKEN LINE\n", "utf8");
    const cfg = loadConfig({ stateDir }, {});
    const obs = await collectCredential(cfg, { kernelDataDir: path.join(TEST_ROOT, "no-kd") });
    expect(obs.error).toContain("line=1");
    expect(obs.error).not.toContain("BROKEN LINE"); // 值/行内容绝不回显
  });
});

describe("collectSystemd 采集", () => {
  const UNIT_NAMES = ["codearts-bridge.service", "codearts-bridge-watchdog.service", "codearts-bridge-watchdog.timer"];

  it("单元缺失 → units 全 false 且零 systemctl 调用（沙箱安全）", async () => {
    const unitDir = path.join(TEST_ROOT, "units-empty");
    const calls: string[][] = [];
    const obs = await collectSystemd(unitDir, fakeExec({}, calls));
    expect(obs.units).toEqual({ daemon: false, watchdogService: false, watchdogTimer: false });
    expect(calls).toEqual([]);
  });

  it("单元在场 + is-active 0/0 → active 双真", async () => {
    const unitDir = path.join(TEST_ROOT, "units-full");
    await mkdir(unitDir, { recursive: true });
    for (const n of UNIT_NAMES) await writeFile(path.join(unitDir, n), "[Unit]\n", "utf8");
    const calls: string[][] = [];
    const exec: Exec = {
      run: async (cmd) => {
        calls.push(cmd);
        return { code: 0, stdout: "active\n", stderr: "" };
      },
    };
    const obs = await collectSystemd(unitDir, exec);
    expect(obs.units?.daemon).toBe(true);
    expect(obs.active).toEqual({ daemon: true, watchdogTimer: true });
    expect(calls.length).toBe(2); // 守护 + timer 两次 is-active
    for (const c of calls) expect(c.slice(0, 3)).toEqual(["systemctl", "--user", "is-active"]);
  });

  it("systemctl spawn 失败 → systemctlAvailable=false（单元在场信息保留）", async () => {
    const unitDir = path.join(TEST_ROOT, "units-nosystemd");
    await mkdir(unitDir, { recursive: true });
    await writeFile(path.join(unitDir, UNIT_NAMES[0]!), "[Unit]\n", "utf8");
    const obs = await collectSystemd(unitDir, {
      run: async () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    });
    expect(obs.systemctlAvailable).toBe(false);
    expect(obs.units?.daemon).toBe(true);
  });
});

describe("collectDaemonHealth / collectNetwork 采集", () => {
  it("守护 /health ok:true → ok 观察", async () => {
    const fetchImpl = async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 });
    const obs: DaemonHealthObservation = await collectDaemonHealth(
      "http://127.0.0.1:4577",
      fetchImpl,
    );
    expect(obs.ok).toBe(true);
  });

  it("守护非 200 / 非 JSON / fetch 抛错 → ok=false + reason", async () => {
    const obs1 = await collectDaemonHealth("http://x", async () => new Response("no", { status: 500 }));
    expect(obs1.ok).toBe(false);
    const obs2 = await collectDaemonHealth("http://x", async () => new Response("not-json", { status: 200 }));
    expect(obs2.ok).toBe(false);
    const obs3 = await collectDaemonHealth("http://x", async () => {
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    });
    expect(obs3.ok).toBe(false);
    expect(obs3.reason).toContain("ECONNREFUSED");
  });

  it("网络 HEAD 任意应答 → reachable；抛错 → reason", async () => {
    const ok: NetworkObservation = await collectNetwork(async () => new Response(null, { status: 200 }));
    expect(ok).toEqual({ reachable: true, status: 200 });
    const bad = await collectNetwork(async () => {
      const e = new Error("boom");
      e.name = "TimeoutError";
      throw e;
    });
    expect(bad.reachable).toBe(false);
    expect(bad.reason).toContain("TimeoutError");
  });
});

describe("collectDisk 采集", () => {
  it("空数据目录 → 全零观察（不抛错）", async () => {
    const cfg = loadConfig({ stateDir: path.join(TEST_ROOT, "state-disk") }, {});
    const obs = await collectDisk(cfg, path.join(TEST_ROOT, "kd-empty"));
    expect(obs.dbBytes).toBe(0);
    expect(obs.walBytes).toBe(0);
    expect(obs.dumps).toEqual({ files: 0, bytes: 0 });
    expect(obs.logsBytes).toBe(0);
  });
});

/* ───── 聚合命令 ───── */

describe("runDoctorChecks 全量八项", () => {
  it("按固定顺序产出八项检查（id 顺序稳定）", async () => {
    const homeDir = path.join(TEST_ROOT, "home-run");
    await mkdir(homeDir, { recursive: true });
    const cfg = loadConfig(
      { installDir: path.join(TEST_ROOT, "ca-run"), stateDir: path.join(TEST_ROOT, "state-run") },
      {},
    );
    const deps: DoctorDeps = {
      exec: fakeExec({ stdout: "1.4.2\n" }, []), // bun --version ok；opencode 同 fake（版本低→warn 即可）
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      homeDir,
      kernelDataDir: path.join(TEST_ROOT, "kd-run"),
    };
    const checks = await runDoctorChecks(cfg, deps);
    expect(checks.map((c) => c.id)).toEqual([...DOCTOR_CHECK_IDS]);
    expect(checks.length).toBe(8);
    for (const c of checks) expect(["ok", "warn", "fail"]).toContain(c.level);
  });
});

describe("doctorCommand 输出与退出码", () => {
  /** 全部 FS 落点锁进临时目录（installDir/stateDir/homeDir/kernelDataDir 注入，绝不触碰真实 HOME）。 */
  function tmpCfg(name: string): BridgeConfig {
    return loadConfig(
      { installDir: path.join(TEST_ROOT, `ca-${name}`), stateDir: path.join(TEST_ROOT, `st-${name}`) },
      {},
    );
  }

  function baseDeps(homeDir: string, overrides: Partial<DoctorDeps> = {}): DoctorDeps {
    return {
      exec: fakeExec({ stdout: "1.4.2\n" }, []),
      fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      homeDir,
      kernelDataDir: path.join(homeDir, "kd"),
      ...overrides,
    };
  }

  it("典型注入（6 ok / 2 warn）→ 退出码 0；人类可读行含 ✓；尾部 JSON 可解析且含 checks", async () => {
    const homeDir = path.join(TEST_ROOT, "home-ok");
    const kd = path.join(homeDir, "kd");
    await mkdir(kd, { recursive: true });
    await writeFile(path.join(kd, "auth.json"), "{}", "utf8"); // baseDeps 的 kernelDataDir=homeDir/kd
    // bun/opencode 版本探测按 cmd[0] 分流：bun→1.4.2；opencode→2.2.5
    const exec: Exec = {
      run: async (cmd) =>
        cmd[0] === "opencode"
          ? { code: 0, stdout: "2.2.5\n", stderr: "" }
          : { code: 0, stdout: "1.4.2\n", stderr: "" },
    };
    const { result, logs } = await captureConsole(() =>
      doctorCommand(tmpCfg("ok"), baseDeps(homeDir, { exec }), {}),
    );
    expect(result).toBe(0);
    const text = logs.join("\n");
    expect(text).toContain("✓");
    expect(text).toContain("⚠"); // codearts CLI 未安装 + systemd 单元未安装
    const jsonLine = logs.find((l) => l.startsWith("{\"checks\""));
    expect(jsonLine).toBeDefined();
    const parsed = JSON.parse(jsonLine!) as {
      checks: DoctorCheck[];
      summary: { ok: number; warn: number; fail: number; exitCode: number };
    };
    expect(parsed.checks.length).toBe(8);
    expect(parsed.summary).toEqual({ ok: 6, warn: 2, fail: 0, exitCode: 0 });
  });

  it("bun 两路皆缺（exec 全抛 + canonical 缺失）→ 退出码 1；✗ 行可见", async () => {
    const homeDir = path.join(TEST_ROOT, "home-fail");
    await mkdir(homeDir, { recursive: true });
    const exec: Exec = {
      run: async () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
    };
    const { result, logs } = await captureConsole(() =>
      doctorCommand(tmpCfg("fail"), baseDeps(homeDir, { exec }), {}),
    );
    expect(result).toBe(1);
    expect(logs.join("\n")).toContain("✗");
  });

  it("--json 仅输出结构化 JSON（单行可解析，无人类可读行）", async () => {
    const homeDir = path.join(TEST_ROOT, "home-json");
    await mkdir(homeDir, { recursive: true });
    const { logs } = await captureConsole(() =>
      doctorCommand(tmpCfg("json"), baseDeps(homeDir), { json: true }),
    );
    expect(logs.length).toBe(1);
    const parsed = JSON.parse(logs[0]!) as { checks: unknown };
    expect(Array.isArray(parsed.checks)).toBe(true);
  });
});
