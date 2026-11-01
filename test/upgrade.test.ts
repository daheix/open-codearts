/**
 * T1-05 受控升级测试（upgradeInstall / Fetcher / 布局识别 / 零损坏矩阵 / single-flight）。
 *
 * 纪律（主控裁定 + 隔离沿用）：
 * - 绝不触碰真实 HOME：FS 落点全在插件 .tmp/upgrade-test/（beforeEach 重建/afterAll 清理）；
 * - 绝不联网：Fetcher 全部注入 fake（R-up7）；真实 tar 进程仅出现在 defaultExtract
 *   专项测试（系统工具离线运行，非 codearts 二进制）；
 * - 绝不真跑 codearts 二进制：exec 注入 content-driven fake（见 fixtures/fake-release.ts）。
 *
 * 覆盖矩阵（R-up2..R-up9，逐条对号）：
 * - happy path：全步骤审计顺序 + 部署/备份/脚本/暂存清理 + UpgradeResult 契约（R-up9）；
 * - Review-Focus-2：暂存跨文件系统 → STAGING_CROSS_DEVICE 且不动现有安装（R-up2）；
 * - 哈希不匹配 → HASH_MISMATCH，旧二进制逐字节不变（R-up3）；
 * - 解压失败（注入）→ 显式错误，旧二进制不变（R-up3/R-up8）；
 * - 部署中断（binDir 只读注入 copyDeploy 失败）→ 旧二进制原位（R-up3）；
 * - Review-Focus-5：并发两个 upgrade → 第二个 ALREADY_RUNNING（R-up4）；
 * - 布局识别：候选顺序/ELF 判定/脚本可选/全无 → PACKAGE_LAYOUT_INVALID（R-up5）；
 * - 默认解压器：真实 fixture tar 离线解压 + 损坏包显式失败（R-up8）；
 * - 自检：新二进制不可读版本/版本不符 → 显式报错（R-up9）。
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { BridgeConfig } from "../src/core/config";
import { BridgeError } from "../src/core/errors";
import { fsyncDir } from "../src/core/fsx";
import { createNodeExec } from "../src/core/install";
import { sha256File } from "../src/core/fsx";
import { defaultExtract, upgradeInstall, type Fetcher } from "../src/core/upgrade";
import {
  buildUstarGzip,
  contentVersionExec,
  copyExtract,
  DEFAULT_LAYOUT,
  FAKE_URL,
  makeFakeFetcher,
  NEW_ELF_CONTENT,
  NEW_ELF_NO_VERSION,
  NEW_ELF_WRONG_VERSION,
  NEW_SCRIPT_CONTENT,
  NEW_VERSION,
  OLD_ELF_CONTENT,
  OLD_ELF_NO_VERSION,
  OLD_VERSION,
  PACKAGE_BYTES,
  sha256Oracle,
  type FakeDownloadRecord,
  type FakeExtractRecord,
} from "./fixtures/fake-release";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
const TEST_ROOT = path.join(PLUGIN_ROOT, ".tmp", "upgrade-test");
/** 跨设备用例的物理前提落点（/tmp 与仓库不同 ZFS 数据集，EXDEV 实测；仅本用例使用，afterAll 清理）。 */
const EXTERNAL_ROOT = path.join("/tmp/opencode", `codearts-bridge-upgrade-test-${process.pid}`);

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await rm(EXTERNAL_ROOT, { recursive: true, force: true });
});

/* ───── 测试辅助 ───── */

function cfgOf(installDir: string, stateDir: string): BridgeConfig {
  return {
    installDir,
    stateDir,
    transport: "auto",
    ptyHost: "auto",
    daemonUrl: "http://127.0.0.1:4577",
    akskFile: path.join(stateDir, "config.env"),
    thresholds: { stallSeconds: 60, retryCapSeconds: 60, strikes: 3, echoGuardMs: 3000 },
    autoNudge: true,
  };
}

interface UpgradeFixture {
  installDir: string;
  stateDir: string;
  binDir: string;
  binPath: string;
}

/** 搭建升级 fixture：installDir/bin 目录 + 可选旧二进制（null=无旧安装）。 */
async function makeUpgradeFixture(
  name: string,
  opts: { oldBin?: string | null } = {},
): Promise<UpgradeFixture> {
  const root = path.join(TEST_ROOT, name);
  const installDir = path.join(root, "installers");
  const stateDir = path.join(root, "state");
  const binDir = path.join(installDir, "bin");
  const binPath = path.join(binDir, "codearts");
  await mkdir(binDir, { recursive: true });
  if (opts.oldBin !== null) {
    await writeFile(binPath, opts.oldBin ?? OLD_ELF_CONTENT, "utf8");
  }
  return { installDir, stateDir, binDir, binPath };
}

