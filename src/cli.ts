/**
 * codearts-bridge CLI（T1-01 最小骨架 + T3-01 daemon/status + T3-07 service/watchdog）。
 *
 * 命令分派：version/help（T1-01 原样保留）、daemon（前台守护）、status（健康探测）、
 * service install|status|uninstall（systemd user 单元安装管家）、watchdog-probe
 * （systemd timer 每分钟调用的探活命令）。
 * 约定：未知用法显式报错并以非零码退出（禁止静默兜底）。
 *
 * R-d5 落点（主控裁定 2026-10-31）：
 * - daemon：前台启动守护进程（createDaemon + start），SIGINT/SIGTERM 优雅 stop
 *   后以退出码 0 结束（stop 失败 → stderr 结构化信息 + 退出码 1，不静默）。
 *   进程退出码由 main() 统一 process.exit，命令函数只返回码（可测试性：测试在
 *   进程内直调命令函数，不触发 exit）。
 * - status：fetch <daemonUrl>/health（GET，免鉴权——R-d3 探活零依赖），3s 超时；
 *   成功 → stdout 打印健康 JSON、退出码 0；不可达/非 200/非本守护响应 → stderr
 *   结构化摘要（error.code=DAEMON_UNAVAILABLE 等）+ 非零退出码。
 *
 * T3-07 落点（主控裁定 R-sv1~R-sv4，progress.md Task 20）：
 * - daemon 生产装配（T3-05/T3-06 登记项①）：启动前按 R-cr1 同一套选择逻辑
 *   （readAksk → 按需 tmux 探测 → selectTransport → defaultBuildTransport）构造
 *   生产传输并挂载 GoalHost（defaultTickLoop(GOAL_SWEEP_INTERVAL_MS) sweep）——
 *   守护的生产运行形态下 /goals* 不再 501。装配失败显式拒绝启动（状态层坏不带
 *   病服务）；测试经 DaemonCommandDeps 注入 tmuxProbe/buildTransport。
 * - service install（R-sv3）：renderServiceUnit/renderWatchdogUnits 纯函数渲染 →
 *   幂等写入 ~/.config/systemd/user/ 三个单元（同内容不重写，mtime 不变）→
 *   systemctl daemon-reload + enable --now（经注入 exec，测试绝不真装）。
 * - service uninstall（R-sv3）：只删本插件三个单元（他单元不碰）；disable --now
 *   失败（未启用/未加载）属幂等卸载预期路径，stderr 留痕后继续（非静默——失败
 *   可见且文件删除照常完成），daemon-reload 收尾。
 * - service status：单元在场性 + is-active 状态汇总（stdout JSON；未安装 →
 *   SERVICE_NOT_INSTALLED 非零退出）。
 * - watchdog-probe（R-sv1/R-sv4）：is-active 预检（非 active → 清计数退出，崩溃
 *   自愈归 systemd Restart=always）→ daemon.pid mtime 宽限戳（120s 内不探测，
 *   stateDir 启动戳方案——daemon 每次启动覆写 daemon.pid，mtime 即启动时刻，
 *   免 systemctl 时间戳解析的时区歧义）→ fetch /health（15s 超时）→
 *   evaluateProbe 纯函数裁决 → 计数文件/restart 执行。失败原因分类
 *   （timeout/连接拒绝/non-json/ok-mismatch/http-5xx）入 stderr（journald 经
 *   SyslogIdentifier=codearts-bridge-watchdog 落账，R-sv4）。
 *   有应答即事件循环存活（任意状态码）→ 计数清零；体级异常只留痕不重启——
 *   重启无法修复"端口被其他进程占用"类问题，留痕排障才是正解（dsh 原型口径）。
 *
 * 可测试性设计：全部命令函数接收显式 cfg 与注入 deps（exec/fetch/时钟/路径），
 * 返回退出码而非直接 process.exit；daemonCommand 另设 hooks.onReady 供测试
 * 确定性驱动 SIGINT，生产不传即无感。
 */
