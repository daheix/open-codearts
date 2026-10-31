/**
 * T1-03/T1-04 安装管家测试（bun:test）。
 *
 * T1-03：probeInstall 只读探测；T1-04：repairInstall（备份恢复自愈）/
 * ensureBackup（备份刷新）/ fixAutoupdate（显式开关修正）。
 *
 * 纪律（主控裁定 R-a/R-c/R-d/R-e + T1-04 隔离裁定）：
 * - 绝不真跑 codearts 二进制：exec 一律注入 fake（唯一例外用 /bin/sh 脚本测真实 exec 原语）；
 * - 绝不触碰真实 HOME：cfg 经 loadConfig 注入 .tmp/install-test/ 下的绝对路径；
 * - probeInstall 只读状态采集：业务态以字段如实表达（不抛业务错）；
 *   FS 意外错误（非 ENOENT）与配置文件损坏 → 显式抛 BridgeError；
 * - afterAll 清理临时目录（用后即删）。
 */
import { existsSync } from "node:fs";
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../src/core/config";
import { BridgeError } from "../src/core/errors";
import { sha256File } from "../src/core/fsx";
import { createNodeExec, ensureBackup, probeInstall, repairInstall } from "../src/core/install";
import type { Exec } from "../src/core/install";
import type { BridgeConfig } from "../src/core/config";
import {
  BIN_CONTENT,
  PINNED_VERSION,
  fakeExec,
  makeBinExecutableShScript,
  makeInstallFixture,
  throwingExec,
  writePinnedFile,
} from "./fixtures/install-fixtures";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
const TEST_ROOT = path.join(PLUGIN_ROOT, ".tmp", "install-test");

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

/** 由 fixture 构造隔离配置（loadConfig 纯函数，无 FS 副作用）。 */
function cfgOf(fixture: { installDir: string; stateDir: string }): BridgeConfig {
  return loadConfig({ installDir: fixture.installDir, stateDir: fixture.stateDir }, {});
}

