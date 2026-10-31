/**
 * T4-05 安装包与组件升级测试（bun:test）。
 *
 * 覆盖：
 * - install.sh / uninstall.sh 语法门（bash -n）与参数面（--help / 未知参数显式报错）；
 * - install.sh 沙箱集成：HOME/STATE_DIR 全部注入临时目录（绝不触碰真实 HOME），
 *   断言 opencode 接线文件内容与幂等语义（等价跳过 / 先备份后写）；
 * - selfUpgrade 纯逻辑：git/fetch/pidAlive/sleep 全注入，无更新/更新成功/失败回滚
 *   三分支 + 脏树拒绝 + 回滚失败显式报错；
 * - upgradeCli 薄封装：无更新/升级成功/哈希失败零损坏 三分支；
 * - uninstallCommand：autoload 备份移除 / systemd 单元卸载 / 默认保留 / --purge
 *   才清状态目录 / 确认提示（--yes 跳过、非交互拒绝）。
 *
 * 隔离纪律（与 service.test.ts 同）：exec/fetch/homeDir 全部注入；FS 落点全部在
 * .tmp/installer-test/ 临时目录（afterAll 清理）；绝不真装 systemd 单元、绝不联网。
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../src/core/config";
import type { BridgeConfig } from "../src/core/config";
import { upgradeCli } from "../src/core/upgrade";
import { selfUpgrade } from "../src/core/selfupgrade";
import type { SelfUpgradeDeps } from "../src/core/selfupgrade";
import { uninstallCommand } from "../src/core/uninstaller";
import type { UninstallDeps } from "../src/core/uninstaller";
import { serviceUninstallCommand } from "../src/cli";
import type { Exec } from "../src/core/install";
import {
  DEFAULT_LAYOUT,
  NEW_ELF_CONTENT,
  NEW_VERSION,
  OLD_ELF_CONTENT,
  OLD_VERSION,
  PACKAGE_BYTES,
  contentVersionExec,
  copyExtract,
  makeFakeFetcher,
  sha256Oracle,
} from "./fixtures/fake-release";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
const INSTALL_SH = path.join(PLUGIN_ROOT, "install.sh");
const UNINSTALL_SH = path.join(PLUGIN_ROOT, "uninstall.sh");
const TEST_ROOT = path.join(PLUGIN_ROOT, ".tmp", "installer-test");

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

/* ───── install.sh / uninstall.sh 语法与参数面 ───── */

describe("install.sh / uninstall.sh 语法门（bash -n）", () => {
  it("install.sh bash -n 通过", () => {
    const p = Bun.spawnSync(["bash", "-n", INSTALL_SH], { cwd: PLUGIN_ROOT });
    expect(p.exitCode).toBe(0);
  });

  it("uninstall.sh bash -n 通过", () => {
    const p = Bun.spawnSync(["bash", "-n", UNINSTALL_SH], { cwd: PLUGIN_ROOT });
    expect(p.exitCode).toBe(0);
  });
});

describe("install.sh 参数面", () => {
  it("--help 退出码 0 且输出用法（含 --no-daemon/--state-dir）", () => {
    const p = Bun.spawnSync(["bash", INSTALL_SH, "--help"], { cwd: PLUGIN_ROOT });
    expect(p.exitCode).toBe(0);
    const text = `${p.stdout.toString()}${p.stderr.toString()}`;
    expect(text).toContain("--no-daemon");
    expect(text).toContain("--state-dir");
  });

  it("未知参数显式报错退出非 0（禁静默忽略）", () => {
    const p = Bun.spawnSync(["bash", INSTALL_SH, "--no-such-flag"], { cwd: PLUGIN_ROOT });
    expect(p.exitCode).not.toBe(0);
    expect(p.stderr.toString()).toContain("--no-such-flag");
  });
});

