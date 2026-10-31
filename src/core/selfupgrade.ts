/**
 * codearts-bridge self-upgrade 自升级（T4-05，安全通道）。
 *
 * 职责：把 bridge 自身的升级做成"失败零损坏"的受控流程——本包即 git 检出，
 * 升级 = 同仓库内的 `git reset --hard origin/<branch>`（同一工作树内 rename，
 * 无跨设备问题），配以门禁与守护重启，失败自动回滚到备份提交。
 *
 * 流程（任务书 T4-05 §C）：
 *   0. 前置：仓库形态核验（.git 在场）+ 脏工作树拒绝（reset --hard 会丢弃
 *      未提交改动，零损坏纪律要求先显式拒绝而非静默覆盖）；
 *   1. `git fetch origin`；
 *   2. 比较 HEAD 与 origin/<branch>（缺省 main）→ 一致 → up-to-date 零写入退出；
 *   3. 备份当前提交号到 <stateDir>/self-upgrade-backup.json（原子写）；
 *   4. `git reset --hard origin/<branch>`；
 *   5. bun.lock 内容变更 → `bun install`；
 *   6. 质量门：typecheck（默认跑，可 --skip-typecheck）+ `bun test`（可 --skip-tests）；
 *   7. 守护在运行（<stateDir>/daemon.pid + pid 存活）→ `systemctl --user restart
 *      codearts-bridge` → 轮询 /health 直至 ok（有限次，间隔可注入）；
 *   8. 成功 → 返回 updated 结果；
 *      任何一步失败（步骤 4 之后）→ `git reset --hard <备份提交>` 回滚 + 守护
 *      曾活跃则再次重启 + 显式抛原始错误（回滚失败 → SELF_UPGRADE_ROLLBACK_FAILED，
 *      备份记录保留供人工恢复）。
 *
 * 零损坏矩阵：
 * - fetch/比较/脏树拒绝阶段失败：工作树从未被改动，零损坏；
 * - reset 后任何门失败：工作树回到备份提交（reset --hard 在干净树上幂等）；
 * - 回滚 reset 自身失败：备份记录（提交号）保留于 stateDir，错误消息携带
 *   人工恢复命令——绝不静默吞掉回滚失败。
 *
 * 可测试性：git/bun/systemctl 全部经注入 Exec（测试用脚本化 fake，绝不真跑）；
 * /health 轮询经注入 fetch 与 sleep；pid 存活性经注入 pidAlive。生产缺省
 * Exec 采用长超时（门禁 bun test 全量可达数十秒）与大输出上限。
 */
import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "./config";
import type { BridgeConfig } from "./config";
import { BridgeError } from "./errors";
import { atomicWriteFile, errnoOf } from "./fsx";
import type { Exec, ExecResult } from "./install";
import { SERVICE_UNIT_NAMES } from "./service";

/* ───── 常量（单一出口，cli.ts 与测试共用） ───── */

/** 升级目标分支（任务书固定 origin/main）。 */
export const SELF_UPGRADE_BRANCH = "main";

/** 备份记录文件名（位于状态根）。 */
export const SELF_UPGRADE_BACKUP_FILE = "self-upgrade-backup.json";

/** daemon.pid 文件名（与 daemon.ts PID_FILE_NAME 同源；该常量未导出，避免 core→src 反向依赖）。 */
const PID_FILE_NAME = "daemon.pid";

/** /health 轮询参数：systemd restart 后守护就绪通常秒级；15s×1s 覆盖慢启动。 */
export const SELF_UPGRADE_HEALTH_ATTEMPTS = 15;
export const SELF_UPGRADE_HEALTH_INTERVAL_MS = 1_000;
export const SELF_UPGRADE_HEALTH_TIMEOUT_MS = 3_000;

/** 生产缺省 Exec 参数：门禁（bun test 全量）可达数十秒，输出含测试报告。 */
export const SELF_UPGRADE_GATE_TIMEOUT_MS = 600_000;
export const SELF_UPGRADE_GATE_MAX_OUTPUT_BYTES = 8 << 20; // 8 MiB

/** 与 cli.ts FetchLike 同形（core 不反向依赖 cli；M78 双份同码先例）。 */
export type FetchLike = (url: URL | string, init?: RequestInit) => Promise<Response>;

/* ───── 结果模型 ───── */

/** 备份记录（<stateDir>/self-upgrade-backup.json 内容；升级成功后保留供追溯）。 */
export interface SelfUpgradeBackupRecord {
  ts: string;
  /** 升级前提交号（回滚目标）。 */
  backupCommit: string;
  /** 升级目标提交号。 */
  targetCommit: string;
  branch: string;
}