interface HappyDeps {
  fetcher: Fetcher;
  exec: ReturnType<typeof contentVersionExec>;
  extract: ReturnType<typeof copyExtract>;
  downloads: FakeDownloadRecord[];
  extracts: FakeExtractRecord[];
  execCalls: string[][];
}

/** 组装 happy-path 注入依赖：fake fetcher + content-driven exec + copy 布局的 extract。 */
function makeDeps(fx: UpgradeFixture, layout: Record<string, string> = DEFAULT_LAYOUT): HappyDeps {
  const downloads: FakeDownloadRecord[] = [];
  const extracts: FakeExtractRecord[] = [];
  const execCalls: string[][] = [];
  return {
    fetcher: makeFakeFetcher({}, downloads),
    exec: contentVersionExec(execCalls),
    extract: copyExtract(layout, extracts),
    downloads,
    extracts,
    execCalls,
  };
}

/** 读取审计文件（install.jsonl）为对象数组（与 install.test.ts 同款辅助）。 */
async function readAuditLines(stateDir: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path.join(stateDir, "audit", "install.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const AUDIT_ID_RE = /^upg-\d+-[0-9a-f]{6}$/;

/** 期望暂存目录（R-up2 固定命名：<stateDir>/tmp/staging-<version>）。 */
function stagingDirOf(fx: UpgradeFixture, version: string = NEW_VERSION): string {
  return path.join(fx.stateDir, "tmp", `staging-${version}`);
}

/** 目录是否存在（存在性探测，不抛）。 */
async function exists(p: string): Promise<boolean> {
  return (await stat(p).then(
    () => true,
    () => false,
  )) as boolean;
}

/** 错误捕获辅助（与 install.test.ts 同款 then/null/e 模式）。 */
function catchOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => null,
    (e: unknown) => e,
  );
}

/* ───── 用例 ───── */