describe("install.sh 沙箱集成（HOME 注入临时目录）", () => {
  function sandboxEnv(homeDir: string): Record<string, string> {
    return {
      ...process.env,
      HOME: homeDir,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    } as Record<string, string>;
  }

  it("全流程 --no-daemon --state-dir --skip-gate：退出码 0 + 接线文件指向本仓库 index.ts", async () => {
    const homeDir = path.join(TEST_ROOT, "sb-home");
    const stateDir = path.join(TEST_ROOT, "sb-state");
    await mkdir(homeDir, { recursive: true });
    const p = Bun.spawnSync(
      ["bash", INSTALL_SH, "--no-daemon", "--state-dir", stateDir, "--skip-gate"],
      { cwd: PLUGIN_ROOT, env: sandboxEnv(homeDir) },
    );
    expect(p.exitCode).toBe(0);
    const wired = await readFile(
      path.join(homeDir, ".config", "opencode", "plugins", "codearts-bridge.ts"),
      "utf8",
    );
    expect(wired).toContain(`export { default } from "${PLUGIN_ROOT}/index.ts";`);
    expect(p.stdout.toString()).toContain("安装完成");
  }, 120_000);

  it("幂等重跑：接线等价 → 跳过且不产生 .bak 备份", async () => {
    const homeDir = path.join(TEST_ROOT, "sb-idem");
    const stateDir = path.join(TEST_ROOT, "sb-idem-state");
    await mkdir(homeDir, { recursive: true });
    const pluginDir = path.join(homeDir, ".config", "opencode", "plugins");
    const args = ["bash", INSTALL_SH, "--no-daemon", "--state-dir", stateDir, "--skip-gate"];
    const env = sandboxEnv(homeDir);
    expect(Bun.spawnSync(args, { cwd: PLUGIN_ROOT, env }).exitCode).toBe(0);
    expect(Bun.spawnSync(args, { cwd: PLUGIN_ROOT, env }).exitCode).toBe(0);
    const files = await readdir(pluginDir);
    expect(files).toEqual(["codearts-bridge.ts"]); // 无 .bak-* 残留
  }, 120_000);

  it("接线被外部改动 → 先备份（.bak-时间戳）后重写等价内容", async () => {
    const homeDir = path.join(TEST_ROOT, "sb-backup");
    const stateDir = path.join(TEST_ROOT, "sb-backup-state");
    await mkdir(homeDir, { recursive: true });
    const pluginDir = path.join(homeDir, ".config", "opencode", "plugins");
    const target = path.join(pluginDir, "codearts-bridge.ts");
    const args = ["bash", INSTALL_SH, "--no-daemon", "--state-dir", stateDir, "--skip-gate"];
    const env = sandboxEnv(homeDir);
    expect(Bun.spawnSync(args, { cwd: PLUGIN_ROOT, env }).exitCode).toBe(0);
    await writeFile(target, "// 手工改动\n", "utf8");
    expect(Bun.spawnSync(args, { cwd: PLUGIN_ROOT, env }).exitCode).toBe(0);
    const files = await readdir(pluginDir);
    expect(files.some((f) => f.startsWith("codearts-bridge.ts.bak-"))).toBe(true);
    expect(await readFile(target, "utf8")).toContain(`export { default } from "${PLUGIN_ROOT}/index.ts";`);
  }, 120_000);
});

/* ───── selfUpgrade（git/fetch/pidAlive/sleep 全注入） ───── */

/** selfUpgrade 假系统：按 argv 分派 git/bun/systemctl 行为，记录全部调用。 */
interface FakeGitSystem {
  calls: string[][];
  resetCalls: string[][];
  headSha: string;
  remoteSha: string;
  remoteMissing?: boolean;
  fetchFails?: boolean;
  resetFails?: boolean;
  statusOut?: string;
  lockChangesOnReset?: boolean;
  gateFail?: "install" | "typecheck" | "test" | undefined;
  systemctlFails?: boolean;
}