export type SelfUpgradeResult =
  | { action: "up-to-date"; commit: string; branch: string }
  | {
      action: "updated";
      from: string;
      to: string;
      /** 守护是否经历了重启+健康验证（未运行则 false，跳过重启）。 */
      daemonRestarted: boolean;
      /** 本轮是否真的跑了 bun test（--skip-tests 时 false，如实入账）。 */
      testsRan: boolean;
    };

/* ───── 依赖注入 ───── */

export interface SelfUpgradeDeps {
  /** git/bun/systemctl 执行抽象（测试注入脚本化 fake；生产 createNodeExec 长超时）。 */
  exec: Exec;
  /** /health 轮询（缺省全局 fetch）。 */
  fetchImpl?: FetchLike;
  /** 仓库根（缺省 = 本包根，即 src/core 的上两级）。 */
  repoRoot?: string;
  /** pid 存活性（缺省 process.kill(pid,0)，EPERM 视为存活）。 */
  pidAlive?: (pid: number) => boolean;
  /** 轮询间隔睡眠（缺省真实 setTimeout；测试注入立即返回）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 时钟（备份记录 ts；缺省 Date.now）。 */
  nowMs?: () => number;
}

export interface SelfUpgradeOptions {
  /** 跳过 bun test 快速门（任务书 --skip-tests）。 */
  skipTests?: boolean;
  /** 跳过 typecheck（默认执行；显式跳过属高级选项）。 */
  skipTypecheck?: boolean;
}

/* ───── 内部原语 ───── */

/** 生产缺省仓库根：src/core/selfupgrade.ts → 上两级 = 包根。 */
function defaultRepoRoot(): string {
  return path.resolve(import.meta.dir, "..", "..");
}

/** git -C <repoRoot> 执行；非零退出码或 spawn 失败 → BridgeError(code, 附 stderr 摘要)。 */
async function execGit(
  exec: Exec,
  repoRoot: string,
  args: string[],
  code: string,
  message: string,
): Promise<ExecResult> {
  let result: ExecResult;
  try {
    result = await exec.run(["git", "-C", repoRoot, ...args]);
  } catch (e) {
    throw new BridgeError(code, `${message}：git 执行失败：${e instanceof Error ? e.message : String(e)}`, {
      cause: e,
    });
  }
  if (result.code !== 0) {
    const stderr = result.stderr.trim().slice(0, 400);
    throw new BridgeError(code, `${message}：git ${args.join(" ")} 退出码 ${result.code}${stderr ? `：${stderr}` : ""}`);
  }
  return result;
}

/** 读文本；ENOENT → undefined；其他错误原样上抛（由调用方归一）。 */
async function readTextOrEnoent(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (e) {
    if (errnoOf(e) === "ENOENT") return undefined;
    throw e;
  }
}

/** 缺省 pid 存活判定：kill(pid,0)；ESRCH=死；EPERM=在但属他人（存活）。 */
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errnoOf(e) === "EPERM";
  }
}