describe("T1-05 upgradeInstall（happy path，R-up9 收尾语义）", () => {
  it("全步骤成功：下载→哈希→解压→自检→部署（脚本+二进制）→复验→旧版转备份→fsync→审计", async () => {
    const fx = await makeUpgradeFixture("happy");
    const deps = makeDeps(fx);
    const result = await upgradeInstall(cfgOf(fx.installDir, fx.stateDir), deps);

    // UpgradeResult 契约（任务书接口）
    expect(result.from).toBe(OLD_VERSION);
    expect(result.to).toBe(NEW_VERSION);
    expect(result.sha256).toBe(sha256Oracle(NEW_ELF_CONTENT));
    expect(result.stagingDir).toBe(stagingDirOf(fx));
    expect(result.auditId).toMatch(AUDIT_ID_RE);

    // 二进制已替换为新内容、mode 0755
    expect(await readFile(fx.binPath, "utf8")).toBe(NEW_ELF_CONTENT);
    expect((await stat(fx.binPath)).mode & 0o777).toBe(0o755);

    // 可选脚本一并部署到 <installDir>/codearts（R-up5）
    const scriptPath = path.join(fx.installDir, "codearts");
    expect(await readFile(scriptPath, "utf8")).toBe(NEW_SCRIPT_CONTENT);
    expect((await stat(scriptPath)).mode & 0o777).toBe(0o755);

    // 旧版转备份：codearts.bak-26.10.9 内容=旧二进制（R-up9）
    const backupPath = path.join(fx.binDir, `codearts.bak-${OLD_VERSION}`);
    expect(await readFile(backupPath, "utf8")).toBe(OLD_ELF_CONTENT);

    // 零垃圾：binDir 仅剩 二进制+备份，无 deploy-tmp 残留、无 codearts.delete
    expect((await readdir(fx.binDir)).sort()).toEqual([
      "codearts",
      `codearts.bak-${OLD_VERSION}`,
    ]);

    // 调用记录：download 落在暂存目录；extract 一次；exec 恰好 3 次 --version（旧探/自检/复验）
    expect(deps.downloads.length).toBe(1);
    expect(deps.downloads[0]?.url).toBe(FAKE_URL);
    expect(deps.downloads[0]?.dest).toBe(path.join(stagingDirOf(fx), "package.tar.gz"));
    expect(deps.extracts.length).toBe(1);
    expect(deps.extracts[0]?.destDir).toBe(path.join(stagingDirOf(fx), "extracted"));
    // 复验口径（2026-11-01 热修）：官方入口 wrapper 优先——第三次 exec 探测的是
    // 部署后的 wrapper 脚本（fake exec 委托引擎取版本），不再是 bin 本体。
    expect(deps.execCalls).toEqual([
      [fx.binPath, "--version"],
      [path.join(stagingDirOf(fx), "extracted", "bin", "codearts"), "--version"],
      [path.join(fx.installDir, "codearts"), "--version"],
    ]);

    // 暂存清理（R-up3 临时件清理）
    expect(await exists(stagingDirOf(fx))).toBe(false);

    // 审计（修复环 I1/spec §8）：upgrade.start → 11 个 upgrade.step → upgrade.done 全序列
    const lines = await readAuditLines(fx.stateDir);
    const seq = lines
      .filter((l) => typeof l["kind"] === "string" && (l["kind"] as string).startsWith("upgrade."))
      .map((l) =>
        l["kind"] === "upgrade.step"
          ? `step:${String(l["step"])}`
          : String(l["kind"]).slice("upgrade.".length),
      );
    expect(seq).toEqual([
      "start",
      "step:release",
      "step:staging",
      "step:download",
      "step:hash",
      "step:extract",
      "step:layout",
      "step:self-check",
      "step:deploy",
      "step:verify",
      "step:backup",
      "step:fsync",
      "done",
    ]);
    // upgrade.start：auditId 与结果契约一致（修复环 I1）
    const start = lines.find((l) => l["kind"] === "upgrade.start");
    expect(start?.["auditId"]).toBe(result.auditId);
    const stagingStep = lines.find((l) => l["step"] === "staging");
    expect(stagingStep?.["stagingDir"]).toBe(stagingDirOf(fx));
    const releaseStep = lines.find((l) => l["step"] === "release");
    expect(releaseStep?.["from"]).toBe(OLD_VERSION);
    expect(releaseStep?.["oldSha256"]).toBe(sha256Oracle(OLD_ELF_CONTENT)); // 零损坏基线入审计
    const backupStep = lines.find((l) => l["step"] === "backup");
    expect(backupStep?.["result"]).toBe("created");
    const done = lines.find((l) => l["kind"] === "upgrade.done");
    expect(done?.["auditId"]).toBe(result.auditId);
    expect(done?.["from"]).toBe(OLD_VERSION);
    expect(done?.["to"]).toBe(NEW_VERSION);
    expect(done?.["sha256"]).toBe(sha256Oracle(NEW_ELF_CONTENT));
    expect(done?.["stagingDir"]).toBe(stagingDirOf(fx));
  });

  it("备份已存在 → 不覆盖既有备份（backup 步骤 result=exists），升级照常成功", async () => {
    const fx = await makeUpgradeFixture("backup-exists");
    const preExisting = "pre-existing backup bytes\n";
    const backupPath = path.join(fx.binDir, `codearts.bak-${OLD_VERSION}`);
    await writeFile(backupPath, preExisting, "utf8");
    const deps = makeDeps(fx);
    await upgradeInstall(cfgOf(fx.installDir, fx.stateDir), deps);

    expect(await readFile(backupPath, "utf8")).toBe(preExisting); // 原样未动
    const lines = await readAuditLines(fx.stateDir);
    const backupStep = lines.find((l) => l["step"] === "backup");
    expect(backupStep?.["result"]).toBe("exists");
  });

  it("无旧安装（bin 为空目录）→ from=none、备份跳过、全新部署成功", async () => {
    const fx = await makeUpgradeFixture("fresh-install", { oldBin: null });
    const deps = makeDeps(fx);
    const result = await upgradeInstall(cfgOf(fx.installDir, fx.stateDir), deps);

    expect(result.from).toBe("none");
    expect(result.to).toBe(NEW_VERSION);
    expect(await readFile(fx.binPath, "utf8")).toBe(NEW_ELF_CONTENT);
    expect(await exists(path.join(fx.binDir, `codearts.bak-${OLD_VERSION}`))).toBe(false);
    const lines = await readAuditLines(fx.stateDir);
    const backupStep = lines.find((l) => l["step"] === "backup");
    expect(backupStep?.["result"]).toBe("no-old-binary");
  });

  it("旧二进制无 VERSION 标记（不可读版本）→ from=unknown、备份跳过（旧版无效），升级成功", async () => {
    const fx = await makeUpgradeFixture("old-invalid", { oldBin: OLD_ELF_NO_VERSION });
    const deps = makeDeps(fx);
    const result = await upgradeInstall(cfgOf(fx.installDir, fx.stateDir), deps);

    expect(result.from).toBe("unknown");
    const lines = await readAuditLines(fx.stateDir);
    const backupStep = lines.find((l) => l["step"] === "backup");
    expect(backupStep?.["result"]).toBe("old-invalid");
    expect(await exists(path.join(fx.binDir, `codearts.bak-${OLD_VERSION}`))).toBe(false);
  });
});