describe("BridgeError 结构化错误", () => {
  it("携带 code 与可选 remediation，且是 Error 实例", () => {
    const err = new BridgeError("BIN_MISSING_NO_BACKUP", "二进制缺失且备份无效", {
      remediation: "重新安装或从官方入口获取",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("BridgeError");
    expect(err.code).toBe("BIN_MISSING_NO_BACKUP");
    expect(err.remediation).toBe("重新安装或从官方入口获取");
    expect(err.message).toContain("二进制缺失且备份无效");
  });

  it("remediation 缺省为 undefined；cause 经 options 透传", () => {
    const cause = new Error("EACCES");
    const noRem = new BridgeError("FS_READ_FAILED", "读取失败", { cause });
    expect(noRem.remediation).toBeUndefined();
    expect((noRem as { cause?: unknown }).cause).toBe(cause);
  });
});

describe("probeInstall 五种 fixture 形态", () => {
  it("healthy：present=true、版本/哈希与钉版一致、备份有效、drift=false", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "healthy"), "healthy");
    const status = await probeInstall(cfgOf(fx), { exec: fx.exec });

    expect(status.path).toBe(fx.binPath);
    expect(status.present).toBe(true);
    expect(status.version).toBe(PINNED_VERSION);
    expect(status.sha256).toBe(fx.pinnedSha256);
    expect(status.backupPath).toBe(fx.backupPath);
    expect(status.backupValid).toBe(true);
    expect(status.autoupdateFlag).toBe(false);
    expect(status.pinState).toBe("consistent");
    expect(status.drift).toBe(false);
    expect(status.pinned).toEqual({ version: PINNED_VERSION, sha256: fx.pinnedSha256 });
    // --version 探测恰好一次，参数为 [二进制路径, "--version"]
    expect(fx.execCalls).toEqual([[fx.binPath, "--version"]]);
  });

  it("missing-with-valid-backup：present=false、backupValid=true（供 T1-04 repair 使用）；exec 零调用", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "missing"), "missing");
    const status = await probeInstall(cfgOf(fx), { exec: fx.exec });

    expect(status.present).toBe(false);
    expect(status.version).toBeUndefined();
    expect(status.sha256).toBeUndefined();
    expect(status.backupValid).toBe(true);
    expect(status.backupPath).toBe(fx.backupPath);
    // 二进制不在，哈希无从比对 → 与钉版记录不符（漂移含缺失，注释见 InstallStatus.drift）
    expect(status.pinState).toBe("drift");
    expect(status.drift).toBe(true);
    // 二进制缺失时绝不发起 --version 探测
    expect(fx.execCalls).toEqual([]);
  });

  it("only-delete（Review-Focus-1）：二进制缺失且无备份 → probe 返回状态而非抛错，backupValid=false", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "only-delete"), "only-delete");
    // 显式断言 resolves：结构性错误留给 T1-04 repair 分支，probe 本身绝不抛业务错
    const status = await probeInstall(cfgOf(fx), { exec: fx.exec });

    expect(status.present).toBe(false);
    expect(status.backupValid).toBe(false);
    expect(status.pinState).toBe("drift");
    expect(status.drift).toBe(true);
    expect(status.version).toBeUndefined();
    expect(fx.execCalls).toEqual([]);
  });

  it("bad-hash：内容哈希与钉版不符 → drift=true（版本输出正常，隔离哈希漂移路径）", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "bad-hash"), "bad-hash");
    const status = await probeInstall(cfgOf(fx), { exec: fx.exec });

    expect(status.present).toBe(true);
    expect(status.version).toBe(PINNED_VERSION); // 版本轴正常
    expect(status.sha256).not.toBe(fx.pinnedSha256); // 哈希轴漂移
    expect(status.pinState).toBe("drift");
    expect(status.drift).toBe(true);
  });

  it("bad-version：哈希与钉版一致、--version 输出不符 → drift=true（隔离版本漂移路径）", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "bad-version"), "bad-version");
    const status = await probeInstall(cfgOf(fx), { exec: fx.exec });

    expect(status.present).toBe(true);
    expect(status.version).toBe("99.99.99");
    expect(status.sha256).toBe(fx.pinnedSha256); // 哈希轴正常
    expect(status.pinState).toBe("drift");
    expect(status.drift).toBe(true);
  });

  it("钉版一致但 --version 不可执行（code=1）→ 版本未知不判漂移，哈希为准 → consistent；version=undefined 如实呈现", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "exec-fail"), "healthy");
    const exec = fakeExec({ code: 1, stdout: "", stderr: "boom" }, fx.execCalls);
    const status = await probeInstall(cfgOf(fx), { exec });

    expect(status.present).toBe(true);
    expect(status.version).toBeUndefined(); // R-d：exec 失败 → version=undefined（状态可见）
    expect(status.sha256).toBe(fx.pinnedSha256);
    expect(status.pinState).toBe("consistent");
    expect(status.drift).toBe(false);
  });

  it("exec 抛异常（spawn 层失败）→ 不抛出，version=undefined 状态呈现", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "exec-throw"), "healthy");
    const status = await probeInstall(cfgOf(fx), {
      exec: throwingExec(new Error("spawn EACCES")),
    });

    expect(status.present).toBe(true);
    expect(status.version).toBeUndefined();
    expect(status.drift).toBe(false); // 哈希与钉版一致，版本未知不判漂移
  });
});

describe("R-a 钉版状态显式化（未钉版 ≠ 已钉一致）", () => {
  it("unpinned：pinState=unpinned、drift=false 但 pinned=undefined——与 healthy 的 consistent 可区分", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "unpinned"), "unpinned");
    const status = await probeInstall(cfgOf(fx), { exec: fx.exec });

    expect(status.pinState).toBe("unpinned");
    expect(status.drift).toBe(false); // drift=false 不掩盖未钉版——区分看 pinState
    expect(status.pinned).toBeUndefined();
    expect(status.present).toBe(true);
    expect(status.version).toBe(PINNED_VERSION);
  });

  it("unpinned 且备份存在：无钉版时 backupValid 仅要求存在且非空（哈希无比对基准）", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "unpinned-bak"), "unpinned");
    const status = await probeInstall(cfgOf(fx), { exec: fx.exec });
    expect(status.backupValid).toBe(true);
  });
});