function makeFakeGitSystem(root: string, p: FakeGitSystem): Exec {
  return {
    run: async (cmd) => {
      p.calls.push(cmd);
      const bin = cmd[0];
      if (bin === "git") {
        // selfUpgrade 以 `git -C <root> <sub> ...` 调用；fake 按 -C 偏移取子命令与参数
        const off = cmd[1] === "-C" ? 2 : 0;
        const sub = cmd[1 + off];
        if (sub === "fetch") {
          if (p.fetchFails) return { code: 128, stdout: "", stderr: "network unreachable" };
          return { code: 0, stdout: "", stderr: "" };
        }
        if (sub === "rev-parse") {
          const target = cmd[2 + off];
          if (target === "HEAD") return { code: 0, stdout: `${p.headSha}\n`, stderr: "" };
          if (target === "origin/main") {
            if (p.remoteMissing) return { code: 128, stdout: "", stderr: "unknown revision" };
            return { code: 0, stdout: `${p.remoteSha}\n`, stderr: "" };
          }
          return { code: 128, stdout: "", stderr: "unknown revision" };
        }
        if (sub === "status") return { code: 0, stdout: p.statusOut ?? "", stderr: "" };
        if (sub === "reset") {
          p.resetCalls.push(cmd);
          if (p.resetFails) return { code: 128, stdout: "", stderr: "reset failed" };
          if (p.lockChangesOnReset) {
            await writeFile(path.join(root, "bun.lock"), "v2-changed", "utf8");
          }
          return { code: 0, stdout: "", stderr: "" };
        }
        return { code: 129, stdout: "", stderr: `unknown git sub ${sub}` };
      }
      if (bin === "bun") {
        const verb = cmd[3]; // bun --cwd <dir> <install|run|test>
        if (p.gateFail !== undefined && (verb === p.gateFail || (p.gateFail === "typecheck" && verb === "run" && cmd[4] === "typecheck"))) {
          return { code: 1, stdout: "", stderr: `${verb} failed` };
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (bin === "systemctl") {
        if (p.systemctlFails) return { code: 1, stdout: "", stderr: "restart failed" };
        return { code: 0, stdout: "", stderr: "" };
      }
      return { code: 127, stdout: "", stderr: `unknown bin ${bin}` };
    },
  };
}

/** 搭建 selfUpgrade 临时仓库 fixture（.git 标记 + bun.lock v1）。 */
async function makeRepoFixture(name: string): Promise<{ root: string; stateDir: string; cfg: BridgeConfig }> {
  const root = path.join(TEST_ROOT, name);
  const stateDir = path.join(TEST_ROOT, `${name}-state`);
  await mkdir(path.join(root), { recursive: true });
  await writeFile(path.join(root, ".git"), "gitdir: fake\n", "utf8");
  await writeFile(path.join(root, "bun.lock"), "v1", "utf8");
  await mkdir(stateDir, { recursive: true });
  const cfg = loadConfig({ stateDir }, {});
  return { root, stateDir, cfg };
}

function selfUpgradeDeps(root: string, sys: FakeGitSystem, extra: Partial<SelfUpgradeDeps> = {}): SelfUpgradeDeps {
  return {
    exec: makeFakeGitSystem(root, sys),
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    repoRoot: root,
    pidAlive: () => false,
    sleep: async () => undefined,
    ...extra,
  };
}

describe("selfUpgrade 三分支与安全门", () => {
  it("非 git 仓库 → SELF_UPGRADE_NOT_GIT_REPO（无任何 git 调用）", async () => {
    const root = path.join(TEST_ROOT, "su-nogit");
    await mkdir(root, { recursive: true });
    const cfg = loadConfig({ stateDir: path.join(TEST_ROOT, "su-nogit-state") }, {});
    const calls: string[][] = [];
    const sys: FakeGitSystem = { calls, resetCalls: [], headSha: "a", remoteSha: "b" };
    await expect(
      selfUpgrade(cfg, { exec: makeFakeGitSystem(root, sys), repoRoot: root }, { skipTests: true, skipTypecheck: true }),
    ).rejects.toMatchObject({ code: "SELF_UPGRADE_NOT_GIT_REPO" });
    expect(calls).toEqual([]);
  });

  it("git fetch 失败 → GIT_FETCH_FAILED（零写入）", async () => {
    const { root, stateDir, cfg } = await makeRepoFixture("su-fetch");
    const sys: FakeGitSystem = { calls: [], resetCalls: [], headSha: "aaa", remoteSha: "bbb", fetchFails: true };
    await expect(
      selfUpgrade(cfg, selfUpgradeDeps(root, sys), { skipTests: true, skipTypecheck: true }),
    ).rejects.toMatchObject({ code: "GIT_FETCH_FAILED" });
    expect(await stat(path.join(stateDir, "self-upgrade-backup.json")).catch(() => undefined)).toBeUndefined();
  });

  it("脏工作树 → SELF_UPGRADE_DIRTY_TREE（reset 前拒绝，零改动）", async () => {
    const { root, cfg } = await makeRepoFixture("su-dirty");
    const sys: FakeGitSystem = { calls: [], resetCalls: [], headSha: "aaa", remoteSha: "bbb", statusOut: " M x.ts\n" };
    await expect(
      selfUpgrade(cfg, selfUpgradeDeps(root, sys), { skipTests: true, skipTypecheck: true }),
    ).rejects.toMatchObject({ code: "SELF_UPGRADE_DIRTY_TREE" });
    expect(sys.resetCalls).toEqual([]);
  });

  it("无更新（HEAD==origin/main）→ up-to-date，零写入零 reset", async () => {
    const { root, stateDir, cfg } = await makeRepoFixture("su-uptodate");
    const sys: FakeGitSystem = { calls: [], resetCalls: [], headSha: "cafe01", remoteSha: "cafe01" };
    const result = await selfUpgrade(cfg, selfUpgradeDeps(root, sys), { skipTests: true, skipTypecheck: true });
    expect(result).toEqual({ action: "up-to-date", commit: "cafe01", branch: "main" });
    expect(sys.resetCalls).toEqual([]);
    expect(await stat(path.join(stateDir, "self-upgrade-backup.json")).catch(() => undefined)).toBeUndefined();
  });

  it("更新成功（无锁变更/守护未运行/门全跳）→ updated + 备份记录落盘", async () => {
    const { root, stateDir, cfg } = await makeRepoFixture("su-ok");
    const sys: FakeGitSystem = { calls: [], resetCalls: [], headSha: "aaa111", remoteSha: "bbb222" };
    const result = await selfUpgrade(cfg, selfUpgradeDeps(root, sys), { skipTests: true, skipTypecheck: true });
    expect(result).toEqual({ action: "updated", from: "aaa111", to: "bbb222", daemonRestarted: false, testsRan: false });
    expect(sys.resetCalls).toEqual([["git", "-C", root, "reset", "--hard", "bbb222"]]);
    const record = JSON.parse(await readFile(path.join(stateDir, "self-upgrade-backup.json"), "utf8")) as {
      backupCommit: string;
      targetCommit: string;
    };
    expect(record.backupCommit).toBe("aaa111");
    expect(record.targetCommit).toBe("bbb222");
    // 锁未变更 → 不该有 bun install 调用
    expect(sys.calls.some((c) => c[0] === "bun" && c[3] === "install")).toBe(false);
  });

  it("锁变更 → 触发 bun install（恰好一次）", async () => {
    const { root, cfg } = await makeRepoFixture("su-lock");
    const sys: FakeGitSystem = { calls: [], resetCalls: [], headSha: "aaa", remoteSha: "bbb", lockChangesOnReset: true };
    const result = await selfUpgrade(cfg, selfUpgradeDeps(root, sys), { skipTests: true, skipTypecheck: true });
    expect(result).toMatchObject({ action: "updated" });
    expect(sys.calls.filter((c) => c[0] === "bun" && c[3] === "install").length).toBe(1);
  });

  it("bun test 门失败 → TESTS_FAILED + 回滚到备份提交", async () => {
    const { root, stateDir, cfg } = await makeRepoFixture("su-testfail");
    const sys: FakeGitSystem = { calls: [], resetCalls: [], headSha: "aaa", remoteSha: "bbb", gateFail: "test" };
    await expect(
      selfUpgrade(cfg, selfUpgradeDeps(root, sys), { skipTests: false, skipTypecheck: true }),
    ).rejects.toMatchObject({ code: "TESTS_FAILED" });
    // 最后一次 reset 必须是回滚到备份提交
    expect(sys.resetCalls[sys.resetCalls.length - 1]).toEqual(["git", "-C", root, "reset", "--hard", "aaa"]);
    // 备份记录保留（供人工对账）
    const record = JSON.parse(await readFile(path.join(stateDir, "self-upgrade-backup.json"), "utf8")) as {
      backupCommit: string;
    };
    expect(record.backupCommit).toBe("aaa");
  });

  it("typecheck 门失败 → TYPECHECK_FAILED + 回滚", async () => {
    const { root, cfg } = await makeRepoFixture("su-tcfail");
    const sys: FakeGitSystem = { calls: [], resetCalls: [], headSha: "aaa", remoteSha: "bbb", gateFail: "typecheck" };
    await expect(
      selfUpgrade(cfg, selfUpgradeDeps(root, sys), { skipTests: true, skipTypecheck: false }),
    ).rejects.toMatchObject({ code: "TYPECHECK_FAILED" });
    expect(sys.resetCalls[sys.resetCalls.length - 1]).toEqual(["git", "-C", root, "reset", "--hard", "aaa"]);
  });

  it("回滚 reset 自身失败 → SELF_UPGRADE_ROLLBACK_FAILED（含备份指引）", async () => {
    const { root, cfg } = await makeRepoFixture("su-rbfail");
    const sys: FakeGitSystem = { calls: [], resetCalls: [], headSha: "aaa", remoteSha: "bbb", gateFail: "test" };
    // 首次 reset（升级）成功；回滚 reset 失败：以 resetFails 动态翻转模拟
    const execCalls: string[][] = [];
    let resetCount = 0;
    const exec: Exec = {
      run: async (cmd) => {
        execCalls.push(cmd);
        if (cmd[0] === "git" && cmd.includes("reset")) {
          resetCount++;
          if (resetCount >= 2) return { code: 128, stdout: "", stderr: "rollback broken" };
          return { code: 0, stdout: "", stderr: "" };
        }
        return makeFakeGitSystem(root, sys).run(cmd);
      },
    };
    await expect(
      selfUpgrade(cfg, { exec, fetchImpl: async () => new Response("{}", { status: 200 }), repoRoot: root, pidAlive: () => false, sleep: async () => undefined }, { skipTests: false, skipTypecheck: true }),
    ).rejects.toMatchObject({ code: "SELF_UPGRADE_ROLLBACK_FAILED" });
  });

  it("守护活跃（pidfile+pidAlive）→ systemctl restart + /health 验证 → daemonRestarted=true", async () => {
    const { root, stateDir, cfg } = await makeRepoFixture("su-daemon");
    await writeFile(path.join(stateDir, "daemon.pid"), "4242\n", "utf8");
    const sys: FakeGitSystem = { calls: [], resetCalls: [], headSha: "aaa", remoteSha: "bbb" };
    const result = await selfUpgrade(cfg, selfUpgradeDeps(root, sys, { pidAlive: () => true }), { skipTests: true, skipTypecheck: true });
    expect(result).toMatchObject({ action: "updated", daemonRestarted: true });
    expect(sys.calls.some((c) => c[0] === "systemctl" && c.includes("restart"))).toBe(true);
  });

  it("重启后 /health 不可达 → DAEMON_HEALTH_FAILED + 回滚 + 回滚重启", async () => {
    const { root, stateDir, cfg } = await makeRepoFixture("su-healthfail");
    await writeFile(path.join(stateDir, "daemon.pid"), "4242\n", "utf8");
    const sys: FakeGitSystem = { calls: [], resetCalls: [], headSha: "aaa", remoteSha: "bbb" };
    await expect(
      selfUpgrade(
        cfg,
        selfUpgradeDeps(root, sys, {
          pidAlive: () => true,
          fetchImpl: async () => new Response(JSON.stringify({ ok: false }), { status: 500 }),
        }),
        { skipTests: true, skipTypecheck: true },
      ),
    ).rejects.toMatchObject({ code: "DAEMON_HEALTH_FAILED" });
    expect(sys.resetCalls[sys.resetCalls.length - 1]).toEqual(["git", "-C", root, "reset", "--hard", "aaa"]);
    // 回滚路径同样重启守护（两次 restart：升级后 + 回滚后）
    const restarts = sys.calls.filter((c) => c[0] === "systemctl" && c.includes("restart"));
    expect(restarts.length).toBe(2);
  });

  it("systemctl restart 失败 → DAEMON_RESTART_FAILED + 回滚", async () => {
    const { root, stateDir, cfg } = await makeRepoFixture("su-restartfail");
    await writeFile(path.join(stateDir, "daemon.pid"), "4242\n", "utf8");
    const sys: FakeGitSystem = { calls: [], resetCalls: [], headSha: "aaa", remoteSha: "bbb", systemctlFails: true };
    await expect(
      selfUpgrade(cfg, selfUpgradeDeps(root, sys, { pidAlive: () => true }), { skipTests: true, skipTypecheck: true }),
    ).rejects.toMatchObject({ code: "DAEMON_RESTART_FAILED" });
    expect(sys.resetCalls[sys.resetCalls.length - 1]).toEqual(["git", "-C", root, "reset", "--hard", "aaa"]);
  });

  it("pidfile 内容非法 → SELF_UPGRADE_PIDFILE_INVALID（禁猜）", async () => {
    const { root, stateDir, cfg } = await makeRepoFixture("su-badpid");
    await writeFile(path.join(stateDir, "daemon.pid"), "not-a-pid\n", "utf8");
    const sys: FakeGitSystem = { calls: [], resetCalls: [], headSha: "aaa", remoteSha: "bbb" };
    await expect(
      selfUpgrade(cfg, selfUpgradeDeps(root, sys), { skipTests: true, skipTypecheck: true }),
    ).rejects.toMatchObject({ code: "SELF_UPGRADE_PIDFILE_INVALID" });
  });
});

/* ───── upgradeCli 薄封装三分支 ───── */

/** 搭建 upgradeCli fixture：旧版二进制（OLD_ELF，content-driven exec 可读版本）。 */
async function makeUpgradeCliFixture(name: string): Promise<{ installDir: string; stateDir: string; cfg: BridgeConfig; binPath: string; exec: Exec }> {
  const installDir = path.join(TEST_ROOT, name, "installers");
  const stateDir = path.join(TEST_ROOT, name, "state");
  const binDir = path.join(installDir, "bin");
  const binPath = path.join(binDir, "codearts");
  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });
  await writeFile(binPath, OLD_ELF_CONTENT, "utf8");
  await writeFile(path.join(installDir, "codearts_cli.json"), JSON.stringify({ autoupdate: false }), "utf8");
  const calls: string[][] = [];
  return { installDir, stateDir, cfg: loadConfig({ installDir, stateDir }, {}), binPath, exec: contentVersionExec(calls) };
}

