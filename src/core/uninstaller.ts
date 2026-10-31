/**
 * codearts-bridge uninstall 卸载（T4-05）。
 *
 * 职责：一键卸载 bridge 对用户环境的全部接线，默认**保留用户数据**：
 * - 移除 opencode 自动加载入口 ~/.config/opencode/plugins/codearts-bridge.ts
 *  （先备份 .bak-<时间戳> 再删——与 install.sh 写入对称，误卸载可手工还原）；
 * - 卸载 systemd 三单元（经注入 serviceUninstall——cli.ts 的 serviceUninstallCommand，
 *   core 层不反向依赖 cli；systemctl 不可用时显式留痕并**保留单元文件**——禁静默）；
 * - 默认保留 ~/.codearts-bridge 状态目录与 codearts CLI 安装（后者根本不在
 *   卸载范围——它是独立产品，bridge 只是管家）；--purge 才清状态目录。
 *
 * 确认语义（任务书 §E）：交互终端下先确认（默认 N，拒绝即零改动退出码 1）；
 * 非交互（管道/CI）必须显式 --yes，否则 UNINSTALL_CONFIRM_REQUIRED 拒绝——
 * 卸载是破坏性动作，静默执行违背仓库铁律。
 *
 * 可测试性：exec/homeDir/unitDir/isTTY/confirm/nowMs/serviceUninstall 全部注入；
 * FS 落点由注入 homeDir 派生，测试绝不触碰真实 HOME、绝不真调 systemctl。
 */