describe("R-c autoupdate 开关读取（<installDir>/../codearts_cli.json）", () => {
  it("autoupdate=true 时 status.autoupdateFlag=true 如实呈现", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "au-true"), "healthy");
    await writeFile(fx.cliPath, JSON.stringify({ autoupdate: true }), "utf8");
    const status = await probeInstall(cfgOf(fx), { exec: fx.exec });
    expect(status.autoupdateFlag).toBe(true);
  });

  it("文件缺失 → autoupdateFlag=undefined（显式未知，不抛错）", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "au-missing"), "healthy");
    await rm(fx.cliPath);
    const status = await probeInstall(cfgOf(fx), { exec: fx.exec });
    expect(status.autoupdateFlag).toBeUndefined();
  });

  it("JSON 键缺省（文件合法但无 autoupdate 键）→ undefined", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "au-nokey"), "healthy");
    await writeFile(fx.cliPath, JSON.stringify({ other: 1 }), "utf8");
    const status = await probeInstall(cfgOf(fx), { exec: fx.exec });
    expect(status.autoupdateFlag).toBeUndefined();
  });

  it("JSON 解析失败 → 抛 BridgeError(AUTOUPDATE_INVALID)，消息含路径", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "au-corrupt"), "healthy");
    await writeFile(fx.cliPath, "{ not json !!!", "utf8");
    const err: unknown = await probeInstall(cfgOf(fx), { exec: fx.exec }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as { code?: string }).code).toBe("AUTOUPDATE_INVALID");
    expect((err as Error).message).toContain(fx.cliPath);
  });

  it("autoupdate 字段类型非法（字符串）→ 抛错，不静默当 undefined", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "au-badtype"), "healthy");
    await writeFile(fx.cliPath, JSON.stringify({ autoupdate: "yes" }), "utf8");
    const err: unknown = await probeInstall(cfgOf(fx), { exec: fx.exec }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as { code?: string }).code).toBe("AUTOUPDATE_INVALID");
    expect((err as Error).message).toContain("autoupdate");
  });
});

describe("钉版记录 pinned.json 校验（自有格式，损坏显式报错）", () => {
  it("JSON 解析失败 → 抛 BridgeError(PINNED_INVALID)，消息含路径", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "pin-corrupt"), "healthy");
    await writeFile(path.join(fx.stateDir, "pinned.json"), "not-json{", "utf8");
    const err: unknown = await probeInstall(cfgOf(fx), { exec: fx.exec }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as { code?: string }).code).toBe("PINNED_INVALID");
    expect((err as Error).message).toContain("pinned.json");
  });

  it("schema 非法（sha256 非 64 位十六进制）→ 抛错", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "pin-badsha"), "healthy");
    await writeFile(
      path.join(fx.stateDir, "pinned.json"),
      JSON.stringify({ version: PINNED_VERSION, sha256: "deadbeef" }),
      "utf8",
    );
    await expect(probeInstall(cfgOf(fx), { exec: fx.exec })).rejects.toThrow(/sha256/);
  });

  it("schema 非法（含未知键）→ 抛错（防拼写错误静默丢字段）", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "pin-unknown-key"), "healthy");
    await writeFile(
      path.join(fx.stateDir, "pinned.json"),
      JSON.stringify({
        version: PINNED_VERSION,
        sha256: fx.pinnedSha256,
        versions: PINNED_VERSION, // 拼写错误的键
      }),
      "utf8",
    );
    await expect(probeInstall(cfgOf(fx), { exec: fx.exec })).rejects.toThrow(/versions/);
  });
});