describe("upgradeCli 受控升级封装", () => {
  it("无更新（当前==latest）→ already-latest，零下载零部署", async () => {
    const fx = await makeUpgradeCliFixture("uc-same");
    const fetcher = makeFakeFetcher({ version: OLD_VERSION });
    const downloads: { url: string; dest: string }[] = [];
    const probed = makeFakeFetcher({ version: OLD_VERSION }, downloads);
    const result = await upgradeCli(fx.cfg, { exec: fx.exec, fetcher: probed });
    expect(result).toEqual({ action: "already-latest", version: OLD_VERSION });
    expect(downloads).toEqual([]);
    expect(await readFile(fx.binPath, "utf8")).toBe(OLD_ELF_CONTENT);
  });

  it("有更新 → upgraded：二进制替换为新内容，审计落盘", async () => {
    const fx = await makeUpgradeCliFixture("uc-up");
    const fetcher = makeFakeFetcher({ version: NEW_VERSION });
    const result = await upgradeCli(fx.cfg, {
      exec: fx.exec,
      fetcher,
      extract: copyExtract(DEFAULT_LAYOUT),
    });
    expect(result).toMatchObject({ action: "upgraded", from: OLD_VERSION, to: NEW_VERSION });
    expect(await readFile(fx.binPath, "utf8")).toBe(NEW_ELF_CONTENT);
    // 审计（T1-05 语义继承）：install.jsonl 含 upgrade.done
    const audit = await readFile(path.join(fx.stateDir, "audit", "install.jsonl"), "utf8");
    expect(audit).toContain("upgrade.done");
  });

  it("哈希失败零损坏 → HASH_MISMATCH 且旧二进制逐字节原位", async () => {
    const fx = await makeUpgradeCliFixture("uc-hash");
    const fetcher = makeFakeFetcher({ version: NEW_VERSION, hash: "0".repeat(64), bytes: PACKAGE_BYTES });
    await expect(
      upgradeCli(fx.cfg, { exec: fx.exec, fetcher, extract: copyExtract(DEFAULT_LAYOUT) }),
    ).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    expect(await readFile(fx.binPath, "utf8")).toBe(OLD_ELF_CONTENT);
    expect(await readFile(fx.binPath, "utf8")).not.toBe(NEW_ELF_CONTENT);
    // 哈希基线核对：现文件仍是旧内容
    expect(sha256Oracle(OLD_ELF_CONTENT)).toBeDefined();
  });
});