import { mkdir, readFile, unlink } from "node:fs/promises";
import { spawn as nodeSpawn } from "node:child_process";
import { homedir } from "node:os";
import * as path from "node:path";
import type { BridgeConfig } from "./core/config";
import { PLUGIN_ID, PLUGIN_VERSION, loadConfig, readAksk } from "./core/config";
import { BridgeError } from "./core/errors";
import { atomicWriteFile, errnoOf } from "./core/fsx";
import { createNodeExec, statOrEnoent } from "./core/install";
import type { Exec, ExecResult } from "./core/install";
import {
  SERVICE_UNIT_NAMES,
  WATCHDOG_FAILS_FILE,
  WATCHDOG_GRACE_SECONDS,
  WATCHDOG_PROBE_TIMEOUT_MS,
  evaluateProbe,
  renderServiceUnit,
  renderWatchdogUnits,
} from "./core/service";
import type { ServiceUnitInput } from "./core/service";
import {
  defaultBuildTransport,
  defaultRunClock,
  needsTmuxProbe,
  probeTmuxAvailable,
  selectTransport,
} from "./core/run";
import type { RunClock, TransportSelection } from "./core/run";
import type { CodeartsTransport } from "./core/transport/types";
import { GOAL_SWEEP_INTERVAL_MS, GoalHost, defaultTickLoop } from "./daemon-goals";
import type { TickLoop } from "./daemon-goals";
import { createDaemon, daemonPidPath } from "./daemon";
import { doctorCommand as doctorReport } from "./core/doctor";
import { SELF_UPGRADE_GATE_MAX_OUTPUT_BYTES, SELF_UPGRADE_GATE_TIMEOUT_MS, selfUpgrade } from "./core/selfupgrade";
import { uninstallCommand } from "./core/uninstaller";
import type { UninstallDeps } from "./core/uninstaller";
import { upgradeCli } from "./core/upgrade";

const USAGE = `用法: codearts-bridge <命令>

命令:
  version            打印插件版本
  status             探测守护进程健康（GET <daemonUrl>/health，3s 超时；不可达→非零退出）
  daemon             前台启动守护进程（SIGINT/SIGTERM 优雅停止；挂载目标域 GoalHost）
  service install    安装 systemd user 单元（守护 + watchdog timer）并 enable --now
  service status     查看单元在场性与运行状态（stdout JSON）
  service uninstall  卸载单元（只删本插件单元，不动其他单元）
  watchdog-probe     watchdog 探测（systemd timer 每分钟调用；连续 2 次无响应重启守护）
  doctor             环境体检八项（opencode/bun/codearts CLI/凭据/systemd/守护/磁盘/网络）
                     ✓/⚠/✗ + 修复指引；尾部输出结构化 JSON；--json 仅 JSON；✗→退出码 1
  self-upgrade       bridge 自升级（git fetch→reset --hard origin/main→门禁→守护重启；
                     失败自动回滚备份提交；--skip-tests/--skip-typecheck 可跳门禁）
  upgrade-cli        codearts CLI 受控升级（探测→无更新即已最新→否则官方包受控升级，
                     失败零损坏）
  uninstall          卸载接线（opencode 自动加载入口 + systemd 单元；默认保留状态目录
                     与 codearts CLI；--purge 清状态目录；非交互须 --yes）
  help               打印本帮助`;

/** status 命令的探活超时（R-d5 固定 3s；导出供测试引用同一真相）。 */
export const STATUS_TIMEOUT_MS = 3000;

/** stderr 结构化错误出口（CLI 侧统一形态，与 HTTP/工具层 error.code 词汇一致）。 */
function printCliError(code: string, message: string, remediation?: string): void {
  console.error(
    JSON.stringify({ error: { code, message, ...(remediation !== undefined ? { remediation } : {}) } }, null, 2),
  );
}

/**
 * status 命令（R-d5）：探测守护健康。只判 ok:true 的 /health 应答；
 * 任何失败（不可达/超时/非 200/非 JSON/ok≠true）→ stderr 结构化摘要 + 退出码 1。
 */
export async function statusCommand(cfg: BridgeConfig): Promise<number> {
  const healthUrl = new URL("/health", cfg.daemonUrl);
  let res: Response;
  try {
    res = await fetch(healthUrl, { signal: AbortSignal.timeout(STATUS_TIMEOUT_MS) });
  } catch (e) {
    const reason = e instanceof Error ? e.name : String(e);
    printCliError(
      "DAEMON_UNAVAILABLE",
      `守护进程不可达：${healthUrl.toString()}（${reason}）`,
      "启动命令：codearts-bridge daemon",
    );
    return 1;
  }
  if (!res.ok) {
    printCliError("DAEMON_UNAVAILABLE", `守护 /health 返回 HTTP ${res.status}：${healthUrl.toString()}`);
    return 1;
  }
  let body: unknown;
  try {
    body = (await res.json()) as unknown;
  } catch {
    printCliError("HEALTH_INVALID", `守护 /health 响应非 JSON：${healthUrl.toString()}`);
    return 1;
  }
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : undefined;
  if (record?.["ok"] !== true) {
    printCliError(
      "HEALTH_MISMATCH",
      `端点应答非本守护健康形态（ok≠true）：${healthUrl.toString()}`,
    );
    return 1;
  }
  console.log(JSON.stringify(record, null, 2));
  return 0;
}

/** daemonCommand 测试钩子（生产不传；onReady 在 start 完成+信号处理器就位后触发）。 */
export interface DaemonCommandHooks {
  onReady?: (port: number) => void;
}