describe("R-d FS 意外错误显式抛出（非 ENOENT）", () => {
  it("二进制路径存在但是目录 → 抛 BridgeError(FS_PATH_NOT_FILE)，消息含路径", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "bin-is-dir"), "missing");
    await rm(fx.binPath, { force: true }); // missing 形态本无二进制
    await mkdir(fx.binPath, { recursive: true }); // 换成目录：异常态，显式抛
    const err: unknown = await probeInstall(cfgOf(fx), { exec: fx.exec }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as { code?: string }).code).toBe("FS_PATH_NOT_FILE");
    expect((err as Error).message).toContain(fx.binPath);
  });

  it("备份路径存在但是目录 → 抛错（不静默当 backupValid=false）", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "bak-is-dir"), "missing");
    await rm(fx.backupPath, { force: true });
    await mkdir(fx.backupPath, { recursive: true });
    const err: unknown = await probeInstall(cfgOf(fx), { exec: fx.exec }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as { code?: string }).code).toBe("FS_PATH_NOT_FILE");
    expect((err as Error).message).toContain(fx.backupPath);
  });

  it("备份存在但为空文件（有钉版）→ backupValid=false（空备份无效，显式规则）", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "bak-empty"), "healthy");
    await writeFile(fx.backupPath, "", "utf8");
    const status = await probeInstall(cfgOf(fx), { exec: fx.exec });
    expect(status.backupValid).toBe(false);
    expect(status.drift).toBe(false); // 备份无效不改变钉版一致性判定（判定只看二进制）
  });

  it("备份存在但哈希与钉版不符 → backupValid=false（备份损坏，T1-04 repair 不得使用）", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "bak-corrupt"), "healthy");
    await writeFile(fx.backupPath, "corrupted backup bytes\n", "utf8");
    const status = await probeInstall(cfgOf(fx), { exec: fx.exec });
    expect(status.backupValid).toBe(false);
    expect(status.present).toBe(true); // 二进制本身仍健康
    expect(status.drift).toBe(false);
  });
});

describe("createNodeExec（默认 exec 原语；真实进程仅用 /bin/sh，绝不跑真 codearts）", () => {
  it("端到端：可执行 sh 脚本 fixture → probe 全链路 healthy", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "real-exec"), "healthy");
    await makeBinExecutableShScript(fx.binPath, PINNED_VERSION);
    // 脚本内容替换了 fixture 二进制 → 钉版记录按当前部署的真实哈希重写（钉版=当前期望）
    await writePinnedFile(fx.stateDir, {
      version: PINNED_VERSION,
      sha256: await sha256File(fx.binPath),
    });
    const status = await probeInstall(cfgOf(fx)); // 不注入 exec → 默认 createNodeExec
    expect(status.present).toBe(true);
    expect(status.version).toBe(PINNED_VERSION);
    expect(status.pinState).toBe("consistent");
  });

  it("端到端：二进制无执行权限（0644）→ 不抛错，version=undefined 状态呈现", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "real-noexec"), "healthy");
    // 覆写为同内容但无执行位的文件（无 x 位 → 即便 root 也 EACCES，确定性）：
    // 哈希仍与钉版一致 → 版本未知不判漂移；version=undefined 单独呈现 exec 失败
    await writeFile(fx.binPath, BIN_CONTENT, "utf8");
    await chmod(fx.binPath, 0o644);
    const status = await probeInstall(cfgOf(fx));
    expect(status.present).toBe(true);
    expect(status.version).toBeUndefined();
    expect(status.sha256).toBe(fx.pinnedSha256);
    expect(status.pinState).toBe("consistent");
    expect(status.drift).toBe(false);
  });

  it("超时（timeoutMs 可配）→ 抛 BridgeError(EXEC_TIMEOUT)，进程被强杀", async () => {
    const exec = createNodeExec({ timeoutMs: 200 });
    const err: unknown = await exec.run(["sh", "-c", "sleep 5"]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as { code?: string }).code).toBe("EXEC_TIMEOUT");
  });

  it("输出超限（maxOutputBytes 可配）→ 抛 BridgeError(EXEC_OUTPUT_OVERFLOW)", async () => {
    const exec = createNodeExec({ timeoutMs: 5000, maxOutputBytes: 8 });
    const err: unknown = await exec.run(["sh", "-c", "printf '0123456789abcdef'"]).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as { code?: string }).code).toBe("EXEC_OUTPUT_OVERFLOW");
  });

  it("stderr 溢出（stderr 输出超过 maxOutputBytes）→ 抛 BridgeError(EXEC_OUTPUT_OVERFLOW) 且进程被强制终止", async () => {
    const marker = path.join(TEST_ROOT, "stderr-overflow-marker");
    const exec = createNodeExec({ timeoutMs: 5000, maxOutputBytes: 8 });
    const err: unknown = await exec
      .run(["sh", "-c", `printf '0123456789abcdef' >&2; sleep 0.5; touch '${marker}'`])
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as { code?: string }).code).toBe("EXEC_OUTPUT_OVERFLOW");
    // 进程已被 SIGKILL：若未被终止，超限后的残留语句将在 ~0.5s 后写出标记文件；
    // 等待超过该窗口后确认标记不存在（旧实现失败形态：stderr 溢出被静默吞掉、进程善终）
    await new Promise((r) => setTimeout(r, 1200));
    expect(existsSync(marker)).toBe(false);
  });

  it("正常捕获 stdout 与退出码", async () => {
    const exec = createNodeExec({ timeoutMs: 5000 });
    const result = await exec.run(["sh", "-c", "printf '26.10.9'; exit 3"]);
    expect(result.code).toBe(3);
    expect(result.stdout).toBe("26.10.9");
  });
});