/* ───── uninstallCommand ───── */

describe("uninstallCommand 卸载语义", () => {
  const UNIT_NAMES = ["codearts-bridge.service", "codearts-bridge-watchdog.service", "codearts-bridge-watchdog.timer"];

  async function captureConsole<T>(fn: () => Promise<T>): Promise<{ result: T; logs: string[]; errors: string[] }> {
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
      return { result: await fn(), logs, errors };
    } finally {
      console.log = origLog;
      console.error = origError;
    }
  }

  function cfgOf(name: string): BridgeConfig {
    return loadConfig(
      { installDir: path.join(TEST_ROOT, "un-ca", name), stateDir: path.join(TEST_ROOT, "un-st", name) },
      {},
    );
  }

  function baseDeps(homeDir: string, overrides: Partial<UninstallDeps> = {}): UninstallDeps {
    return {
      exec: { run: async () => ({ code: 0, stdout: "systemd 255\n", stderr: "" }) },
      homeDir,
      isTTY: true,
      confirm: async () => true,
      nowMs: () => 1_700_000_000_000,
      serviceUninstall: serviceUninstallCommand, // 真实实现（exec 注入 → tmp 文件真删，绝不真调 systemctl）
      ...overrides,
    };
  }

  it("非交互且无 --yes → UNINSTALL_CONFIRM_REQUIRED，零改动", async () => {
    const homeDir = path.join(TEST_ROOT, "un-noninteractive");
    await mkdir(homeDir, { recursive: true });
    const { result, errors } = await captureConsole(() =>
      uninstallCommand(cfgOf("ni"), baseDeps(homeDir, { isTTY: false }), { yes: false }),
    );
    expect(result).toBe(1);
    expect(errors.join("\n")).toContain("UNINSTALL_CONFIRM_REQUIRED");
    // 状态目录仍在（默认保留语义未被破坏）
    expect(await stat(cfgOf("ni").stateDir).catch(() => undefined)).toBeUndefined();
  });

  it("交互确认拒绝 → 退出码 1，零改动", async () => {
    const homeDir = path.join(TEST_ROOT, "un-decline");
    await mkdir(homeDir, { recursive: true });
    const { result } = await captureConsole(() =>
      uninstallCommand(cfgOf("dec"), baseDeps(homeDir, { confirm: async () => false }), {}),
    );
    expect(result).toBe(1);
  });

  it("--yes 全流程：autoload 备份后移除、systemd 单元卸载、默认保留状态目录与 codearts CLI", async () => {
    const homeDir = path.join(TEST_ROOT, "un-yes");
    const cfg = cfgOf("yes");
    await mkdir(path.join(homeDir, ".config", "opencode", "plugins"), { recursive: true });
    const autoload = path.join(homeDir, ".config", "opencode", "plugins", "codearts-bridge.ts");
    await writeFile(autoload, `export { default } from "/x/index.ts";\n`, "utf8");
    const unitDir = path.join(homeDir, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    for (const n of UNIT_NAMES) await writeFile(path.join(unitDir, n), "[Unit]\n", "utf8");
    await mkdir(cfg.stateDir, { recursive: true });

    const { result, logs } = await captureConsole(() =>
      uninstallCommand(cfg, baseDeps(homeDir), { yes: true }),
    );
    expect(result).toBe(0);
    // autoload：原件已删、备份在场
    expect(await stat(autoload).catch(() => undefined)).toBeUndefined();
    const pluginFiles = await readdir(path.dirname(autoload));
    expect(pluginFiles.some((f) => f.startsWith("codearts-bridge.ts.bak-"))).toBe(true);
    // 单元文件已删（serviceUninstallCommand 经注入 exec 真删 tmp 文件）
    for (const n of UNIT_NAMES) {
      expect(await stat(path.join(unitDir, n)).catch(() => undefined)).toBeUndefined();
    }
    // 默认保留状态目录
    expect(await stat(cfg.stateDir).catch(() => undefined)).toBeDefined();
    const text = logs.join("\n");
    expect(text).toContain("保留");
    expect(text).toContain("codearts CLI");
  });

  it("autoload 不在场 → 跳过且不报错", async () => {
    const homeDir = path.join(TEST_ROOT, "un-noautoload");
    await mkdir(homeDir, { recursive: true });
    const { result, logs } = await captureConsole(() =>
      uninstallCommand(cfgOf("noauto"), baseDeps(homeDir), { yes: true }),
    );
    expect(result).toBe(0);
    expect(logs.join("\n")).toContain("跳过");
  });

  it("单元在场但 systemctl 不可用 → 显式留痕且文件保留（禁静默）", async () => {
    const homeDir = path.join(TEST_ROOT, "un-nosystemd");
    const unitDir = path.join(homeDir, ".config", "systemd", "user");
    await mkdir(unitDir, { recursive: true });
    for (const n of UNIT_NAMES) await writeFile(path.join(unitDir, n), "[Unit]\n", "utf8");
    const { result, logs } = await captureConsole(() =>
      uninstallCommand(cfgOf("nosd"), baseDeps(homeDir, {
        exec: { run: async () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" })) },
      }), { yes: true }),
    );
    expect(result).toBe(0);
    expect(logs.join("\n")).toContain("systemctl");
    for (const n of UNIT_NAMES) {
      expect(await stat(path.join(unitDir, n)).catch(() => undefined)).toBeDefined(); // 保留
    }
  });

  it("--purge 清除状态目录；purge 目标=HOME → PURGE_TARGET_INVALID 拒绝", async () => {
    const homeDir = path.join(TEST_ROOT, "un-purge");
    const cfg = cfgOf("purge");
    await mkdir(homeDir, { recursive: true });
    await mkdir(cfg.stateDir, { recursive: true });
    const { result } = await captureConsole(() =>
      uninstallCommand(cfg, baseDeps(homeDir), { yes: true, purge: true }),
    );
    expect(result).toBe(0);
    expect(await stat(cfg.stateDir).catch(() => undefined)).toBeUndefined();

    // purge=HOME 守卫
    const homeCfg = loadConfig({ stateDir: homeDir, installDir: path.join(TEST_ROOT, "un-ca", "home") }, {});
    const { result: rc2, errors } = await captureConsole(() =>
      uninstallCommand(homeCfg, baseDeps(homeDir), { yes: true, purge: true }),
    );
    expect(rc2).toBe(1);
    expect(errors.join("\n")).toContain("PURGE_TARGET_INVALID");
  });
});