import { copyFile, rm, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { loadConfig } from "./config";
import type { BridgeConfig } from "./config";
import { BridgeError } from "./errors";
import { createNodeExec, statOrEnoent } from "./install";
import type { Exec } from "./install";
import { SERVICE_UNIT_NAMES } from "./service";

/* ───── 常量 ───── */

/** opencode 自动加载入口文件相对路径（与 install.sh 写入目标一致）。 */
export const UNINSTALL_AUTOLOAD_REL = path.join(".config", "opencode", "plugins", "codearts-bridge.ts");

/** purge 目标最小深度守卫：stateDir 至少为 <root>/<seg> 两段（拒绝根与一级目录）。 */
const PURGE_MIN_SEGMENTS = 2;

/* ───── 依赖注入 ───── */

/** systemd 单元卸载实现形态（= cli.ts serviceUninstallCommand 的签名子集）。 */
export type ServiceUninstallFn = (
  cfg: BridgeConfig,
  deps: { exec: Exec; unitDir: string },
) => Promise<number>;

export interface UninstallDeps {
  /** systemctl 可用性探测与 serviceUninstall 执行（缺省 createNodeExec）。 */
  exec?: Exec;
  /** HOME 锚点（autoload 与 systemd user 单元目录派生；缺省 os.homedir()）。 */
  homeDir?: string;
  /** systemd user 单元目录（缺省 <homeDir>/.config/systemd/user）。 */
  unitDir?: string;
  /** 交互终端标记（缺省 process.stdin.isTTY === true）。 */
  isTTY?: boolean;
  /** 确认函数（缺省 readline 询问 y/N；测试注入确定性答案）。 */
  confirm?: (question: string) => Promise<boolean>;
  /** 时间戳源（备份文件名；缺省 Date.now）。 */
  nowMs?: () => number;
  /** systemd 卸载实现（cli.ts 注入 serviceUninstallCommand；缺省未注入遇单元在场时显式报错）。 */
  serviceUninstall?: ServiceUninstallFn;
}

export interface UninstallOptions {
  /** 跳过确认（非交互环境必需）。 */
  yes?: boolean;
  /** 连状态目录一并清除（默认保留）。 */
  purge?: boolean;
}

/* ───── 内部步骤 ───── */

/** 步骤 1：autoload 入口先备份后删；不在场 → null（跳过）。 */
async function removeAutoload(homeDir: string, nowMs: () => number): Promise<{ removed: string; backup?: string } | null> {
  const target = path.join(homeDir, UNINSTALL_AUTOLOAD_REL);
  const st = await statOrEnoent(target);
  if (st === undefined) return null;
  if (!st.isFile()) {
    throw new BridgeError("UNINSTALL_AUTOLOAD_INVALID", `自动加载入口不是常规文件，拒绝删除：path=${target}`);
  }
  const backup = `${target}.bak-${new Date(nowMs()).toISOString().replace(/[:.]/g, "-")}`;
  await copyFile(target, backup);
  await unlink(target);
  return { removed: target, backup };
}

/** 步骤 2 前置：systemctl 是否可执行（spawn 成功即视为可用）。 */
async function systemctlAvailable(exec: Exec): Promise<boolean> {
  try {
    await exec.run(["systemctl", "--user", "--version"]);
    return true;
  } catch {
    return false;
  }
}

/** 步骤 3 守卫：purge 目标合法性（禁 HOME/根/过浅路径——rm -rf 的最后防线）。 */
function assertPurgeable(stateDir: string, homeDir: string): void {
  const resolved = path.resolve(stateDir);
  const homeResolved = path.resolve(homeDir);
  if (resolved === homeResolved || resolved === path.parse(resolved).root) {
    throw new BridgeError(
      "PURGE_TARGET_INVALID",
      `--purge 目标非法（拒绝清除 HOME 或文件系统根）：stateDir=${stateDir}`,
      { remediation: "核查 CODEARTS_BRIDGE_STATE_DIR 配置；正常状态根形如 ~/.codearts-bridge" },
    );
  }
  const rel = path.relative(path.parse(resolved).root, resolved);
  if (rel.split(path.sep).filter((s) => s.length > 0).length < PURGE_MIN_SEGMENTS) {
    throw new BridgeError(
      "PURGE_TARGET_INVALID",
      `--purge 目标路径过浅（守卫要求至少 ${PURGE_MIN_SEGMENTS} 层目录）：stateDir=${stateDir}`,
    );
  }
}

/** 缺省确认：readline y/N（大小写不敏感；其余一律视为拒绝）。 */
async function defaultConfirm(question: string): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/* ───── uninstallCommand ───── */

/**
 * 卸载命令（返回退出码）。输出逐步骤人类可读行；破坏性动作前有确认门。
 * - rc 0 = 卸载完成（含"无物可卸"的幂等形态）；
 * - rc 1 = 用户拒绝确认 / 结构化错误（UNINSTALL_CONFIRM_REQUIRED、
 *   PURGE_TARGET_INVALID、UNINSTALL_AUTOLOAD_INVALID 等，经 stderr JSON 输出）。
 */
export async function uninstallCommand(
  cfg: BridgeConfig = loadConfig(),
  deps: UninstallDeps = {},
  opts: UninstallOptions = {},
): Promise<number> {
  const homeDir = deps.homeDir ?? homedir();
  const unitDir = deps.unitDir ?? path.join(homeDir, ".config", "systemd", "user");
  const nowMs = deps.nowMs ?? Date.now;
  const printError = (code: string, message: string): void => {
    console.error(JSON.stringify({ error: { code, message } }, null, 2));
  };

  // 0) 确认门：非交互必须 --yes；交互默认 N（拒绝=零改动退出 1）
  if (opts.yes !== true) {
    const interactive = deps.isTTY ?? process.stdin.isTTY === true;
    if (!interactive) {
      printError(
        "UNINSTALL_CONFIRM_REQUIRED",
        "非交互环境下卸载必须显式 --yes 确认（破坏性动作禁止静默执行）",
      );
      return 1;
    }
    const confirmed = await (deps.confirm ?? defaultConfirm)(
      "确认卸载 codearts-bridge？（状态数据与 codearts CLI 将保留；--purge 才清状态目录）",
    );
    if (!confirmed) {
      console.log("已取消（未做任何变更）");
      return 1;
    }
  }

  console.log("[codearts-bridge uninstall] 开始卸载");

  // 1) opencode 自动加载入口（先备份后删）
  try {
    const removed = await removeAutoload(homeDir, nowMs);
    if (removed === null) {
      console.log(`· opencode 自动加载入口不在场，跳过：${path.join(homeDir, UNINSTALL_AUTOLOAD_REL)}`);
    } else {
      console.log(`✓ 已移除 opencode 自动加载入口：${removed.removed}（备份：${removed.backup}）`);
    }
  } catch (e) {
    printError(
      e instanceof BridgeError ? e.code : "UNINSTALL_FAILED",
      e instanceof Error ? e.message : String(e),
    );
    return 1;
  }

  // 2) systemd 三单元（经注入 serviceUninstall；systemctl 缺失 → 显式留痕保留文件）
  const allNames = [SERVICE_UNIT_NAMES.daemon, SERVICE_UNIT_NAMES.watchdogService, SERVICE_UNIT_NAMES.watchdogTimer];
  const present: string[] = [];
  for (const name of allNames) {
    if ((await statOrEnoent(path.join(unitDir, name))) !== undefined) present.push(name);
  }
  if (present.length === 0) {
    console.log(`· systemd 单元不在场，跳过：${unitDir}`);
  } else {
    const exec = deps.exec ?? createNodeExec();
    if (!(await systemctlAvailable(exec))) {
      console.log(
        `⚠ systemctl 不可用（非 systemd 环境）：${present.length} 个单元文件保留，请手工删除：${unitDir}`,
      );
    } else if (deps.serviceUninstall === undefined) {
      throw new BridgeError(
        "UNINSTALL_SERVICE_DEPS_MISSING",
        "systemd 单元在场但未注入卸载实现（编程缺陷，拒绝半卸载）",
        { remediation: "经 CLI 入口调用（cli.ts 注入 serviceUninstallCommand），勿直调核心层" },
      );
    } else {
      console.log("… 正在卸载 systemd 单元（disable --now + 删自家单元 + daemon-reload）");
      const rc = await deps.serviceUninstall(cfg, { exec, unitDir });
      if (rc !== 0) {
        console.log(`⚠ systemd 单元卸载未完全成功（rc=${rc}），详见上方结构化输出；继续后续步骤`);
      } else {
        console.log(`✓ systemd 单元已卸载：${present.join("、")}`);
      }
    }
  }

  // 3) 状态目录：默认保留；--purge 才清（守卫后删）
  if (opts.purge === true) {
    try {
      assertPurgeable(cfg.stateDir, homeDir);
      await rm(cfg.stateDir, { recursive: true, force: true });
      console.log(`✓ 已清除状态目录（--purge）：${cfg.stateDir}`);
    } catch (e) {
      printError(
        e instanceof BridgeError ? e.code : "UNINSTALL_FAILED",
        e instanceof Error ? e.message : String(e),
      );
      return 1;
    }
  } else {
    console.log(`· 保留状态目录（数据与审计台账）：${cfg.stateDir}（--purge 才清除）`);
  }
  console.log("· 保留 codearts CLI 安装（独立产品，不在卸载范围）");
  console.log("[codearts-bridge uninstall] 卸载完成");
  return 0;
}
