/**
 * T1-03 安装状态探测 fixtures（任务书五种形态 + R-a 未钉版形态）。
 *
 * 纪律（主控裁定 R-e）：
 * - 测试绝不真跑 codearts 二进制（exec 全部注入 fake；真实 exec 测试只用 /bin/sh 脚本）；
 * - 测试绝不触碰真实 HOME：所有 FS 落点由调用方传入的 root 目录派生
 *   （约定在插件 .tmp/install-test/ 之下，afterAll 清理）；
 * - 目录布局模拟真实环境（背景说明）：
 *     <root>/installers/bin/codearts            二进制
 *     <root>/installers/bin/codearts.bak-<ver>  备份（codearts.bak-<version> 命名契约）
 *     <root>/installers/bin/codearts.delete     升级中断残留（only-delete 形态）
 *     <root>/state/pinned.json                  钉版记录
 *     <root>/codearts_cli.json                  autoupdate 开关（<installDir>/../codearts_cli.json）
 */
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { sha256File } from "../../src/core/fsx";
import type { Exec } from "../../src/core/install";

/** 钉版基准版本（真实环境参考值，形如 26.10.9）。 */
export const PINNED_VERSION = "26.10.9";

/** 基准二进制内容（确定字节串，哈希可复现；仅为探针 fixture，绝非真二进制）。 */
export const BIN_CONTENT = "fake codearts binary payload v26.10.9\n";

/** 漂移内容（bad-hash 形态：与钉版内容不同 → 哈希漂移）。 */
export const DRIFT_CONTENT = "fake codearts binary payload v99.0.0 (drifted)\n";

/** fixture 形态（任务书五类 + R-a 未钉版）。 */
export type InstallFixtureKind =
  | "healthy" // 二进制在、哈希/版本与钉版一致、备份有效
  | "missing" // 二进制缺失、备份有效（供 T1-04 repair 使用）
  | "only-delete" // 二进制缺失只剩 codearts.delete、无备份（Review-Focus-1）
  | "bad-hash" // 二进制内容哈希与钉版不符（版本输出正常——隔离哈希漂移路径）
  | "bad-version" // 内容哈希与钉版一致、--version 输出不符（隔离版本漂移路径）
  | "unpinned"; // 无钉版记录（R-a：未钉版必须与"已钉一致"可区分）

/** fixture 产物（测试据此构造 BridgeConfig 与断言）。 */
export interface InstallFixture {
  root: string;
  installDir: string;
  stateDir: string;
  binPath: string;
  backupPath: string;
  /** codearts_cli.json 绝对路径（autoupdate 开关载体）。 */
  cliPath: string;
  /** 钉版内容（BIN_CONTENT）的 sha256（写入 pinned.json 的期望值）。 */
  pinnedSha256: string;
  /** 注入 probeInstall 的 fake exec。 */
  exec: Exec;
  /** fake exec 收到的命令记录（断言调用参数/次数）。 */
  execCalls: string[][];
}

/** 构造 fake exec：返回固定结果并记录每次调用（绝不执行任何真实进程）。 */
export function fakeExec(
  result: { stdout?: string; stderr?: string; code?: number },
  calls: string[][],
): Exec {
  return {
    run: async (cmd: string[]) => {
      calls.push(cmd);
      return { code: result.code ?? 0, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
  };
}

/** 抛异常的 fake exec（模拟 spawn 层失败：进程起不来）。 */
export function throwingExec(error: Error): Exec {
  return { run: async () => Promise.reject(error) };
}

/**
 * 搭建 fixture 目录并按 kind 填充。
 * pinned.json 期望哈希统一从 .expected-content 暂存文件经 sha256File 计算（复用唯一哈希实现，禁止第二实现）。
 */
export async function makeInstallFixture(root: string, kind: InstallFixtureKind): Promise<InstallFixture> {
  const installDir = path.join(root, "installers");
  const stateDir = path.join(root, "state");
  const binDir = path.join(installDir, "bin");
  const binPath = path.join(binDir, "codearts");
  const backupPath = path.join(binDir, `codearts.bak-${PINNED_VERSION}`);
  const cliPath = path.join(root, "codearts_cli.json");
  const execCalls: string[][] = [];

  await mkdir(binDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  // 钉版哈希：经唯一实现 sha256File 从暂存文件计算，随后即删
  const refPath = path.join(root, ".expected-content");
  await writeFile(refPath, BIN_CONTENT, "utf8");
  const pinnedSha256 = await sha256File(refPath);
  await rm(refPath);

  // 按形态布置 binDir 文件
  switch (kind) {
    case "healthy":
    case "bad-version":
    case "unpinned":
      await writeFile(binPath, BIN_CONTENT, "utf8");
      await writeFile(backupPath, BIN_CONTENT, "utf8");
      break;
    case "missing":
      await writeFile(backupPath, BIN_CONTENT, "utf8");
      break;
    case "only-delete":
      // 升级中断残留：只剩 codearts.delete，无二进制、无备份
      await writeFile(path.join(binDir, "codearts.delete"), BIN_CONTENT, "utf8");
      break;
    case "bad-hash":
      await writeFile(binPath, DRIFT_CONTENT, "utf8");
      await writeFile(backupPath, BIN_CONTENT, "utf8");
      break;
  }

  // 钉版记录（unpinned 形态不写）
  if (kind !== "unpinned") {
    await writePinnedFile(stateDir, { version: PINNED_VERSION, sha256: pinnedSha256 });
  }

  // autoupdate 开关（默认 false；个别测试自行覆写/删除）
  await writeFile(cliPath, JSON.stringify({ autoupdate: false }), "utf8");

  // fake exec：--version 输出按形态给定（missing/only-delete 不会被调用）。
  // 输出契约（R-d）：版本串位于行首（probe 按 /^\d+\.\d+\.\d+/m 行首解析）
  const versionOutput = kind === "bad-version" ? "99.99.99\n" : `${PINNED_VERSION}\n`;
  const exec = fakeExec({ stdout: versionOutput }, execCalls);

  return { root, installDir, stateDir, binPath, backupPath, cliPath, pinnedSha256, exec, execCalls };
}

/** 写 pinned.json（fixtures 与测试共用；格式契约：{"version": string, "sha256": string}）。 */
export async function writePinnedFile(
  stateDir: string,
  record: { version: string; sha256: string },
): Promise<void> {
  await mkdir(stateDir, { recursive: true });
  await writeFile(path.join(stateDir, "pinned.json"), JSON.stringify(record), "utf8");
}

/** 把 fixture 二进制变为可执行 shell 脚本（仅真实 exec 端到端测试使用；不跑真 codearts）。 */
export async function makeBinExecutableShScript(binPath: string, versionOutput: string): Promise<void> {
  // 脚本文件内为字面 \n（sh 的 printf 负责转义为换行），故模板串写 \\n
  await writeFile(binPath, `#!/bin/sh\nprintf '${versionOutput}\\n'\n`, "utf8");
  await chmod(binPath, 0o755);
}