describe("T1-05 Review-Focus-2：暂存跨文件系统（R-up2）", () => {
  it("staging 与 binDir 不同 st_dev → BridgeError(STAGING_CROSS_DEVICE) 且不动现有安装", async () => {
    const fx = await makeUpgradeFixture("xdev");
    const oldSha = await sha256File(fx.binPath);

    // <stateDir>/tmp → 真实异设备目录（symlink 使固定 staging 路径落到另一文件系统）
    const external = path.join(EXTERNAL_ROOT, "xdev-state-tmp");
    await mkdir(external, { recursive: true });
    await mkdir(fx.stateDir, { recursive: true });
    await symlink(external, path.join(fx.stateDir, "tmp"));

    // 前提自检：两落点必须确实异设备，否则本测试前提失效（显式失败，禁止静默通过）
    const probe = path.join(external, "staging-probe");
    await mkdir(probe, { recursive: true });
    const externalDev = (await stat(probe)).dev;
    await rm(probe, { recursive: true });
    const binDev = (await stat(fx.binDir)).dev;
    expect(externalDev).not.toBe(binDev);

    const deps = makeDeps(fx);
    const err: unknown = await catchOf(
      upgradeInstall(cfgOf(fx.installDir, fx.stateDir), deps),
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("STAGING_CROSS_DEVICE");
    expect((err as BridgeError).remediation).toBeDefined();

    // 不动现有安装：旧二进制逐字节不变；且失败发生在下载之前（零浪费 fail-fast）
    expect(await sha256File(fx.binPath)).toBe(oldSha);
    expect(await readFile(fx.binPath, "utf8")).toBe(OLD_ELF_CONTENT);
    expect(deps.downloads.length).toBe(0);
    // 暂存清理（本次运行创建的 staging 目录被回收）
    expect(await exists(stagingDirOf(fx))).toBe(false);
  });
});

describe("T1-05 零损坏矩阵（R-up3）", () => {
  it("哈希不匹配 → BridgeError(HASH_MISMATCH)，现有安装零变化（前后哈希断言）", async () => {
    const fx = await makeUpgradeFixture("hash-mismatch");
    const oldSha = await sha256File(fx.binPath);
    const downloads: FakeDownloadRecord[] = [];
    const deps: HappyDeps["fetcher"] = makeFakeFetcher(
      { hash: "0".repeat(64) }, // 与包字节不符的清单哈希
      downloads,
    );
    const err: unknown = await catchOf(
      upgradeInstall(cfgOf(fx.installDir, fx.stateDir), {
        fetcher: deps,
        exec: contentVersionExec([]),
        extract: copyExtract(DEFAULT_LAYOUT),
      }),
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("HASH_MISMATCH");
    expect((err as Error).message).toContain("0".repeat(64)); // 消息含期望哈希
    expect(downloads.length).toBe(1); // 已下载后才校验

    // 现有安装零变化 + 暂存清理
    expect(await sha256File(fx.binPath)).toBe(oldSha);
    expect(await exists(stagingDirOf(fx))).toBe(false);

    // 修复环 I1：失败终态审计——upgrade.fail（含 code/step），与 upgrade.start 同 auditId 可串联
    const lines = await readAuditLines(fx.stateDir);
    const start = lines.find((l) => l["kind"] === "upgrade.start");
    const fail = lines.find((l) => l["kind"] === "upgrade.fail");
    expect(start).toBeDefined();
    expect(fail?.["auditId"]).toBe(start?.["auditId"]);
    expect(fail?.["code"]).toBe("HASH_MISMATCH");
    expect(fail?.["step"]).toBe("hash");
  });

  it("解压失败（注入）→ 显式错误（EXTRACT_FAILED，原因保留），现有安装零变化", async () => {
    const fx = await makeUpgradeFixture("extract-fail");
    const oldSha = await sha256File(fx.binPath);
    const err: unknown = await catchOf(
      upgradeInstall(cfgOf(fx.installDir, fx.stateDir), {
        fetcher: makeFakeFetcher(),
        exec: contentVersionExec([]),
        extract: async () => {
          throw new Error("boom-extract");
        },
      }),
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("EXTRACT_FAILED");
    expect((err as Error).message).toContain("boom-extract");
    expect(await sha256File(fx.binPath)).toBe(oldSha);
    expect(await exists(stagingDirOf(fx))).toBe(false);
  });

  it("部署中断（binDir 只读注入 copyDeploy 失败）→ 显式 IO 错误，原二进制仍在原位（零损坏）", async () => {
    const fx = await makeUpgradeFixture("deploy-interrupt");
    const oldSha = await sha256File(fx.binPath);
    // 无脚本布局：binDir 的首次写入即二进制部署（中断点精确落在部署步骤）
    const deps = makeDeps(fx, { "bin/codearts": NEW_ELF_CONTENT });
    await chmod(fx.binDir, 0o555); // 非 root：写 tmp 必 EACCES
    try {
      const err: unknown = await catchOf(
        upgradeInstall(cfgOf(fx.installDir, fx.stateDir), deps),
      );
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).code).toBe("FS_WRITE_FAILED");
      expect((err as Error).message).toContain(fx.binPath);
      expect((err as Error).message).toContain("EACCES");

      // 零损坏断言：旧二进制逐字节原位；binDir 无部署临时件残留
      expect(await sha256File(fx.binPath)).toBe(oldSha);
      expect(await readFile(fx.binPath, "utf8")).toBe(OLD_ELF_CONTENT);
    } finally {
      await chmod(fx.binDir, 0o755); // 还原以便清理
    }
    expect(await exists(stagingDirOf(fx))).toBe(false);
  });

  it("复验失败（部署后版本复核不符）→ 先回滚旧版快照再抛 BridgeError(UPGRADE_VERIFY_FAILED)，binDir 字节恢复原样", async () => {
    const fx = await makeUpgradeFixture("verify-fail");
    // 路径分流 exec：自检（staging 路径）版本正确；复验（部署后的 binPath）版本不符
    // （模拟"部署后二进制被外部替换/损坏"，哈希可能仍巧合一致而运行态已坏——复验必须拦住）
    const execByPath = {
      run: async (cmd: string[]) => {
        const target = cmd[0] ?? "";
        if (target.includes("staging-")) return { code: 0, stdout: `${NEW_VERSION}\n`, stderr: "" };
        return { code: 0, stdout: "0.0.0\n", stderr: "" };
      },
    };
    const err: unknown = await catchOf(
      upgradeInstall(cfgOf(fx.installDir, fx.stateDir), {
        fetcher: makeFakeFetcher(),
        exec: execByPath,
        extract: copyExtract({ "bin/codearts": NEW_ELF_CONTENT }),
      }),
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("UPGRADE_VERIFY_FAILED");

    // 修复环 I2①②：复验失败先回滚——bin/codearts 字节恢复旧版原样；
    // fail 审计含 rolledBack:true（step=verify）；暂存照常清理
    expect(await readFile(fx.binPath, "utf8")).toBe(OLD_ELF_CONTENT);
    const lines = await readAuditLines(fx.stateDir);
    const fail = lines.find((l) => l["kind"] === "upgrade.fail");
    expect(fail?.["code"]).toBe("UPGRADE_VERIFY_FAILED");
    expect(fail?.["step"]).toBe("verify");
    expect(fail?.["rolledBack"]).toBe(true);
    expect(await exists(stagingDirOf(fx))).toBe(false);
  });

  it("复验失败且回滚失败 → 暂存与旧版快照保留，fail 审计含 snapshotPath（修复环 I2③）", async () => {
    const fx = await makeUpgradeFixture("verify-rollback-fail");
    // 路径分流 exec：旧探（binPath 第 1 次）旧版可读；自检（staging）版本正确；
    // 复验（binPath 第 2 次）先把 binDir 置只读再报版本不符——部署已发生，
    // 回滚 copyDeploy 向 binDir 写 tmp 必 EACCES（注入"回滚在该调用点失败"）。
    let binCalls = 0;
    const execByPath = {
      run: async (cmd: string[]) => {
        const target = cmd[0] ?? "";
        if (target.includes("staging-")) return { code: 0, stdout: `${NEW_VERSION}\n`, stderr: "" };
        binCalls += 1;
        if (binCalls === 1) return { code: 0, stdout: `${OLD_VERSION}\n`, stderr: "" };
        await chmod(fx.binDir, 0o555); // 复验时点才只读：破坏性 rename 已发生，回滚写入必失败
        return { code: 0, stdout: "0.0.0\n", stderr: "" };
      },
    };
    try {
      const err: unknown = await catchOf(
        upgradeInstall(cfgOf(fx.installDir, fx.stateDir), {
          fetcher: makeFakeFetcher(),
          exec: execByPath,
          extract: copyExtract({ "bin/codearts": NEW_ELF_CONTENT }),
        }),
      );
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).code).toBe("UPGRADE_VERIFY_FAILED");

      // 回滚失败：暂存目录连同旧版快照一并保留（供人工恢复）；快照路径入 fail 审计与 remediation
      const snapshotPath = path.join(stagingDirOf(fx), "old-codearts");
      expect(await exists(stagingDirOf(fx))).toBe(true);
      expect(await readFile(snapshotPath, "utf8")).toBe(OLD_ELF_CONTENT);
      const lines = await readAuditLines(fx.stateDir);
      const fail = lines.find((l) => l["kind"] === "upgrade.fail");
      expect(fail?.["code"]).toBe("UPGRADE_VERIFY_FAILED");
      expect(fail?.["step"]).toBe("verify");
      expect(fail?.["rolledBack"]).toBe(false);
      expect(fail?.["snapshotPath"]).toBe(snapshotPath);
      expect((err as BridgeError).remediation).toContain(snapshotPath);
    } finally {
      await chmod(fx.binDir, 0o755); // 还原以便清理
    }
  });
});