const sleepDefault = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 单次 /health 探测：只认 2xx + ok:true；一切失败 false。 */
async function probeHealthOnce(fetchImpl: FetchLike, daemonUrl: string): Promise<boolean> {
  try {
    const res = await fetchImpl(new URL("/health", daemonUrl), {
      signal: AbortSignal.timeout(SELF_UPGRADE_HEALTH_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as Record<string, unknown>;
    return body["ok"] === true;
  } catch {
    return false;
  }
}

/* ───── selfUpgrade 主流程 ───── */

/**
 * 自升级受控流程（语义见文件头注）。
 *
 * 失败码：
 * - SELF_UPGRADE_NOT_GIT_REPO / SELF_UPGRADE_DIRTY_TREE（零改动前置拒绝）
 * - GIT_FETCH_FAILED / GIT_REV_FAILED / GIT_REF_MISSING（比较阶段，零改动）
 * - BACKUP_WRITE_FAILED（备份原子写失败，工作树未动）
 * - GIT_RESET_FAILED（reset 失败：工作树未变，无需回滚）
 * - BUN_INSTALL_FAILED / TYPECHECK_FAILED / TESTS_FAILED（门失败 → 回滚）
 * - SELF_UPGRADE_PIDFILE_INVALID（pidfile 损坏：禁猜，不重启守护；门已过 → 回滚）
 * - DAEMON_RESTART_FAILED / DAEMON_HEALTH_FAILED（重启/健康失败 → 回滚）
 * - SELF_UPGRADE_ROLLBACK_FAILED（回滚 reset 失败：备份记录保留，附人工恢复指引）
 */
export async function selfUpgrade(
  cfg: BridgeConfig = loadConfig(),
  deps: SelfUpgradeDeps,
  opts: SelfUpgradeOptions = {},
): Promise<SelfUpgradeResult> {
  const repoRoot = deps.repoRoot ?? defaultRepoRoot();
  const branch = SELF_UPGRADE_BRANCH;
  const exec = deps.exec;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? sleepDefault;
  const pidAlive = deps.pidAlive ?? defaultPidAlive;
  const nowMs = deps.nowMs ?? Date.now;

  // 0) 仓库形态核验：.git 在场（worktree 中 .git 为指针文件，stat 即可）
  const gitStat = await stat(path.join(repoRoot, ".git")).catch((e: unknown) => {
    if (errnoOf(e) === "ENOENT") return undefined;
    throw new BridgeError("SELF_UPGRADE_NOT_GIT_REPO", `仓库形态核验失败：path=${repoRoot}`, { cause: e });
  });
  if (gitStat === undefined) {
    throw new BridgeError(
      "SELF_UPGRADE_NOT_GIT_REPO",
      `self-upgrade 要求 git 检出形态：${repoRoot} 下无 .git`,
      { remediation: "本命令只支持 git 检出（install.sh 的安装形态）；发布包/只读目录请重新 clone 后升级" },
    );
  }

  // 1) fetch
  await execGit(exec, repoRoot, ["fetch", "origin"], "GIT_FETCH_FAILED", "git fetch 失败（网络/远端不可达）");

  // 2) 比较 HEAD 与 origin/<branch>
  const headRev = await execGit(exec, repoRoot, ["rev-parse", "HEAD"], "GIT_REV_FAILED", "无法解析 HEAD 提交号");
  const headSha = headRev.stdout.trim();
  if (headSha.length === 0) {
    throw new BridgeError("GIT_REV_FAILED", "git rev-parse HEAD 输出为空");
  }
  const remoteRev = await execGit(
    exec,
    repoRoot,
    ["rev-parse", `origin/${branch}`],
    "GIT_REF_MISSING",
    `无法解析 origin/${branch}（分支不存在或未 fetch）`,
  );
  const remoteSha = remoteRev.stdout.trim();
  if (remoteSha.length === 0) {
    throw new BridgeError("GIT_REF_MISSING", `git rev-parse origin/${branch} 输出为空`);
  }
  if (headSha === remoteSha) {
    return { action: "up-to-date", commit: headSha, branch };
  }

  // 3) 脏工作树拒绝（reset --hard 不可逆丢弃未提交改动——零损坏要求先显式拒绝）
  const statusOut = await execGit(exec, repoRoot, ["status", "--porcelain"], "GIT_STATUS_FAILED", "git status 失败");
  if (statusOut.stdout.trim().length > 0) {
    throw new BridgeError(
      "SELF_UPGRADE_DIRTY_TREE",
      `工作树存在未提交改动，拒绝 reset --hard（改动会被不可逆丢弃）：repo=${repoRoot}`,
      {
        remediation:
          "先提交或 stash 本地改动后重试；如需放弃改动请显式执行 git -C <repo> checkout -- . 并承担后果",
      },
    );
  }

  // 4) 备份当前提交号（原子写；先于任何破坏性动作）
  const backupFile = path.join(cfg.stateDir, SELF_UPGRADE_BACKUP_FILE);
  const record: SelfUpgradeBackupRecord = {
    ts: new Date(nowMs()).toISOString(),
    backupCommit: headSha,
    targetCommit: remoteSha,
    branch,
  };
  try {
    await atomicWriteFile(backupFile, `${JSON.stringify(record, null, 2)}\n`, 0o644);
  } catch (e) {
    throw new BridgeError("BACKUP_WRITE_FAILED", `备份记录写入失败：path=${backupFile}`, { cause: e });
  }

  // 5) 锁基线（reset 可能带来 bun.lock 变更）
  const lockFile = path.join(repoRoot, "bun.lock");
  const lockBefore = await readTextOrEnoent(lockFile);

  // 可变阶段：从 reset 起任何失败都要回滚
  const resetTo = async (commit: string): Promise<void> => {
    await execGit(exec, repoRoot, ["reset", "--hard", commit], "GIT_RESET_FAILED", `git reset --hard ${commit} 失败`);
  };
  const runGate = async (cmd: string[], code: string, label: string): Promise<void> => {
    let result: ExecResult;
    try {
      result = await exec.run(cmd);
    } catch (e) {
      throw new BridgeError(code, `${label}执行失败：${e instanceof Error ? e.message : String(e)}`, { cause: e });
    }
    if (result.code !== 0) {
      const stderr = result.stderr.trim().slice(0, 400);
      throw new BridgeError(code, `${label}未通过（退出码 ${result.code}）${stderr ? `：${stderr}` : ""}`);
    }
  };

  // 守护状态采集（回滚时需要知道是否要再重启）
  const pidPath = path.join(cfg.stateDir, PID_FILE_NAME);
  const readDaemonPid = async (): Promise<number | undefined> => {
    const raw = (await readTextOrEnoent(pidPath))?.trim();
    if (raw === undefined || raw.length === 0) return undefined;
    if (!/^\d+$/.test(raw)) {
      throw new BridgeError(
        "SELF_UPGRADE_PIDFILE_INVALID",
        `daemon.pid 内容非法（拒绝猜测进程状态）：path=${pidPath}`,
        { remediation: "核查守护进程实际状态后删除或修复该文件再重试" },
      );
    }
    return Number(raw);
  };

  try {
    await resetTo(remoteSha);

    // 6) 锁变更 → bun install
    const lockAfter = await readTextOrEnoent(lockFile);
    if (lockAfter !== lockBefore) {
      await runGate(["bun", "--cwd", repoRoot, "install"], "BUN_INSTALL_FAILED", "bun install");
    }

    // 7) 质量门
    if (opts.skipTypecheck !== true) {
      await runGate(["bun", "--cwd", repoRoot, "run", "typecheck"], "TYPECHECK_FAILED", "typecheck");
    }
    if (opts.skipTests !== true) {
      await runGate(["bun", "--cwd", repoRoot, "test"], "TESTS_FAILED", "bun test");
    }

    // 8) 守护重启 + 健康验证（未运行则跳过——不对"守护本来就没开"升级失败负责）
    const pid = await readDaemonPid();
    if (pid === undefined || !pidAlive(pid)) {
      return { action: "updated", from: headSha, to: remoteSha, daemonRestarted: false, testsRan: opts.skipTests !== true };
    }
    await runGate(
      ["systemctl", "--user", "restart", SERVICE_UNIT_NAMES.daemon],
      "DAEMON_RESTART_FAILED",
      "systemctl restart 守护",
    );
    let healthy = false;
    for (let i = 0; i < SELF_UPGRADE_HEALTH_ATTEMPTS; i++) {
      if (i > 0) await sleep(SELF_UPGRADE_HEALTH_INTERVAL_MS);
      if (await probeHealthOnce(fetchImpl, cfg.daemonUrl)) {
        healthy = true;
        break;
      }
    }
    if (!healthy) {
      throw new BridgeError(
        "DAEMON_HEALTH_FAILED",
        `守护重启后 /health 在 ${SELF_UPGRADE_HEALTH_ATTEMPTS} 次探测内未恢复 ok`,
        { remediation: "journalctl --user -t codearts-bridge 排查；回滚将自动执行" },
      );
    }
    return {
      action: "updated",
      from: headSha,
      to: remoteSha,
      daemonRestarted: true,
      testsRan: opts.skipTests !== true,
    };
  } catch (e) {
    // 回滚：reset 到备份提交；守护曾活跃（pidfile 可读且存活）则再次重启。
    // 回滚失败 → SELF_UPGRADE_ROLLBACK_FAILED（原错误挂 cause，备份记录保留供人工恢复）。
    let rollbackNote: string;
    try {
      await resetTo(headSha);
      rollbackNote = `已回滚到备份提交 ${headSha}`;
    } catch (rbErr) {
      throw new BridgeError(
        "SELF_UPGRADE_ROLLBACK_FAILED",
        `升级失败且自动回滚失败：原始错误=${e instanceof Error ? e.message : String(e)}；` +
          `回滚错误=${rbErr instanceof Error ? rbErr.message : String(rbErr)}；` +
          `备份记录（含人工恢复命令）保留于 ${backupFile}`,
        {
          remediation: `人工恢复：git -C ${repoRoot} reset --hard ${headSha}（备份记录：${backupFile}）`,
          cause: e,
        },
      );
    }
    // 回滚 reset 成功：尽力重启守护（曾活跃时）；重启失败仅追加说明，不掩盖原始错误
    let restartNote = "";
    try {
      const pid = await readDaemonPid();
      if (pid !== undefined && pidAlive(pid)) {
        await exec.run(["systemctl", "--user", "restart", SERVICE_UNIT_NAMES.daemon]);
        restartNote = "；守护已随回滚重启";
      }
    } catch (re) {
      restartNote = `；⚠ 回滚后守护重启失败（需人工 systemctl --user restart ${SERVICE_UNIT_NAMES.daemon}）：${re instanceof Error ? re.message : String(re)}`;
    }
    const be = e instanceof BridgeError ? e : undefined;
    throw new BridgeError(
      be?.code ?? "SELF_UPGRADE_FAILED",
      `${be?.message ?? (e instanceof Error ? e.message : String(e))}（${rollbackNote}${restartNote}）`,
      { remediation: be?.remediation, cause: be?.cause ?? e },
    );
  }
}