/** daemon 命令注入缝（T3-07 生产装配可替换项；测试注入确定性实现）。 */
export interface DaemonCommandDeps {
  /** tmux 可用性探测（缺省 probeTmuxAvailable；测试注入 false 免真实 spawn）。 */
  tmuxProbe?: () => Promise<boolean>;
  /** 传输工厂（缺省 defaultBuildTransport；测试注入 FakeTransport）。 */
  buildTransport?: (sel: TransportSelection) => CodeartsTransport;
  /** 时钟（缺省 defaultRunClock；GoalHost 与 runner 同源——M72 口径）。 */
  clock?: RunClock;
  /** sweep 循环宿主（缺省 defaultTickLoop(GOAL_SWEEP_INTERVAL_MS)）。 */
  loop?: TickLoop;
  /**
   * 独立验收执行器（修复环裁定① 2026-10-31：缺省 execVerify——生产 GoalHost
   * 必接线 verifyRun，否则带 verify 的 POST /goals 生产必失败（真机 T4-02 实证
   * GOAL_VERIFY_RUN_MISSING + 半成品目标落盘）；测试注入 fake 断言透传）。
   */
  execVerify?: (cmd: string[], cwd?: string) => Promise<{ ok: boolean; out: string }>;
}

/* ───── verify 独立验收执行器（修复环裁定① 生产缺省实现） ───── */

/** verify 命令超时（裁定①：60s；超时 SIGKILL 并记验收失败）。 */
export const VERIFY_TIMEOUT_MS = 60_000;

/** verify 输出截断上限（字符）：审计/注入文案取摘要，防超大输出拖垮守护。 */
export const VERIFY_OUT_MAX_CHARS = 8_000;

function capVerifyOut(s: string): string {
  return s.length > VERIFY_OUT_MAX_CHARS
    ? `${s.slice(0, VERIFY_OUT_MAX_CHARS)}…(+${s.length - VERIFY_OUT_MAX_CHARS} 字符截断)`
    : s;
}

/**
 * 生产缺省 verifyRun（修复环裁定① 2026-10-31）：child_process 直 exec（不经
 * shell、argv 数组传递）；60s 超时强杀；输出截断上限；cwd 透传（GoalHost 逐
 * 目标绑定 = 缺省目标 workdir；目标无 workdir → 守护进程 cwd）。
 * 退出码非 0 / 超时 / spawn 失败一律 ok=false 且 out 携带显式失败原因——"无法
 * 完成验收"本身就是验收未过的事实，失败详情上供给 runner 注入续跑（非静默
 * 兜底：错误可见、目标不被误判完成）；cmd[0] 缺失属调用方缺陷，显式抛错。
 */
export async function execVerify(cmd: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  const file = cmd[0];
  if (file === undefined || file === "") {
    throw new BridgeError("GOAL_VERIFY_CMD_INVALID", `验收命令为空（cmd[0] 缺失）：${JSON.stringify(cmd)}`);
  }
  return await new Promise<{ ok: boolean; out: string }>((resolve) => {
    let out = "";
    let settled = false;
    const child = nodeSpawn(file, cmd.slice(1), { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const collect = (b: Buffer): void => {
      if (out.length <= VERIFY_OUT_MAX_CHARS) out += b.toString("utf8");
    };
    const finish = (reason: string): void => {
      if (settled) return;
      settled = true;
      resolve({ ok: false, out: capVerifyOut(`${reason}${out}`) });
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(`验收命令超时（>${VERIFY_TIMEOUT_MS}ms）已被终止。`);
    }, VERIFY_TIMEOUT_MS);
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish(`验收命令无法执行：${e.code ?? "UNKNOWN"}（${e.message}）。`);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        if (settled) return;
        settled = true;
        resolve({ ok: true, out: capVerifyOut(out.trim()) });
      } else {
        finish(`验收命令退出码=${code ?? "null"}。`);
      }
    });
  });
}

/**
 * 守护生产传输装配（R-cr1 同一套选择逻辑，登记项①）：
 * readAksk → 按需 tmux 探测 → selectTransport → 传输工厂。
 * 与 runOnce 逐行同构（凭据口径/tmux 探测条件一致），杜绝第二套选择真相源。
 */
async function resolveProductionTransport(
  cfg: BridgeConfig,
  deps: DaemonCommandDeps,
): Promise<CodeartsTransport> {
  const aksk = await readAksk(cfg.akskFile);
  const hasAksk =
    aksk !== undefined && aksk.AK !== undefined && aksk.AK !== "" && aksk.SK !== undefined && aksk.SK !== "";
  let tmuxAvailable = false;
  if (needsTmuxProbe(cfg.transport, cfg.ptyHost, hasAksk)) {
    tmuxAvailable = await (deps.tmuxProbe ?? probeTmuxAvailable)();
  }
  const sel = selectTransport({ transport: cfg.transport, ptyHost: cfg.ptyHost, hasAksk, tmuxAvailable });
  console.error(`[codearts-bridge] 目标域传输：${sel.mode}（${sel.reason}）`);
  return (deps.buildTransport ?? defaultBuildTransport)(sel);
}

