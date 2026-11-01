/**
 * T3-07 systemd 服务与 watchdog 测试（bun:test）。
 *
 * 覆盖（主控裁定 R-sv1~R-sv4，progress.md Task 20）：
 * - R-sv1 watchdog 内置化：evaluateProbe 纯评估函数 + watchdogProbeCommand
 *   （fetch /health 15s 超时、计数文件、连续 ≥2 → systemctl --user restart）；
 * - R-sv2 单元生成器纯函数：renderServiceUnit / renderWatchdogUnits 内容断言
 *   （Restart=always、ExecStart 绝对路径、环境变量、日志到 journal）；
 * - R-sv3 安装幂等：重复 install 同内容不重写、uninstall 只删自家单元、
 *   systemctl 动作经注入 exec（测试绝不真装）；
 * - R-sv4 探针诊断：失败原因分类（超时/连接拒绝/非 JSON/ok≠true）入 stderr/journal。
 * - T3-05/T3-06 登记项①：daemonCommand 生产装配挂载 GoalHost（POST /goals 不再 501）。
 *
 * 隔离纪律（与 install.test.ts 同）：exec/fetch/时钟全部注入；FS 落点全部在
 * .tmp/service-test/ 临时目录；绝不触碰真实 HOME 与真实 systemd。
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import * as http from "node:http";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../src/core/config";
import type { BridgeConfig } from "../src/core/config";
import { BridgeError } from "../src/core/errors";
import {
  SERVICE_UNIT_NAMES,
  WATCHDOG_FAIL_THRESHOLD,
  WATCHDOG_GRACE_SECONDS,
  evaluateProbe,
  renderServiceUnit,
  renderWatchdogUnits,
} from "../src/core/service";
import type { Exec } from "../src/core/install";
import {
  daemonCommand,
  main,
  serviceInstallCommand,
  serviceStatusCommand,
  serviceUninstallCommand,
  watchdogProbeCommand,
} from "../src/cli";
import type { FetchLike, ServiceDeps } from "../src/cli";
import type { RunClock } from "../src/core/run";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
const TEST_ROOT = path.join(PLUGIN_ROOT, ".tmp", "service-test");

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

/* ───── fixture：生成器输入与 systemd exec fake ───── */

const BUN = "/opt/bun/bin/bun";
const CLI = "/opt/app/src/cli.ts";
const STATE = "/home/u/.codearts-bridge";