/* ───── T1-04：备份与自愈修复 ───── */

/** 读取审计文件（install.jsonl）为对象数组；空行跳过；供各断言复用。 */
async function readAuditLines(stateDir: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path.join(stateDir, "audit", "install.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const AUDIT_ID_RE = /^rep-\d+-[0-9a-f]{6,}$/;

describe("T1-04 repairInstall（备份恢复自愈）", () => {
  it("missing（.delete 残局但有有效备份）→ 从备份恢复成功：哈希+版本复验、auditId、审计行", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "repair-ok"), "missing");
    const result = await repairInstall(cfgOf(fx), fx.exec);

    // 返回契约（任务书 RepairResult）
    expect(result.action).toBe("restore-from-backup");
    expect(result.from).toBe(fx.backupPath); // R-fx4：显式记录所用备份文件名
    expect(result.to).toBe(fx.binPath);
    expect(result.sha256).toBe(fx.pinnedSha256);
    expect(result.auditId).toMatch(AUDIT_ID_RE);

    // 恢复后二进制内容与钉版一致、可执行探测通过（fake exec 输出 26.10.9）
    expect(await sha256File(fx.binPath)).toBe(fx.pinnedSha256);
    // exec 恰好两次：备份校验 --version + 部署后复验 --version
    expect(fx.execCalls).toEqual([
      [fx.backupPath, "--version"],
      [fx.binPath, "--version"],
    ]);

    // 审计（R-fx6）：<stateDir>/audit/install.jsonl 一条 kind=repair，字段齐全
    const lines = await readAuditLines(fx.stateDir);
    const entry = lines.find((l) => l["kind"] === "repair");
    expect(entry).toBeDefined();
    expect(entry?.["auditId"]).toBe(result.auditId);
    expect(entry?.["from"]).toBe(fx.backupPath);
    expect(entry?.["to"]).toBe(fx.binPath);
    expect(entry?.["sha256"]).toBe(fx.pinnedSha256);
    expect(typeof entry?.["ts"]).toBe("string");
  });

  it("修复后的安装经 probeInstall 复核为 consistent（恢复闭环）", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "repair-reprobe"), "missing");
    await repairInstall(cfgOf(fx), fx.exec);
    const status = await probeInstall(cfgOf(fx), { exec: fx.exec });
    expect(status.present).toBe(true);
    expect(status.pinState).toBe("consistent");
    expect(status.drift).toBe(false);
  });

  it("only-delete（无任何备份）→ BridgeError(BIN_MISSING_NO_BACKUP)，remediation 含 .delete 残留检查/官方重装/备份恢复指引/官方入口链接", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "repair-nobak"), "only-delete");
    const err: unknown = await repairInstall(cfgOf(fx), fx.exec).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BridgeError);
    const be = err as BridgeError;
    expect(be.code).toBe("BIN_MISSING_NO_BACKUP");
    expect(be.remediation).toBeDefined();
    // 真实事故背景四要素（任务书裁定 R-fx4）：.delete 残留 / 官方重装 / 备份恢复 / 官方入口
    expect(be.remediation).toContain("codearts.delete");
    expect(be.remediation).toContain("重装");
    expect(be.remediation).toContain("备份");
    expect(be.remediation).toContain("https://codearts.huaweicloud.com/portal/settings/cli-auth");
  });

  it("备份存在但哈希与钉版不符 → BridgeError(BACKUP_INVALID_HASH)，消息含备份路径", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "repair-badhash"), "missing");
    await writeFile(fx.backupPath, "corrupted backup bytes\n", "utf8");
    const err: unknown = await repairInstall(cfgOf(fx), fx.exec).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("BACKUP_INVALID_HASH");
    expect((err as Error).message).toContain(fx.backupPath);
  });

  it("恢复步骤 ②：期望版本名备份缺失、旧版本名备份有效 → 扫描发现并恢复，RepairResult.from 为扫描所得", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "repair-scan"), "healthy");
    await rm(fx.backupPath); // 摘掉期望版本名的备份（步骤①落空）
    const oldBackup = path.join(path.dirname(fx.binPath), "codearts.bak-26.10.8");
    await writeFile(oldBackup, BIN_CONTENT, "utf8"); // 旧版本名但内容哈希与钉版一致 → 有效
    const result = await repairInstall(cfgOf(fx), fx.exec);
    expect(result.from).toBe(oldBackup);
    expect(result.sha256).toBe(fx.pinnedSha256);
    expect(await sha256File(fx.binPath)).toBe(fx.pinnedSha256);
  });

  it("恢复后复验失败（版本探测不通过）→ BridgeError(REPAIR_VERIFY_FAILED)，不谎报成功", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "repair-verify"), "missing");
    // 脚本化 fake exec：第 1 次（备份校验 --version）通过，此后全部失败（部署后复验落入）
    const calls: string[][] = [];
    const exec: Exec = {
      run: async (cmd: string[]) => {
        calls.push(cmd);
        if (calls.length === 1) return { code: 0, stdout: `${PINNED_VERSION}\n`, stderr: "" };
        return { code: 1, stdout: "", stderr: "boom" };
      },
    };
    const err: unknown = await repairInstall(cfgOf(fx), exec).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("REPAIR_VERIFY_FAILED");
    expect(calls.length).toBe(2); // 校验一次 + 复验一次
  });

  it("Review-Focus-1：bin 目录只读 → 结构化 IO 错误（FS_WRITE_FAILED）含目标路径与 EACCES 原因", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "repair-ro"), "healthy");
    const binDir = path.dirname(fx.binPath);
    await chmod(binDir, 0o555); // 非 root（uid 1000）：写 tmp 必 EACCES
    try {
      const err: unknown = await repairInstall(cfgOf(fx), fx.exec).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(BridgeError);
      expect((err as BridgeError).code).toBe("FS_WRITE_FAILED");
      expect((err as Error).message).toContain(fx.binPath);
      expect((err as Error).message).toContain("EACCES");
    } finally {
      await chmod(binDir, 0o755); // 还原以便清理
    }
  });

  it("fixAutoupdate=true：autoupdate true 修正为 false，未知字段保留，审计含 before/after", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "repair-au"), "healthy");
    await writeFile(fx.cliPath, JSON.stringify({ autoupdate: true, unknownKeep: 42 }), "utf8");
    await repairInstall(cfgOf(fx), fx.exec, { fixAutoupdate: true });

    // 写回（R-fx5）：仅改 autoupdate 字段；2 空格缩进 + 末尾换行；未知字段原样保留
    const text = await readFile(fx.cliPath, "utf8");
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(parsed["autoupdate"]).toBe(false);
    expect(parsed["unknownKeep"]).toBe(42);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).toContain('\n  "unknownKeep"'); // 2 空格缩进格式

    // 审计含 before/after
    const lines = await readAuditLines(fx.stateDir);
    const entry = lines.find((l) => l["kind"] === "fix-autoupdate");
    expect(entry).toBeDefined();
    expect(entry?.["before"]).toBe(true);
    expect(entry?.["after"]).toBe(false);
  });

  it("fixAutoupdate=true 但 codearts_cli.json 损坏 → BridgeError(AUTOUPDATE_INVALID) 且文件一个字节都不动", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "repair-au-corrupt"), "healthy");
    const broken = "{ not json !!!";
    await writeFile(fx.cliPath, broken, "utf8");
    const err: unknown = await repairInstall(cfgOf(fx), fx.exec, { fixAutoupdate: true }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("AUTOUPDATE_INVALID");
    expect(await readFile(fx.cliPath, "utf8")).toBe(broken); // 不触碰文件
  });

  it("fixAutoupdate 缺省（undefined）→ 不执行修正动作（显式开关默认不执行，裁定 R-fx5）", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "repair-au-default"), "healthy");
    await writeFile(fx.cliPath, JSON.stringify({ autoupdate: true }), "utf8");
    await repairInstall(cfgOf(fx), fx.exec);
    const parsed = JSON.parse(await readFile(fx.cliPath, "utf8")) as Record<string, unknown>;
    expect(parsed["autoupdate"]).toBe(true); // 未显式开启 → 原值不动
    const lines = await readAuditLines(fx.stateDir);
    expect(lines.find((l) => l["kind"] === "fix-autoupdate")).toBeUndefined();
  });
});