/**
 * daemon 命令（R-d5 + T3-07 登记项①）：前台启动守护，SIGINT/SIGTERM 优雅停止。
 * 生产装配挂载 GoalHost（/goals* 可用）；返回退出码：正常停止 0；停止失败 1。
 *
 * 信号处理器先于 start() 注册：若先启动/打印就绪行再注册，"打印→注册"的窗口期
 * 内到达的信号按默认处置直接杀进程、优雅停止失效（实测竞态概率可观——管道写
 * 同步返回后父进程可立即 kill，子进程可能尚未完成注册）；先注册后启动使任何
 * 时刻的信号都进入优雅路径：start 期间到达 → start 完成后立即优雅停止。
 */
export async function daemonCommand(
  cfg: BridgeConfig = loadConfig(),
  hooks: DaemonCommandHooks = {},
  deps: DaemonCommandDeps = {},
): Promise<number> {
  // 生产装配（登记项①）：传输选择失败（凭据文件损坏/tmux 探测异常）显式拒绝
  // 启动——目标域不可用的守护不该装作健康（禁静默降级为 501 形态）。
  const transport = await resolveProductionTransport(cfg, deps);
  const goals = new GoalHost({
    cfg,
    transport,
    clock: deps.clock ?? defaultRunClock,
    loop: deps.loop ?? defaultTickLoop(GOAL_SWEEP_INTERVAL_MS),
    verifyRun: deps.execVerify ?? execVerify, // 修复环裁定①：生产必接线（真机缺陷①治理）
  });
  const daemon = createDaemon(cfg, undefined, goals);
  const signals = ["SIGINT", "SIGTERM"] as const;
  let stopping = false; // 信号去重（SIGINT+SIGTERM 连发只停一次）
  let resolveSignal: (sig: string) => void = () => undefined;
  const signalReceived = new Promise<string>((resolve) => {
    resolveSignal = resolve;
  });
  const removeSignalListeners = () => {
    for (const sig of signals) process.removeListener(sig, onSignal);
  };
  const onSignal = (sig: string) => {
    if (stopping) return;
    stopping = true;
    removeSignalListeners();
    resolveSignal(sig);
  };
  for (const sig of signals) process.on(sig, onSignal);

  try {
    const { port } = await daemon.start();
    console.log(
      `codearts-bridge daemon: 监听 127.0.0.1:${port}（version=${PLUGIN_VERSION}，stateDir=${cfg.stateDir}）；SIGINT/SIGTERM 优雅停止`,
    );
    hooks.onReady?.(port);
  } catch (e) {
    removeSignalListeners(); // 启动失败即退出：不留信号处理器悬挂
    throw e;
  }
  const sig = await signalReceived;
  try {
    await daemon.stop();
    console.log(`codearts-bridge daemon: 收到 ${sig}，守护已优雅停止`);
    return 0;
  } catch (e) {
    printCliError(
      "DAEMON_STOP_FAILED",
      `守护停止失败：${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
}

/* ───── service 命令组（T3-07，R-sv2/R-sv3） ───── */

/**
 * fetch 结构子集（与全局 fetch 兼容；测试 fake 按此实现）。
 * 不用 `typeof fetch`：Bun 的全局 fetch 带 preconnect 附加属性，测试的纯函数
 * fake 无法满足该形态（T3-06 DaemonFetcher 同款先例）。
 */
export type FetchLike = (url: URL | string, init?: RequestInit) => Promise<Response>;

/** service 命令注入缝（exec/unitDir/fetch/时钟/路径锚点；测试全部注入，绝不真装）。 */
export interface ServiceDeps {
  /** systemctl 执行器（缺省 createNodeExec；测试注入 fake 记录调用）。 */
  exec?: Exec;
  /** systemd user 单元目录（缺省 ~/.config/systemd/user；测试注入临时目录）。 */
  unitDir?: string;
  /** watchdog 探测 fetch（缺省全局 fetch；测试注入 fake）。 */
  fetchImpl?: FetchLike;
  /** watchdog 时钟（缺省 Date.now；测试注入固定值）。 */
  nowMs?: () => number;
  /** bun 绝对路径（缺省 process.execPath；测试注入确定值）。 */
  bunPath?: string;
  /** cli.ts 绝对路径（缺省本文件；测试注入确定值）。 */
  cliPath?: string;
}

/** 单元目录缺省值（R-sv3：~/.config/systemd/user）。 */
function defaultUnitDir(): string {
  return path.join(homedir(), ".config", "systemd", "user");
}

/** cli.ts 锚点缺省值：本文件与 cli.ts 同目录（src/cli.ts），部署形态自含。 */
function defaultCliPath(): string {
  return path.join(import.meta.dir, "cli.ts");
}

/** 组装单元渲染输入（install 与 status 共用；状态根经 Environment 钉入单元）。 */
function unitInputOf(cfg: BridgeConfig, deps: ServiceDeps): ServiceUnitInput {
  return {
    bunPath: deps.bunPath ?? process.execPath,
    cliPath: deps.cliPath ?? defaultCliPath(),
    stateDir: cfg.stateDir,
  };
}

/** 统一 service 命令错误出口：BridgeError 携码透传，其余归 SERVICE_EXEC_FAILED。 */
function serviceError(e: unknown): number {
  const be = e instanceof BridgeError ? e : undefined;
  printCliError(
    be?.code ?? "SERVICE_EXEC_FAILED",
    `${e instanceof Error ? e.message : String(e)}`,
    be?.remediation,
  );
  return 1;
}

/** 执行 systemctl --user <args>；非零退出码显式转 BridgeError（含 stderr 摘要）。 */
async function runSystemctl(exec: Exec, args: string[]): Promise<ExecResult> {
  const cmd = ["systemctl", "--user", ...args];
  let result: ExecResult;
  try {
    result = await exec.run(cmd);
  } catch (e) {
    throw new BridgeError(
      "SERVICE_EXEC_FAILED",
      `systemctl 执行失败（非 systemd 环境?）：${cmd.join(" ")}：${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
  if (result.code !== 0) {
    const stderr = result.stderr.trim();
    throw new BridgeError(
      "SERVICE_EXEC_FAILED",
      `systemctl 退出码 ${result.code}：${cmd.join(" ")}${stderr.length > 0 ? `：${stderr}` : ""}`,
    );
  }
  return result;
}

/**
 * service install（R-sv3）：渲染三个单元 → 幂等写入（同内容不重写，mtime 不变）
 * → daemon-reload → enable --now（守护 + watchdog timer；watchdog.service 由
 * timer 激活，不单独 enable）。输出 stdout JSON {installed, written, skipped}。
 */
export async function serviceInstallCommand(cfg: BridgeConfig = loadConfig(), deps: ServiceDeps = {}): Promise<number> {
  const exec = deps.exec ?? createNodeExec();
  const unitDir = deps.unitDir ?? defaultUnitDir();
  try {
    const input = unitInputOf(cfg, deps);
    const watchdog = renderWatchdogUnits(input);
    const units: Array<[string, string]> = [
      [SERVICE_UNIT_NAMES.daemon, renderServiceUnit(input)],
      [SERVICE_UNIT_NAMES.watchdogService, watchdog.service],
      [SERVICE_UNIT_NAMES.watchdogTimer, watchdog.timer],
    ];
    await mkdir(unitDir, { recursive: true });
    const written: string[] = [];
    const skipped: string[] = [];
    for (const [name, content] of units) {
      const target = path.join(unitDir, name);
      let existing: string | undefined;
      try {
        existing = await readFile(target, "utf8");
      } catch (e) {
        if (errnoOf(e) !== "ENOENT") throw e;
      }
      if (existing === content) {
        skipped.push(name); // 幂等：同内容不重写（mtime 不变，R-sv3"重复执行同内容"）
        continue;
      }
      await atomicWriteFile(target, content, 0o644); // 原子替换：目标要么旧要么新
      written.push(name);
    }
    await runSystemctl(exec, ["daemon-reload"]);
    await runSystemctl(exec, ["enable", "--now", SERVICE_UNIT_NAMES.daemon, SERVICE_UNIT_NAMES.watchdogTimer]);
    console.log(JSON.stringify({ installed: unitDir, written, skipped }));
    return 0;
  } catch (e) {
    return serviceError(e);
  }
}

/**
 * service uninstall（R-sv3）：只删本插件三个单元文件（他单元不碰）。
 * 未安装（三单元全缺）→ 幂等 rc 0 且零 systemctl 调用；disable --now 失败
 * （未启用/未加载）属幂等卸载预期，stderr 留痕后继续删文件（失败可见非静默），
 * daemon-reload 收尾让 systemd 遗忘已删单元。
 */
export async function serviceUninstallCommand(cfg: BridgeConfig = loadConfig(), deps: ServiceDeps = {}): Promise<number> {
  const exec = deps.exec ?? createNodeExec();
  const unitDir = deps.unitDir ?? defaultUnitDir();
  try {
    const allNames = [SERVICE_UNIT_NAMES.daemon, SERVICE_UNIT_NAMES.watchdogService, SERVICE_UNIT_NAMES.watchdogTimer];
    const present: string[] = [];
    for (const name of allNames) {
      if ((await statOrEnoent(path.join(unitDir, name))) !== undefined) present.push(name);
    }
    if (present.length === 0) {
      console.log(JSON.stringify({ uninstalled: [], unitDir, note: "未安装" }));
      return 0;
    }
    try {
      await runSystemctl(exec, ["disable", "--now", ...allNames]);
    } catch (e) {
      console.error(
        `[codearts-bridge] systemctl disable --now 失败（幂等卸载：未启用/未加载属预期，继续删除单元文件）：${e instanceof Error ? e.message : String(e)}`,
      );
    }
    for (const name of present) {
      try {
        await unlink(path.join(unitDir, name));
      } catch (e) {
        if (errnoOf(e) !== "ENOENT") throw e; // stat 与 unlink 之间的并发删除：容忍
      }
    }
    await runSystemctl(exec, ["daemon-reload"]);
    console.log(JSON.stringify({ uninstalled: present, unitDir }));
    return 0;
  } catch (e) {
    return serviceError(e);
  }
}

/**
 * service status：单元在场性 + is-active 状态汇总（stdout JSON，rc 0）。
 * 守护单元缺失 → SERVICE_NOT_INSTALLED 结构化 stderr + rc 1。
 */
export async function serviceStatusCommand(cfg: BridgeConfig = loadConfig(), deps: ServiceDeps = {}): Promise<number> {
  const exec = deps.exec ?? createNodeExec();
  const unitDir = deps.unitDir ?? defaultUnitDir();
  try {
    const units = {
      daemon: (await statOrEnoent(path.join(unitDir, SERVICE_UNIT_NAMES.daemon))) !== undefined,
      watchdogService: (await statOrEnoent(path.join(unitDir, SERVICE_UNIT_NAMES.watchdogService))) !== undefined,
      watchdogTimer: (await statOrEnoent(path.join(unitDir, SERVICE_UNIT_NAMES.watchdogTimer))) !== undefined,
    };
    if (!units.daemon) {
      printCliError(
        "SERVICE_NOT_INSTALLED",
        `codearts-bridge systemd 服务未安装：缺少 ${path.join(unitDir, SERVICE_UNIT_NAMES.daemon)}`,
        "执行 codearts-bridge service install",
      );
      return 1;
    }
    // is-active 非零码=inactive/failed 属正常状态语义（不抛）；执行层失败（ENOENT）才抛
    const activeState = async (unit: string): Promise<{ code: number; state: string }> => {
      const r = await exec.run(["systemctl", "--user", "is-active", unit]);
      return { code: r.code, state: r.stdout.trim().length > 0 ? r.stdout.trim() : "unknown" };
    };
    const daemonActive = await activeState(SERVICE_UNIT_NAMES.daemon);
    const timerActive = await activeState(SERVICE_UNIT_NAMES.watchdogTimer);
    console.log(
      JSON.stringify({
        unitDir,
        stateDir: cfg.stateDir,
        units,
        active: { daemon: daemonActive.code === 0, watchdogTimer: timerActive.code === 0 },
        states: { daemon: daemonActive.state, watchdogTimer: timerActive.state },
      }),
    );
    return 0;
  } catch (e) {
    return serviceError(e);
  }
}

/* ───── watchdog-probe 命令（R-sv1/R-sv4） ───── */

/** 清除计数文件（ENOENT 容忍）；其他错误显式上抛。 */
async function clearFailsFile(failsFile: string): Promise<void> {
  try {
    await unlink(failsFile);
  } catch (e) {
    if (errnoOf(e) !== "ENOENT") throw e;
  }
}

/**
 * 探测 /health 并归一结果（R-sv1/R-sv4）：
 * - 拿到任何 HTTP 应答 → httpCode=状态码（事件循环存活）；reason 记健康/体异常分类；
 * - 未拿到应答（连接拒绝/超时等）→ httpCode=0；reason=失败分类
 *   （timeout / errno 码如 ECONNREFUSED / 错误名），供 stderr 留痕排障。
 */
async function probeHealth(fetchImpl: FetchLike, url: URL): Promise<{ httpCode: number; reason: string }> {
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(WATCHDOG_PROBE_TIMEOUT_MS) });
    if (res.status !== 200) {
      return { httpCode: res.status, reason: `http-${res.status}` };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { httpCode: res.status, reason: "non-json" };
    }
    const ok = typeof body === "object" && body !== null && (body as Record<string, unknown>)["ok"] === true;
    return { httpCode: res.status, reason: ok ? "healthy" : "ok-mismatch" };
  } catch (e) {
    const name = e instanceof Error ? e.name : "";
    const code = errnoOf(e);
    return {
      httpCode: 0,
      reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : (code ?? (name || "unknown")),
    };
  }
}