/** 可编程 systemctl fake：按 argv 前缀匹配返回退出码，并留痕全部调用。 */
function makeSystemctlFake(script: Array<{ match: string[]; code: number; stdout?: string }> = []) {
  const calls: string[][] = [];
  const exec: Exec = {
    async run(cmd) {
      calls.push([...cmd]);
      const hit = script.find((s) => s.match.every((m, i) => cmd[i] === m));
      if (hit !== undefined) {
        return { code: hit.code, stdout: hit.stdout ?? "", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    },
  };
  return { exec, calls };
}

/** 隔离配置：stateDir 落临时目录；daemonUrl 指向不存在的端口（fetch 已注入，不会真连）。 */
function cfgFor(name: string): BridgeConfig {
  return loadConfig({ stateDir: path.join(TEST_ROOT, name), daemonUrl: "http://127.0.0.1:1" }, {});
}

/** 单元目录与三个单元文件路径。 */
function unitPaths(unitDir: string) {
  return {
    daemon: path.join(unitDir, SERVICE_UNIT_NAMES.daemon),
    watchdogService: path.join(unitDir, SERVICE_UNIT_NAMES.watchdogService),
    watchdogTimer: path.join(unitDir, SERVICE_UNIT_NAMES.watchdogTimer),
  };
}

/** 探测一个空闲 TCP 端口（监听 :0 → 取端口 → 立即关闭；仅测试定位用）。 */
async function freeTcpPort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  if (addr === null || typeof addr === "string") throw new Error(`非预期地址形态：${String(addr)}`);
  const port = addr.port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/* ───── R-sv2：单元生成器 ───── */

describe("renderServiceUnit（R-sv2 内容断言）", () => {
  it("Restart=always + RestartSec 在场（崩溃自愈语义钉死）", () => {
    const unit = renderServiceUnit({ bunPath: BUN, cliPath: CLI, stateDir: STATE });
    expect(unit).toContain("[Service]");
    expect(unit).toMatch(/^Restart=always$/m);
    expect(unit).toMatch(/^RestartSec=\d+$/m);
  });

  it("ExecStart=引号包裹的绝对 bun 路径 + 绝对 cli.ts 路径 + daemon 子命令", () => {
    const unit = renderServiceUnit({ bunPath: BUN, cliPath: CLI, stateDir: STATE });
    const m = /^ExecStart=(.+)$/m.exec(unit);
    expect(m).not.toBeNull();
    expect(m?.[1]).toContain(`"${BUN}"`);
    expect(m?.[1]).toContain(`"${CLI}"`);
    expect(m?.[1]?.trim().endsWith("daemon")).toBe(true);
  });

  it("Environment 钉 CODEARTS_BRIDGE_STATE_DIR（守护与 watchdog 同一状态根）", () => {
    const unit = renderServiceUnit({ bunPath: BUN, cliPath: CLI, stateDir: STATE });
    expect(unit).toContain(`Environment="CODEARTS_BRIDGE_STATE_DIR=${STATE}"`);
  });

  it("日志到 journal：StandardOutput/StandardError=journal + SyslogIdentifier", () => {
    const unit = renderServiceUnit({ bunPath: BUN, cliPath: CLI, stateDir: STATE });
    expect(unit).toMatch(/^StandardOutput=journal$/m);
    expect(unit).toMatch(/^StandardError=journal$/m);
    expect(unit).toMatch(/^SyslogIdentifier=codearts-bridge$/m);
  });

  it("[Install] WantedBy=default.target（user 服务惯例）", () => {
    const unit = renderServiceUnit({ bunPath: BUN, cliPath: CLI, stateDir: STATE });
    expect(unit).toMatch(/^WantedBy=default\.target$/m);
  });

  it("user 可选：传入出 User= 行，缺省不出", () => {
    const withUser = renderServiceUnit({ bunPath: BUN, cliPath: CLI, stateDir: STATE, user: "u" });
    expect(withUser).toMatch(/^User=u$/m);
    const withoutUser = renderServiceUnit({ bunPath: BUN, cliPath: CLI, stateDir: STATE });
    expect(withoutUser).not.toMatch(/^User=/m);
  });

  it("相对路径显式抛 BridgeError（bun/cli/stateDir 三字段各自校验，禁静默）", () => {
    expect(() => renderServiceUnit({ bunPath: "bun", cliPath: CLI, stateDir: STATE })).toThrow(BridgeError);
    expect(() => renderServiceUnit({ bunPath: BUN, cliPath: "cli.ts", stateDir: STATE })).toThrow(BridgeError);
    expect(() => renderServiceUnit({ bunPath: BUN, cliPath: CLI, stateDir: ".codearts-bridge" })).toThrow(BridgeError);
  });
});

describe("renderWatchdogUnits（R-sv2）", () => {
  it("watchdog.service：Type=oneshot + ExecStart=watchdog-probe + journal 日志", () => {
    const { service } = renderWatchdogUnits({ bunPath: BUN, cliPath: CLI, stateDir: STATE });
    expect(service).toMatch(/^Type=oneshot$/m);
    const m = /^ExecStart=(.+)$/m.exec(service);
    expect(m?.[1]).toContain(`"${BUN}"`);
    expect(m?.[1]).toContain(`"${CLI}"`);
    expect(m?.[1]?.trim().endsWith("watchdog-probe")).toBe(true);
    expect(service).toMatch(/^StandardOutput=journal$/m);
    expect(service).toMatch(/^StandardError=journal$/m);
  });

  it("watchdog.timer：OnCalendar=minutely + Unit 指向 watchdog.service + WantedBy=timers.target", () => {
    const { timer } = renderWatchdogUnits({ bunPath: BUN, cliPath: CLI, stateDir: STATE });
    expect(timer).toMatch(/^OnCalendar=minutely$/m);
    expect(timer).toContain(`Unit=${SERVICE_UNIT_NAMES.watchdogService}`);
    expect(timer).toMatch(/^WantedBy=timers\.target$/m);
  });

  it("相对路径显式抛 BridgeError", () => {
    expect(() => renderWatchdogUnits({ bunPath: "bun", cliPath: CLI, stateDir: STATE })).toThrow(BridgeError);
  });
});

/* ───── R-sv1：探测评估纯函数 ───── */

describe("evaluateProbe（R-sv1 纯评估）", () => {
  it("宽限期内：ok 且计数原样保留（不探测不计数不清零，对齐 dsh 原型）", () => {
    const v = evaluateProbe({ httpCode: 0, prevFails: 1, graceActive: true }, 1_000);
    expect(v.action).toBe("ok");
    expect(v.fails).toBe(1);
  });

  it("HTTP 200：ok 且计数清零", () => {
    const v = evaluateProbe({ httpCode: 200, prevFails: 1, graceActive: false }, 1_000);
    expect(v.action).toBe("ok");
    expect(v.fails).toBe(0);
  });

  it("任意非 0 状态码（401/500）都证明事件循环存活 → ok 清零（dsh 模式）", () => {
    expect(evaluateProbe({ httpCode: 401, prevFails: 1, graceActive: false }, 1_000).action).toBe("ok");
    expect(evaluateProbe({ httpCode: 500, prevFails: 1, graceActive: false }, 1_000).fails).toBe(0);
  });

  it("无响应首败：increment 且 fails=prevFails+1（未达阈值不重启）", () => {
    const v = evaluateProbe({ httpCode: 0, prevFails: 0, graceActive: false }, 1_000);
    expect(v.action).toBe("increment");
    expect(v.fails).toBe(1);
  });

  it(`连续第 ${WATCHDOG_FAIL_THRESHOLD} 次无响应：restart 且计数清零（重启后重新计数）`, () => {
    const v = evaluateProbe({ httpCode: 0, prevFails: WATCHDOG_FAIL_THRESHOLD - 1, graceActive: false }, 1_000);
    expect(v.action).toBe("restart");
    expect(v.fails).toBe(0);
  });

  it("now 透传到 atMs（结构化日志取时）", () => {
    expect(evaluateProbe({ httpCode: 200, prevFails: 0, graceActive: false }, 1_700_000_000_000).atMs).toBe(
      1_700_000_000_000,
    );
  });

  it("非法输入显式抛（负/非整数 httpCode、负 prevFails、非有限 now）", () => {
    expect(() => evaluateProbe({ httpCode: -1, prevFails: 0, graceActive: false }, 1_000)).toThrow(BridgeError);
    expect(() => evaluateProbe({ httpCode: 1.5, prevFails: 0, graceActive: false }, 1_000)).toThrow(BridgeError);
    expect(() => evaluateProbe({ httpCode: 200, prevFails: -1, graceActive: false }, 1_000)).toThrow(BridgeError);
    expect(() => evaluateProbe({ httpCode: 200, prevFails: 0, graceActive: false }, Number.NaN)).toThrow(BridgeError);
  });
});

/* ───── R-sv3：install / uninstall / status ───── */

describe("serviceInstallCommand（R-sv3 幂等安装）", () => {
  it("首次安装：三个单元文件内容正确 + exec 序列 daemon-reload → enable --now（守护+timer，不含 watchdog.service）", async () => {
    const cfg = cfgFor("install-first");
    const unitDir = path.join(TEST_ROOT, "install-first", "units");
    const { exec, calls } = makeSystemctlFake();
    const deps: ServiceDeps = { exec, unitDir, bunPath: BUN, cliPath: CLI };
    const rc = await serviceInstallCommand(cfg, deps);
    expect(rc).toBe(0);

    const p = unitPaths(unitDir);
    const daemonUnit = await readFile(p.daemon, "utf8");
    expect(daemonUnit).toContain(`Environment="CODEARTS_BRIDGE_STATE_DIR=${cfg.stateDir}"`);
    expect(daemonUnit).toMatch(/^Restart=always$/m);
    expect((await readFile(p.watchdogService, "utf8"))).toMatch(/^Type=oneshot$/m);
    expect((await readFile(p.watchdogTimer, "utf8"))).toMatch(/^OnCalendar=minutely$/m);

    expect(calls.length).toBe(2);
    expect(calls[0]).toEqual(["systemctl", "--user", "daemon-reload"]);
    expect(calls[1]).toEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      SERVICE_UNIT_NAMES.daemon,
      SERVICE_UNIT_NAMES.watchdogTimer,
    ]);
  });

  it("重复安装幂等：内容一致不重写（written 空 + mtime 不变），exec 仍执行 reload/enable", async () => {
    const cfg = cfgFor("install-twice");
    const unitDir = path.join(TEST_ROOT, "install-twice", "units");
    const { exec, calls } = makeSystemctlFake();
    const deps: ServiceDeps = { exec, unitDir, bunPath: BUN, cliPath: CLI };
    await serviceInstallCommand(cfg, deps);
    const p = unitPaths(unitDir);
    const mtimeBefore = (await stat(p.daemon)).mtimeMs;

    const cap = await captureConsole(() => serviceInstallCommand(cfg, deps));
    expect(cap.result).toBe(0);
    expect(cap.logs.join("\n")).toContain('"written":[]');
    expect((await stat(p.daemon)).mtimeMs).toBe(mtimeBefore); // 未重写
    expect(calls.length).toBe(4); // 每次 install 各 reload+enable
  });

  it("exec 失败 → rc 1 + stderr 结构化错误码（禁静默）", async () => {
    const cfg = cfgFor("install-exec-fail");
    const unitDir = path.join(TEST_ROOT, "install-exec-fail", "units");
    const failing: Exec = {
      async run(cmd) {
        if (cmd.includes("daemon-reload")) {
          return { code: 1, stdout: "", stderr: "reload failed" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
    };
    const cap = await captureConsole(() =>
      serviceInstallCommand(cfg, { exec: failing, unitDir, bunPath: BUN, cliPath: CLI }),
    );
    expect(cap.result).toBe(1);
    expect(cap.errors.join("\n")).toContain("SERVICE_EXEC_FAILED");
  });
});

describe("serviceUninstallCommand（R-sv3 只删自家单元）", () => {
  it("卸载：删三个单元文件、保留他单元、exec 执行 disable --now 与 daemon-reload", async () => {
    const cfg = cfgFor("uninstall");
    const unitDir = path.join(TEST_ROOT, "uninstall", "units");
    const { exec, calls } = makeSystemctlFake();
    await serviceInstallCommand(cfg, { exec, unitDir, bunPath: BUN, cliPath: CLI });
    const foreign = path.join(unitDir, "other.service");
    await writeFile(foreign, "[Unit]\nDescription=别人的单元\n", "utf8");

    const cap = await captureConsole(() =>
      serviceUninstallCommand(cfg, { exec, unitDir, bunPath: BUN, cliPath: CLI }),
    );
    expect(cap.result).toBe(0);
    const p = unitPaths(unitDir);
    for (const f of [p.daemon, p.watchdogService, p.watchdogTimer]) {
      await expect(readFile(f, "utf8")).rejects.toThrow();
    }
    expect(await readFile(foreign, "utf8")).toContain("别人的单元");
    const kinds = calls.map((c) => c.slice(0, 4).join(" "));
    expect(kinds.some((k) => k.startsWith("systemctl --user disable"))).toBe(true);
    expect(kinds.some((k) => k === "systemctl --user daemon-reload" || k.startsWith("systemctl --user daemon"))).toBe(
      true,
    );
  });

  it("未安装时幂等 rc 0 且零 systemctl 调用", async () => {
    const cfg = cfgFor("uninstall-missing");
    const unitDir = path.join(TEST_ROOT, "uninstall-missing", "units");
    const { exec, calls } = makeSystemctlFake();
    const cap = await captureConsole(() =>
      serviceUninstallCommand(cfg, { exec, unitDir, bunPath: BUN, cliPath: CLI }),
    );
    expect(cap.result).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("serviceStatusCommand", () => {
  it("已安装：输出单元在场性与 is-active 状态 JSON，rc 0", async () => {
    const cfg = cfgFor("status-ok");
    const unitDir = path.join(TEST_ROOT, "status-ok", "units");
    const { exec } = makeSystemctlFake([
      { match: ["systemctl", "--user", "is-active", SERVICE_UNIT_NAMES.daemon], code: 0, stdout: "active\n" },
      { match: ["systemctl", "--user", "is-active", SERVICE_UNIT_NAMES.watchdogTimer], code: 3, stdout: "inactive\n" },
    ]);
    await serviceInstallCommand(cfg, { exec, unitDir, bunPath: BUN, cliPath: CLI });
    const cap = await captureConsole(() =>
      serviceStatusCommand(cfg, { exec, unitDir, bunPath: BUN, cliPath: CLI }),
    );
    expect(cap.result).toBe(0);
    const payload = JSON.parse(cap.logs.join("\n")) as {
      units: { daemon: boolean; watchdogService: boolean; watchdogTimer: boolean };
      active: { daemon: boolean; watchdogTimer: boolean };
    };
    expect(payload.units.daemon).toBe(true);
    expect(payload.units.watchdogTimer).toBe(true);
    expect(payload.active.daemon).toBe(true);
    expect(payload.active.watchdogTimer).toBe(false);
  });

  it("未安装：rc 1 + SERVICE_NOT_INSTALLED 结构化 stderr", async () => {
    const cfg = cfgFor("status-missing");
    const { exec } = makeSystemctlFake();
    const cap = await captureConsole(() =>
      serviceStatusCommand(cfg, { exec, unitDir: path.join(TEST_ROOT, "status-missing", "units"), bunPath: BUN, cliPath: CLI }),
    );
    expect(cap.result).toBe(1);
    expect(cap.errors.join("\n")).toContain("SERVICE_NOT_INSTALLED");
  });
});

/* ───── R-sv1/R-sv4：watchdog-probe 命令 ───── */

/** 构造注入型 watchdog deps：fetch/时钟/单元目录全隔离。 */
function probeDeps(opts: {
  stateDir: string;
  unitDir: string;
  exec: Exec;
  fetchImpl: FetchLike;
  nowMs?: number;
}): ServiceDeps {
  return {
    exec: opts.exec,
    unitDir: opts.unitDir,
    fetchImpl: opts.fetchImpl,
    nowMs: () => opts.nowMs ?? 1_000_000_000_000,
    bunPath: BUN,
    cliPath: CLI,
  };
}

/** 落一个 daemon.pid（watchdog 以其 mtime 作启动戳）。 */
async function writePid(stateDir: string, ageMs: number): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  const p = path.join(stateDir, "daemon.pid");
  await writeFile(p, "12345\n", "utf8");
  const t = new Date(1_000_000_000_000 - ageMs);
  await utimes(p, t, t);
}

describe("watchdogProbeCommand（R-sv1/R-sv4）", () => {
  it("服务非 active：清计数、零 fetch、rc 0（崩溃自愈归 systemd，探针不管）", async () => {
    const cfg = cfgFor("probe-inactive");
    const { exec, calls } = makeSystemctlFake([
      { match: ["systemctl", "--user", "is-active", "--quiet", SERVICE_UNIT_NAMES.daemon], code: 3 },
    ]);
    const failsFile = path.join(cfg.stateDir, "watchdog-fails");
    await mkdir(cfg.stateDir, { recursive: true });
    await writeFile(failsFile, "1", "utf8");
    let fetched = 0;
    const cap = await captureConsole(() =>
      watchdogProbeCommand(
        cfg,
        probeDeps({
          stateDir: cfg.stateDir,
          unitDir: path.join(TEST_ROOT, "probe-inactive", "units"),
          exec,
          fetchImpl: async () => {
            fetched += 1;
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          },
        }),
      ),
    );
    expect(cap.result).toBe(0);
    expect(fetched).toBe(0);
    await expect(readFile(failsFile, "utf8")).rejects.toThrow(); // 计数已清
    expect(calls.length).toBe(1); // 只发了 is-active，无 restart
  });

  it("宽限期（daemon.pid mtime 距今 <120s）：跳过探测零 fetch，计数不动", async () => {
    const cfg = cfgFor("probe-grace");
    const { exec } = makeSystemctlFake([
      { match: ["systemctl", "--user", "is-active", "--quiet", SERVICE_UNIT_NAMES.daemon], code: 0 },
    ]);
    await writePid(cfg.stateDir, 1000); // 1s 前启动 → 宽限内
    let fetched = 0;
    const cap = await captureConsole(() =>
      watchdogProbeCommand(
        cfg,
        probeDeps({
          stateDir: cfg.stateDir,
          unitDir: path.join(TEST_ROOT, "probe-grace", "units"),
          exec,
          fetchImpl: async () => {
            fetched += 1;
            throw new Error("宽限期内不得 fetch");
          },
        }),
      ),
    );
    expect(cap.result).toBe(0);
    expect(fetched).toBe(0);
    expect(cap.errors.join("\n")).toContain(String(WATCHDOG_GRACE_SECONDS));
  });

  it("健康（200+ok:true）：计数清除 rc 0，stderr 留健康痕", async () => {
    const cfg = cfgFor("probe-healthy");
    const { exec, calls } = makeSystemctlFake([
      { match: ["systemctl", "--user", "is-active", "--quiet", SERVICE_UNIT_NAMES.daemon], code: 0 },
    ]);
    await writePid(cfg.stateDir, WATCHDOG_GRACE_SECONDS * 1000 + 60_000); // 宽限外
    const cap = await captureConsole(() =>
      watchdogProbeCommand(
        cfg,
        probeDeps({
          stateDir: cfg.stateDir,
          unitDir: path.join(TEST_ROOT, "probe-healthy", "units"),
          exec,
          fetchImpl: async () => new Response(JSON.stringify({ ok: true, version: "dev", uptime: 1 }), { status: 200 }),
        }),
      ),
    );
    expect(cap.result).toBe(0);
    expect(calls.length).toBe(1);
    expect(cap.errors.join("\n")).toContain("healthy");
  });

  it("首次无响应（超时）：计数文件=1，不重启", async () => {
    const cfg = cfgFor("probe-first-fail");
    const { exec, calls } = makeSystemctlFake([
      { match: ["systemctl", "--user", "is-active", "--quiet", SERVICE_UNIT_NAMES.daemon], code: 0 },
    ]);
    await writePid(cfg.stateDir, WATCHDOG_GRACE_SECONDS * 1000 + 60_000);
    const cap = await captureConsole(() =>
      watchdogProbeCommand(
        cfg,
        probeDeps({
          stateDir: cfg.stateDir,
          unitDir: path.join(TEST_ROOT, "probe-first-fail", "units"),
          exec,
          fetchImpl: async () => {
            const e = new Error("The operation was aborted due to timeout");
            (e as { name: string }).name = "TimeoutError";
            throw e;
          },
        }),
      ),
    );
    expect(cap.result).toBe(0);
    expect(await readFile(path.join(cfg.stateDir, "watchdog-fails"), "utf8")).toBe("1");
    expect(calls.length).toBe(1); // 无 restart
    expect(cap.errors.join("\n")).toContain("timeout"); // R-sv4 分类留痕
  });

  it(`连续第 ${WATCHDOG_FAIL_THRESHOLD} 次无响应：exec 执行 systemctl --user restart + 计数清除`, async () => {
    const cfg = cfgFor("probe-restart");
    const { exec, calls } = makeSystemctlFake([
      { match: ["systemctl", "--user", "is-active", "--quiet", SERVICE_UNIT_NAMES.daemon], code: 0 },
    ]);
    await writePid(cfg.stateDir, WATCHDOG_GRACE_SECONDS * 1000 + 60_000);
    await mkdir(cfg.stateDir, { recursive: true });
    await writeFile(path.join(cfg.stateDir, "watchdog-fails"), "1", "utf8"); // 上轮已败 1 次
    const cap = await captureConsole(() =>
      watchdogProbeCommand(
        cfg,
        probeDeps({
          stateDir: cfg.stateDir,
          unitDir: path.join(TEST_ROOT, "probe-restart", "units"),
          exec,
          fetchImpl: async () => {
            throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
          },
        }),
      ),
    );
    expect(cap.result).toBe(0);
    expect(calls[1]).toEqual(["systemctl", "--user", "restart", SERVICE_UNIT_NAMES.daemon]);
    await expect(readFile(path.join(cfg.stateDir, "watchdog-fails"), "utf8")).rejects.toThrow();
    expect(cap.errors.join("\n")).toContain("restart");
  });

  it("响应但体异常（非 JSON / ok≠true）：事件循环存活判 ok 清零 + stderr 分类留痕（R-sv4）", async () => {
    for (const [name, responder] of [
      ["non-json", async () => new Response("not-json", { status: 200 })],
      ["ok-mismatch", async () => new Response(JSON.stringify({ ok: false }), { status: 200 })],
      ["http-500", async () => new Response(JSON.stringify({ error: { code: "INTERNAL" } }), { status: 500 })],
    ] as const) {
      const cfg = cfgFor(`probe-anomaly-${name}`);
      const { exec } = makeSystemctlFake([
        { match: ["systemctl", "--user", "is-active", "--quiet", SERVICE_UNIT_NAMES.daemon], code: 0 },
      ]);
      await writePid(cfg.stateDir, WATCHDOG_GRACE_SECONDS * 1000 + 60_000);
      const failsFile = path.join(cfg.stateDir, "watchdog-fails");
      await mkdir(cfg.stateDir, { recursive: true });
      await writeFile(failsFile, "1", "utf8"); // 既有计数应被清零
      const cap = await captureConsole(() =>
        watchdogProbeCommand(
          cfg,
          probeDeps({
            stateDir: cfg.stateDir,
            unitDir: path.join(TEST_ROOT, `probe-anomaly-${name}`, "units"),
            exec,
            fetchImpl: responder,
          }),
        ),
      );
      expect(cap.result).toBe(0);
      await expect(readFile(failsFile, "utf8")).rejects.toThrow(); // 有应答=存活 → 清零
      expect(cap.errors.join("\n")).toContain(name); // R-sv4：原因分类入 stderr
    }
  });

  it("计数文件损坏：stderr 留痕按 0 处理（对齐 daemon.pid 陈旧清除先例，非静默）", async () => {
    const cfg = cfgFor("probe-corrupt-count");
    const { exec, calls } = makeSystemctlFake([
      { match: ["systemctl", "--user", "is-active", "--quiet", SERVICE_UNIT_NAMES.daemon], code: 0 },
    ]);
    await writePid(cfg.stateDir, WATCHDOG_GRACE_SECONDS * 1000 + 60_000);
    await mkdir(cfg.stateDir, { recursive: true });
    await writeFile(path.join(cfg.stateDir, "watchdog-fails"), "not-a-number", "utf8");
    const cap = await captureConsole(() =>
      watchdogProbeCommand(
        cfg,
        probeDeps({
          stateDir: cfg.stateDir,
          unitDir: path.join(TEST_ROOT, "probe-corrupt-count", "units"),
          exec,
          fetchImpl: async () => {
            throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
          },
        }),
      ),
    );
    expect(cap.result).toBe(0);
    expect(cap.errors.join("\n")).toContain("watchdog-fails"); // 留痕含路径
    expect(await readFile(path.join(cfg.stateDir, "watchdog-fails"), "utf8")).toBe("1"); // 按 0 起算 → 本轮 1
    expect(calls.length).toBe(1); // 未重启
  });
});

/* ───── T3-05/T3-06 登记项①：daemonCommand 生产装配挂载 GoalHost ───── */

describe("daemonCommand 生产 GoalHost 装配（登记项①：/goals 不再 501）", () => {
  it(
    "真进程 daemon：GET /goals（带 token）→ 200 []（装配前为 501 GOAL_HOST_DISABLED）；/health 含 actives",
    async () => {
      const port = await freeTcpPort();
      const stateDir = path.join(TEST_ROOT, "daemon-wiring");
      const env = {
        ...process.env,
        CODEARTS_BRIDGE_STATE_DIR: stateDir,
        CODEARTS_BRIDGE_DAEMON_URL: `http://127.0.0.1:${port}`,
        // 显式 structured：装配路径走 selectTransport 显式分支，测试全程零外部进程
        //（GoalHost 挂载本身只在目标 tick 时才用传输；本用例不建目标）。
        CODEARTS_BRIDGE_TRANSPORT: "structured",
      };
      const proc = Bun.spawn({
        cmd: [process.execPath, "src/cli.ts", "daemon"],
        cwd: PLUGIN_ROOT,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let seen = "";
        const deadline = Date.now() + 5000;
        for (;;) {
          if (Date.now() > deadline) throw new Error("daemon 前台启动超时（未见到监听行）");
          const { done, value } = await reader.read();
          if (done) break;
          seen += decoder.decode(value, { stream: true });
          if (seen.includes("监听")) break;
        }
        const token = (await readFile(path.join(stateDir, "daemon-token"), "utf8")).trim();

        const health = await fetch(`http://127.0.0.1:${port}/health`);
        expect(health.status).toBe(200);
        const healthBody = (await health.json()) as Record<string, unknown>;
        expect(healthBody["actives"]).toBe(0);

        const goals = await fetch(`http://127.0.0.1:${port}/goals`, {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(goals.status).toBe(200); // 装配前：501 GOAL_HOST_DISABLED
        expect(await goals.json()).toEqual([]);

        proc.kill("SIGINT");
        expect(await proc.exited).toBe(0);
      } finally {
        try {
          proc.kill(9);
        } catch {
          // 进程已退出：清理为无操作
        }
      }
    },
    20000,
  );
});

describe("CLI 分派（service 命令组）", () => {
  it("main([\"service\"]) 无子命令 → rc 2 未知用法；既有未知命令行为不变", async () => {
    expect(await main(["service"])).toBe(2);
    expect(await main(["frobnicate"])).toBe(2);
  });
});

/* ───── 修复环第 1 轮（真机 T4-02 缺陷①：daemonCommand 生产 verifyRun 接线） ───── */

describe("daemonCommand 生产 verifyRun 装配（①）", () => {
  it("daemonCommand 装配的 GoalHost 携带 verifyRun：带 verify 目标创建成功（修复前 GOAL_VERIFY_RUN_MISSING）且 done 后经 fake execVerify 验收 → complete（cmd/cwd 透传）", async () => {
    const { FakeTransport } = await import("../src/core/transport/fake");
    const port = await freeTcpPort();
    const stateDir = path.join(TEST_ROOT, "daemon-verify");
    const cfg = loadConfig({ stateDir, daemonUrl: `http://127.0.0.1:${port}` }, {});
    const transport = new FakeTransport();
    const verifyCalls: Array<{ cmd: string[]; cwd?: string }> = [];
    let sweepFn: (() => Promise<void>) | undefined;
    const loop = {
      start(s: () => Promise<void>) {
        sweepFn = s;
      },
      wake() {},
      stop() {
        sweepFn = undefined;
      },
    };
    let t = 1_000_000;
    // RunClock 注入（now + 可取消 delay；本用例假时钟无真延时需求，delay 仅需形态合法）
    const clock: RunClock = {
      now: () => t,
      delay(ms: number) {
        let handle: ReturnType<typeof setTimeout> | undefined;
        const promise = new Promise<void>((resolve) => {
          handle = setTimeout(resolve, ms);
        });
        return {
          promise,
          cancel: () => {
            if (handle !== undefined) clearTimeout(handle);
          },
        };
      },
    };
    const rcPromise = daemonCommand(
      cfg,
      { onReady: () => undefined },
      {
        buildTransport: () => transport,
        loop,
        clock,
        execVerify: async (cmd, cwd) => {
          verifyCalls.push({ cmd, cwd });
          return { ok: true, out: "OK" };
        },
      },
    );
    try {
      const tokenPath = path.join(stateDir, "daemon-token");
      const deadline = Date.now() + 5000;
      while (!(await fileExists(tokenPath))) {
        if (Date.now() > deadline) throw new Error("daemonCommand 启动超时（token 未生成）");
        await new Promise((r) => setTimeout(r, 25));
      }
      const token = (await readFile(tokenPath, "utf8")).trim();
      const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      // 带 verify + workdir 的目标：生产装配路径（daemonCommand → GoalHost → runner deps）。
      // 修复前：GoalHost 未接线 verifyRun → 此 POST 即 500 GOAL_VERIFY_RUN_MISSING（真机缺陷①）。
      const workdir = path.join(TEST_ROOT, "verify-wd");
      await mkdir(workdir, { recursive: true });
      const post = await fetch(`http://127.0.0.1:${port}/goals`, {
        method: "POST",
        headers: auth,
        body: JSON.stringify({ objective: "制造验收物", verify: ["echo hi"], workdir }),
      });
      expect(post.status).toBe(200);
      const created = (await post.json()) as { goalId: string };
      await sweepFn?.(); // 引导 tick：建会话 + 契约注入
      const st0 = (await fetch(`http://127.0.0.1:${port}/goals/${created.goalId}`, { headers: auth }).then((r) =>
        r.json(),
      )) as { session?: { id: string }; phase: string };
      if (st0.session === undefined) throw new Error("引导后 session 应在场");
      t += 46_000; // 越过回显守卫（thresholds.echoGuardMs=45000，2026-11-01 热修；4s 不再够）
      transport.emit({ kind: "pty", id: st0.session.id }, "output", "完成\n[GOAL-DONE]");
      await sweepFn?.(); // done 核验 → verifyRun（fake execVerify）→ complete
      const st1 = (await fetch(`http://127.0.0.1:${port}/goals/${created.goalId}`, { headers: auth }).then((r) =>
        r.json(),
      )) as { phase: string };
      expect(st1.phase).toBe("complete");
      expect(verifyCalls).toEqual([{ cmd: ["echo", "hi"], cwd: workdir }]); // cmd/cwd 逐字透传（裁定①）
    } finally {
      // 收尾：SIGTERM → daemonCommand 优雅停止（其处理器已注册，默认终止被接管）
      process.kill(process.pid, "SIGTERM");
      const rc = await Promise.race([
        rcPromise,
        new Promise<number>((_, rej) => setTimeout(() => rej(new Error("daemonCommand 未在限期优雅停止")), 5000)),
      ]);
      expect(rc).toBe(0);
    }
  }, 20000);

  it("execVerify 生产缺省实现（真执行冒烟）：echo 通过 / 非零退出显式 ok=false", async () => {
    const { execVerify } = await import("../src/cli");
    const ok = await execVerify(["/bin/echo", "verify-ok"], undefined);
    expect(ok.ok).toBe(true);
    expect(ok.out).toContain("verify-ok");
    const fail = await execVerify(["/bin/false"], undefined);
    expect(fail.ok).toBe(false);
    const missing = await execVerify(["/nonexistent/codearts-bridge-no-such-cmd"], undefined);
    expect(missing.ok).toBe(false); // spawn 失败 = 验收未过（显式失败，非静默）
  });
});

/** 文件存在性探测（轮询启动就绪用）。 */
async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