describe("T1-04 ensureBackup（备份是派生物，可安全刷新）", () => {
  it("备份缺失 → 从当前有效二进制 copyDeploy 刷新 codearts.bak-<版本> + 审计 refreshed", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "bak-refresh"), "healthy");
    await rm(fx.backupPath); // 制造"备份缺失"
    await ensureBackupOf(fx);
    // 备份已补齐：内容与二进制一致、mode 0755
    expect(await sha256File(fx.backupPath)).toBe(fx.pinnedSha256);
    expect(((await stat(fx.backupPath)).mode) & 0o777).toBe(0o755);
    const lines = await readAuditLines(fx.stateDir);
    const entry = lines.find((l) => l["kind"] === "ensure-backup");
    expect(entry).toBeDefined();
    expect(entry?.["result"]).toBe("refreshed");
    expect(entry?.["from"]).toBe(fx.binPath);
    expect(entry?.["to"]).toBe(fx.backupPath);
    expect(entry?.["sha256"]).toBe(fx.pinnedSha256);
  });

  it("备份已有效 → 不重写（mtime 不变）+ 审计 up-to-date", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "bak-uptodate"), "healthy");
    const before = await stat(fx.backupPath);
    await ensureBackupOf(fx);
    const after = await stat(fx.backupPath);
    expect(after.mtimeMs).toBe(before.mtimeMs); // 未重写
    const lines = await readAuditLines(fx.stateDir);
    const entry = lines.find((l) => l["kind"] === "ensure-backup");
    expect(entry?.["result"]).toBe("up-to-date");
  });

  it("二进制缺失 → BridgeError(BACKUP_SOURCE_INVALID)：无有效备份源，显式报错不静默（裁定 R-fx3）", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "bak-nobin"), "missing");
    const err: unknown = await ensureBackupOf(fx).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("BACKUP_SOURCE_INVALID");
    expect((err as Error).message).toContain(fx.binPath);
  });

  it("二进制哈希与钉版漂移 → 拒绝把漂移内容固化为备份（BACKUP_SOURCE_INVALID）", async () => {
    const fx = await makeInstallFixture(path.join(TEST_ROOT, "bak-drift"), "bad-hash");
    const err: unknown = await ensureBackupOf(fx).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BridgeError);
    expect((err as BridgeError).code).toBe("BACKUP_SOURCE_INVALID");
    expect((err as Error).message).toContain("sha256");
  });

  /** ensureBackup 便捷封装（被测函数签名：cfg + exec）。 */
  function ensureBackupOf(fx: { installDir: string; stateDir: string; exec: Exec }): Promise<void> {
    return ensureBackup(cfgOf(fx), fx.exec);
  }
});