/**
 * watchdog-probe（R-sv1）：systemd timer 每分钟调用一次的探活命令。
 * 全流程见文件头注 T3-07 段；每轮在 stderr 留一行结构化结论（journald 落账）。
 * 返回码：0 = 探测流程完成（含触发重启成功）；1 = 流程性失败（systemctl 不可用/
 * 重启执行失败——timer journal 可见，下一分钟重试）。
 */
export async function watchdogProbeCommand(cfg: BridgeConfig = loadConfig(), deps: ServiceDeps = {}): Promise<number> {
  const exec = deps.exec ?? createNodeExec();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = (deps.nowMs ?? Date.now)();
  const log = (line: string): void => {
    console.error(`[codearts-bridge watchdog] ${new Date(now).toISOString()} ${line}`);
  };
  const failsFile = path.join(cfg.stateDir, WATCHDOG_FAILS_FILE);
  try {
    // 1) is-active 预检：非 active → 清计数退出（进程崩溃/停止归 systemd
    //    Restart=always 管——dsh 原型分工：本探针只管"活着但卡死"）
    let active: ExecResult;
    try {
      active = await exec.run(["systemctl", "--user", "is-active", "--quiet", SERVICE_UNIT_NAMES.daemon]);
    } catch (e) {
      throw new BridgeError(
        "SERVICE_EXEC_FAILED",
        `watchdog-probe 无法执行 systemctl：${e instanceof Error ? e.message : String(e)}`,
        { cause: e },
      );
    }
    if (active.code !== 0) {
      await clearFailsFile(failsFile);
      log(`服务非 active（rc=${active.code}），跳过探测并清除计数`);
      return 0;
    }

    // 2) 宽限期（R-sv1，stateDir 启动戳方案）：daemon.pid 由守护每次启动写/覆写
    //    （daemon.ts acquirePidfile），mtime 即启动时刻——免 systemctl 时间戳解析
    //    的时区歧义，也天然覆盖"容器/非 systemd 时间源"形态。pid 文件缺失 = 守护
    //    尚未完成启动（pidfile 在 start 早期写入）→ 按宽限跳过，防启动慢被误杀。
    const pidStat = await statOrEnoent(daemonPidPath(cfg));
    if (pidStat === undefined) {
      log(`daemon.pid 不存在（守护尚未完成启动），按宽限跳过`);
      return 0;
    }
    const ageMs = now - pidStat.mtimeMs;
    if (ageMs < WATCHDOG_GRACE_SECONDS * 1000) {
      log(`守护启动 ${Math.round(Math.max(ageMs, 0) / 1000)}s 前（宽限 ${WATCHDOG_GRACE_SECONDS}s 内），跳过探测`);
      return 0;
    }

    // 3) 既有计数：ENOENT → 0；内容非法/空 → stderr 留痕按 0 起算（对齐
    //    daemon.pid 陈旧清除先例——计数是派生物，损失无害，留痕非静默）
    let prevFails = 0;
    let prevRaw: string | undefined;
    try {
      prevRaw = (await readFile(failsFile, "utf8")).trim();
    } catch (e) {
      if (errnoOf(e) !== "ENOENT") throw e;
    }
    if (prevRaw !== undefined) {
      if (/^\d+$/.test(prevRaw)) {
        prevFails = Number(prevRaw);
      } else {
        console.error(
          `[codearts-bridge watchdog] 计数文件内容非法（按 0 起算，本轮覆写）：path=${failsFile} content=${JSON.stringify(prevRaw.slice(0, 64))}`,
        );
      }
    }

    // 4) fetch /health（R-sv1：15s 超时）：拿到任何应答 → httpCode=状态码；
    //    未拿到 → 0，reason=失败分类（R-sv4，入 stderr/journal 留痕）
    const { httpCode, reason } = await probeHealth(fetchImpl, new URL("/health", cfg.daemonUrl));

    // 5) 纯函数裁决 + 执行（R-sv1）：ok 清计数 / increment 落新计数 / restart
    //    清计数并 systemctl --user restart（重启失败显式 rc 1，timer journal 可见）
    const verdict = evaluateProbe({ httpCode, prevFails, graceActive: false }, now);
    if (verdict.action === "ok" && verdict.fails === 0) {
      await clearFailsFile(failsFile);
    } else if (verdict.action === "increment") {
      await atomicWriteFile(failsFile, String(verdict.fails), 0o644);
    } else {
      await clearFailsFile(failsFile);
      await runSystemctl(exec, ["restart", SERVICE_UNIT_NAMES.daemon]);
    }
    log(`code=${httpCode} reason=${reason} fails=${verdict.fails} action=${verdict.action}`);
    return 0;
  } catch (e) {
    const be = e instanceof BridgeError ? e : undefined;
    printCliError(
      be?.code ?? "WATCHDOG_PROBE_FAILED",
      `watchdog-probe 失败：${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
}

/* ───── T4-05：doctor / self-upgrade / upgrade-cli / uninstall 命令 ───── */

/** 门禁与 git/systemctl 命令的生产缺省 Exec（self-upgrade 门禁可达数十秒）。 */
function gateExec(): Exec {
  return createNodeExec({ timeoutMs: SELF_UPGRADE_GATE_TIMEOUT_MS, maxOutputBytes: SELF_UPGRADE_GATE_MAX_OUTPUT_BYTES });
}

/** doctor 命令：环境体检八项（--json 仅结构化输出）；退出码=聚合判定（✗→1）。 */
export async function doctorCliCommand(argv: readonly string[], cfg: BridgeConfig = loadConfig()): Promise<number> {
  const json = argv.includes("--json");
  return doctorReport(cfg, {}, { json });
}

/** self-upgrade 命令：安全自升级（--skip-tests/--skip-typecheck 跳门禁）。 */
export async function selfUpgradeCliCommand(
  argv: readonly string[],
  cfg: BridgeConfig = loadConfig(),
): Promise<number> {
  let result;
  try {
    result = await selfUpgrade(
      cfg,
      { exec: gateExec() },
      { skipTests: argv.includes("--skip-tests"), skipTypecheck: argv.includes("--skip-typecheck") },
    );
  } catch (e) {
    const be = e instanceof BridgeError ? e : undefined;
    printCliError(
      be?.code ?? "SELF_UPGRADE_FAILED",
      `self-upgrade 失败：${e instanceof Error ? e.message : String(e)}`,
      be?.remediation,
    );
    return 1;
  }
  console.log(JSON.stringify(result, null, 2));
  return 0;
}

/** upgrade-cli 命令：codearts CLI 受控升级（探测→无更新→受控升级，失败零损坏）。 */
export async function upgradeCliCommand(cfg: BridgeConfig = loadConfig()): Promise<number> {
  try {
    const result = await upgradeCli(cfg, { exec: gateExec() });
    console.log(JSON.stringify(result, null, 2));
    return 0;
  } catch (e) {
    const be = e instanceof BridgeError ? e : undefined;
    printCliError(
      be?.code ?? "UPGRADE_CLI_FAILED",
      `codearts CLI 升级失败：${e instanceof Error ? e.message : String(e)}`,
      be?.remediation,
    );
    return 1;
  }
}

/** uninstall 命令参数解析结果。 */
interface UninstallArgs {
  yes: boolean;
  purge: boolean;
}

/** 解析 uninstall 参数；未知参数显式报错（禁静默忽略）。 */
function parseUninstallArgs(argv: readonly string[]): UninstallArgs | undefined {
  const args: UninstallArgs = { yes: false, purge: false };
  for (const a of argv) {
    if (a === "--yes") args.yes = true;
    else if (a === "--purge") args.purge = true;
    else {
      printCliError("CLI_ARG_INVALID", `uninstall 未知参数 "${a}"（仅支持 --yes/--purge）`);
      return undefined;
    }
  }
  return args;
}

/** uninstall 命令：卸载接线（默认保留状态目录与 codearts CLI）。 */
export async function uninstallCliCommand(
  argv: readonly string[],
  cfg: BridgeConfig = loadConfig(),
): Promise<number> {
  const args = parseUninstallArgs(argv);
  if (args === undefined) return 2;
  const deps: UninstallDeps = {
    exec: createNodeExec({ timeoutMs: 30_000 }),
    serviceUninstall: serviceUninstallCommand,
  };
  return uninstallCommand(cfg, deps, { yes: args.yes, purge: args.purge });
}

/** CLI 命令分派（返回退出码；仅 import.meta.main 时由底部出口真正 exit）。 */
export async function main(argv: readonly string[]): Promise<number> {
  const cmd = argv[0];
  if (cmd === undefined || cmd === "help") {
    console.log(USAGE);
    return 0;
  }
  if (cmd === "version") {
    console.log(`${PLUGIN_ID} ${PLUGIN_VERSION}`);
    return 0;
  }
  if (cmd === "daemon") {
    return daemonCommand(loadConfig());
  }
  if (cmd === "status") {
    return statusCommand(loadConfig());
  }
  if (cmd === "service") {
    const sub = argv[1];
    if (sub === "install") return serviceInstallCommand(loadConfig());
    if (sub === "status") return serviceStatusCommand(loadConfig());
    if (sub === "uninstall") return serviceUninstallCommand(loadConfig());
    console.error(`codearts-bridge: service 未知子命令 "${sub ?? ""}"（须为 install/status/uninstall）\n${USAGE}`);
    return 2;
  }
  if (cmd === "watchdog-probe") {
    return watchdogProbeCommand(loadConfig());
  }
  if (cmd === "doctor") {
    return doctorCliCommand(argv.slice(1));
  }
  if (cmd === "self-upgrade") {
    return selfUpgradeCliCommand(argv.slice(1));
  }
  if (cmd === "upgrade-cli") {
    return upgradeCliCommand(loadConfig());
  }
  if (cmd === "uninstall") {
    return uninstallCliCommand(argv.slice(1));
  }
  console.error(`codearts-bridge: 未知命令 "${cmd}"\n${USAGE}`);
  return 2;
}

// 仅直接执行时进入命令分派（被测试/其他模块导入时不产生副作用）
if (import.meta.main) {
  main(Bun.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      // 分派层意外异常：显式落 stderr + 非零退出（禁静默吞错）
      console.error(
        `[codearts-bridge] CLI 内部错误：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`,
      );
      process.exit(1);
    },
  );
}