describe("T1-05 Review-Focus-5：single-flight（R-up4）", () => {
  it("并发两个 upgrade → 第二个 BridgeError(ALREADY_RUNNING)；结束后标志释放可再次升级", async () => {
    const fx = await makeUpgradeFixture("single-flight");

    // 第一个升级：卡在 latest()（手工门控），保证并发窗口确定性
    let releaseGate: ((r: void) => void) | undefined;
    let markLatestCalled: (() => void) | undefined;
    const latestCalled = new Promise<void>((resolve) => {
      markLatestCalled = resolve;
    });
    const gatedFetcher: Fetcher = {
      latest: () => {
        markLatestCalled?.(); // 先确认第一跑已进门控（时序确定），再挂起等待放行
        return new Promise((resolve) => {
          releaseGate = () =>
            resolve({ version: NEW_VERSION, url: FAKE_URL, hash: sha256Oracle(PACKAGE_BYTES) });
        });
      },
      download: async (url, dest) => {
        void url;
        await writeFile(dest, PACKAGE_BYTES, "utf8");
      },
    };
    const first = upgradeInstall(cfgOf(fx.installDir, fx.stateDir), {
      fetcher: gatedFetcher,
      exec: contentVersionExec([]),
      extract: copyExtract(DEFAULT_LAYOUT),
    });

    // 第二个升级在第一个仍挂起时发起 → 同步命中 single-flight
    const second = upgradeInstall(cfgOf(fx.installDir, fx.stateDir), {
      fetcher: makeFakeFetcher(),
      exec: contentVersionExec([]),
      extract: copyExtract(DEFAULT_LAYOUT),
    });
    const secondErr: unknown = await catchOf(second);
    expect(secondErr).toBeInstanceOf(BridgeError);
    expect((secondErr as BridgeError).code).toBe("ALREADY_RUNNING");
    expect((secondErr as BridgeError).remediation).toBeDefined();

    // 放行第一个 → 正常完成；标志已释放（finally），随后串行升级可再次执行
    await latestCalled; // 确保门控已挂起（releaseGate 已赋值）
    releaseGate?.();
    const result = await first;
    expect(result.to).toBe(NEW_VERSION);

    const fx2 = await makeUpgradeFixture("single-flight-after");
    const again = await upgradeInstall(cfgOf(fx2.installDir, fx2.stateDir), makeDeps(fx2));
    expect(again.to).toBe(NEW_VERSION);
  });
});

describe("T1-05 包布局识别（R-up5）", () => {
  it("候选优先级：bin/codearts 与 agentkernel 同时在场 → 取首个候选 bin/codearts", async () => {
    const fx = await makeUpgradeFixture("layout-priority");
    const agentContent = "\x7fELF-agentkernel payload VERSION=26.11.0\n";
    const deps = makeDeps(fx, {
      "bin/codearts": NEW_ELF_CONTENT,
      agentkernel: agentContent,
    });
    const result = await upgradeInstall(cfgOf(fx.installDir, fx.stateDir), deps);
    expect(await readFile(fx.binPath, "utf8")).toBe(NEW_ELF_CONTENT); // 首个候选胜出
    expect(result.sha256).toBe(sha256Oracle(NEW_ELF_CONTENT));
  });

  it("bin/codearts 缺席 → 回落 agentkernel（ELF）；根目录 codearts 脚本仍一并部署", async () => {
    const fx = await makeUpgradeFixture("layout-fallback");
    const agentContent = "\x7fELF-agentkernel payload VERSION=26.11.0\n";
    const deps = makeDeps(fx, {
      agentkernel: agentContent,
      codearts: NEW_SCRIPT_CONTENT, // 脚本（#! 开头文本件）与二进制不同件
    });
    const result = await upgradeInstall(cfgOf(fx.installDir, fx.stateDir), deps);
    expect(await readFile(fx.binPath, "utf8")).toBe(agentContent);
    expect(result.sha256).toBe(sha256Oracle(agentContent));
    expect(await readFile(path.join(fx.installDir, "codearts"), "utf8")).toBe(NEW_SCRIPT_CONTENT);
  });

  it("ELF 优先于脚本同名件：根目录 codearts 为 ELF 时它是二进制而非脚本", async () => {
    const fx = await makeUpgradeFixture("layout-root-elf");
    const deps = makeDeps(fx, {
      codearts: NEW_ELF_CONTENT, // 前两个候选缺失，根目录 codearts 是 ELF 二进制
    });
    const result = await upgradeInstall(cfgOf(fx.installDir, fx.stateDir), deps);
    expect(await readFile(fx.binPath, "utf8")).toBe(NEW_ELF_CONTENT);
    expect(result.sha256).toBe(sha256Oracle(NEW_ELF_CONTENT));
    // 不应把二进制自身再当脚本部署出第二份（同名目标即二进制本身，无额外脚本件）
    expect(await exists(path.join(fx.installDir, "codearts"))).toBe(false);
  });

  it("候选全无 ELF（仅垃圾文件）→ BridgeError(PACKAGE_LAYOUT_INVALID)，现有安装零变化", async () => {
    const fx = await makeUpgradeFixture("layout-invalid");
    const oldSha = await sha256File(fx.binPath);
    const deps = makeDeps(fx, { "README.txt": "not an elf", "bin/other": "\x7fELF-not-at-candidate-path" });
    const err: unknown = await catchOf(
      upgradeInstall(cfgOf(fx.installDir, fx.stateDir), deps),
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("PACKAGE_LAYOUT_INVALID");
    expect((err as Error).message).toContain("bin/codearts"); // 消息列出候选
    expect(await sha256File(fx.binPath)).toBe(oldSha);
  });
});

describe("T1-05 新二进制自检（R-up9）", () => {
  it("新二进制 --version 无法解析 → BridgeError(PACKAGE_BINARY_INVALID)，现有安装零变化", async () => {
    const fx = await makeUpgradeFixture("self-check-invalid");
    const oldSha = await sha256File(fx.binPath);
    const deps = makeDeps(fx, { "bin/codearts": NEW_ELF_NO_VERSION });
    const err: unknown = await catchOf(
      upgradeInstall(cfgOf(fx.installDir, fx.stateDir), deps),
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("PACKAGE_BINARY_INVALID");
    expect(await sha256File(fx.binPath)).toBe(oldSha);
  });

  it("新二进制版本与 Release.version 不符 → BridgeError(PACKAGE_VERSION_MISMATCH)，现有安装零变化", async () => {
    const fx = await makeUpgradeFixture("self-check-mismatch");
    const oldSha = await sha256File(fx.binPath);
    const deps = makeDeps(fx, { "bin/codearts": NEW_ELF_WRONG_VERSION });
    const err: unknown = await catchOf(
      upgradeInstall(cfgOf(fx.installDir, fx.stateDir), deps),
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("PACKAGE_VERSION_MISMATCH");
    expect((err as Error).message).toContain("26.99.99");
    expect((err as Error).message).toContain(NEW_VERSION);
    expect(await sha256File(fx.binPath)).toBe(oldSha);
  });
});

describe("T1-05 指定版本（opts.version）", () => {
  it("请求版本与 latest 不符 → BridgeError(RELEASE_VERSION_MISMATCH)，现有安装零变化", async () => {
    const fx = await makeUpgradeFixture("version-mismatch");
    const oldSha = await sha256File(fx.binPath);
    const err: unknown = await catchOf(
      upgradeInstall(
        cfgOf(fx.installDir, fx.stateDir),
        makeDeps(fx),
        { version: "26.12.0" },
      ),
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("RELEASE_VERSION_MISMATCH");
    expect((err as Error).message).toContain("26.12.0");
    expect((err as Error).message).toContain(NEW_VERSION);
    expect(await sha256File(fx.binPath)).toBe(oldSha);
  });

  it("请求版本与 latest 一致 → 正常升级", async () => {
    const fx = await makeUpgradeFixture("version-match");
    const result = await upgradeInstall(
      cfgOf(fx.installDir, fx.stateDir),
      makeDeps(fx),
      { version: NEW_VERSION },
    );
    expect(result.to).toBe(NEW_VERSION);
    expect(await readFile(fx.binPath, "utf8")).toBe(NEW_ELF_CONTENT);
  });
});

describe("T1-05 defaultExtract（R-up8：本地 tar -xzf，经注入 Exec 离线）", () => {
  it("真实 fixture tar（本地 ustar+gzip 构建）解压出 R-up5 布局文件（真实 tar 进程）", async () => {
    const dir = path.join(TEST_ROOT, "tar-ok");
    await mkdir(dir, { recursive: true });
    const pkg = path.join(dir, "package.tar.gz");
    await writeFile(
      pkg,
      buildUstarGzip([
        { rel: "bin/codearts", content: NEW_ELF_CONTENT },
        { rel: "codearts", content: NEW_SCRIPT_CONTENT },
      ]),
    );
    const destDir = path.join(dir, "extracted");
    await mkdir(destDir, { recursive: true });
    await defaultExtract(createNodeExec({ timeoutMs: 10_000 }), pkg, destDir);

    // 解压产物逐字节正确 + ELF 魔数在场（R-up5 判定的物理前提）
    expect(await readFile(path.join(destDir, "bin", "codearts"), "utf8")).toBe(NEW_ELF_CONTENT);
    expect(await readFile(path.join(destDir, "codearts"), "utf8")).toBe(NEW_SCRIPT_CONTENT);
    const head = await readFile(path.join(destDir, "bin", "codearts"));
    expect(head[0]).toBe(0x7f);
    expect(head[1]).toBe(0x45); // 'E'
    expect(head[2]).toBe(0x4c); // 'L'
    expect(head[3]).toBe(0x46); // 'F'
  });

  it("损坏包（非 tar 字节）→ BridgeError(EXTRACT_FAILED) 含 tar stderr 摘要", async () => {
    const dir = path.join(TEST_ROOT, "tar-bad");
    await mkdir(dir, { recursive: true });
    const pkg = path.join(dir, "package.tar.gz");
    await writeFile(pkg, "this is definitely not a gzip tar archive\n", "utf8");
    const destDir = path.join(dir, "extracted");
    await mkdir(destDir, { recursive: true });
    const err: unknown = await catchOf(
      defaultExtract(createNodeExec({ timeoutMs: 10_000 }), pkg, destDir),
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("EXTRACT_FAILED");
    expect((err as Error).message).toContain(pkg);
  });
});

describe("T1-05 fsyncDir（R-up6）", () => {
  it("既有目录 fsync 成功解析；不存在目录 → BridgeError(FS_WRITE_FAILED) 含路径", async () => {
    const dir = path.join(TEST_ROOT, "fsync-ok");
    await mkdir(dir, { recursive: true });
    await expect(fsyncDir(dir)).resolves.toBeUndefined();

    const missing = path.join(TEST_ROOT, "fsync-missing");
    const err: unknown = await catchOf(fsyncDir(missing));
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("FS_WRITE_FAILED");
    expect((err as Error).message).toContain(missing);
  });
});
