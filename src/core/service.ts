/**
 * codearts-bridge systemd 服务与 watchdog 单元生成器（T3-07，纯函数层）。
 *
 * 职责边界（主控裁定 R-sv1/R-sv2，progress.md Task 20）：
 * - 本文件只做两件事：① systemd 单元文件的字符串渲染（R-sv2 纯函数，内容走
 *   快照/内容断言测试）；② watchdog 探测结果的纯评估（R-sv1 evaluateProbe）。
 *   一切 FS 写入、systemctl 调用、fetch 探测都在 CLI 命令层（src/cli.ts）经注入
 *   依赖执行——测试绝不真装单元、绝不真连守护、绝不真重启服务。
 *
 * 范式来源（用户既有 dsh-web 运维模式，bin/dsh-watchdog-probe.sh）：
 * - 进程崩溃由 systemd Restart=always 处理；watchdog 只管"活着但卡死"
 *   （事件循环阻塞时 HTTP 探测超时/无响应）；
 * - 任何 HTTP 状态码（含 401/500）都证明事件循环活着——有应答即健康、计数清零；
 * - 连续 2 次无响应 → systemctl --user restart，计数清零重新累计；
 * - 启动后 120s 宽限期不探测（等引导完成，防启动慢被误杀）；
 * - 计数文件落在状态目录，探测失败原因分类留痕（R-sv4：stderr/journal）。
 *
 * 裁定偏差登记（签名细化，语义不偏离）：
 * - renderWatchdogUnits 接收与 renderServiceUnit 相同的 ServiceUnitInput：裁定文
 *   写作 `renderWatchdogUnits()`，但 R-sv2 内容断言要求 watchdog 单元的 ExecStart
 *   同样是"绝对路径"，无参签名无法嵌入 bun/cli 绝对路径——取同参签名保住绝对
 *   路径断言，纯函数性质不变。
 *
 * 错误纪律（仓库铁律）：非法输入（相对路径/负数/非整数）就地显式抛 BridgeError，
 * 禁止静默钳位或补默认值。
 */
import * as path from "node:path";
import { BridgeError } from "./errors";

/* ───── 常量（单一真相，CLI 命令层与单元渲染共用） ───── */

/** 启动宽限期秒数（R-sv1：启动后 120s 内不探测，等引导完成）。 */
export const WATCHDOG_GRACE_SECONDS = 120;

/** 连续无响应重启阈值（R-sv1：连续 ≥2 次无响应 → restart）。 */
export const WATCHDOG_FAIL_THRESHOLD = 2;

/** 探测超时毫秒（R-sv1：fetch /health 15s 超时）。 */
export const WATCHDOG_PROBE_TIMEOUT_MS = 15_000;

/** 无响应计数文件名（位于状态根；R-sv1：stateDir/watchdog-fails）。 */
export const WATCHDOG_FAILS_FILE = "watchdog-fails";

/** 三个 systemd 单元文件名（R-sv3：~/.config/systemd/user/ 下的安装目标）。 */
export const SERVICE_UNIT_NAMES = {
  daemon: "codearts-bridge.service",
  watchdogService: "codearts-bridge-watchdog.service",
  watchdogTimer: "codearts-bridge-watchdog.timer",
} as const;

/** 守护崩溃重启间隔秒（Restart=always 的再拉起节拍；与 watchdog 分钟级探活互补）。 */
export const SERVICE_RESTART_SEC = 3;

/* ───── 单元生成器（R-sv2） ───── */

/** 单元渲染输入（全部绝对路径；user 服务缺省省略 User= 指令）。 */
export interface ServiceUnitInput {
  /** bun 可执行绝对路径（安装时经 process.execPath 探测）。 */
  bunPath: string;
  /** cli.ts 绝对路径（ExecStart 第二段：bun <cli.ts> daemon|watchdog-probe）。 */
  cliPath: string;
  /** 状态根绝对路径（经 Environment 钉入，守护与 watchdog 同一真相源）。 */
  stateDir: string;
  /** 可选 User= 指令（系统级服务变体；user 服务不需要）。 */
  user?: string;
}

/** 绝对路径校验（systemd ExecStart 硬性要求绝对路径；相对路径显式拒绝）。 */
function requireAbsolute(field: string, value: string): string {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw new BridgeError(
      "SERVICE_UNIT_INPUT_INVALID",
      `${field} 必须为非空绝对路径（systemd ExecStart 要求），实际为 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * 渲染守护单元 codearts-bridge.service（R-sv2 纯函数）。
 *
 * - Restart=always + RestartSec：进程崩溃/退出的自愈归 systemd（watchdog 只管
 *   挂起——dsh 原型分工注释原样保留）；
 * - ExecStart 双路径加引号：路径含空格时 systemd 仍按单参数解析；
 * - Environment 钉 CODEARTS_BRIDGE_STATE_DIR：守护进程与 watchdog-probe 命令
 *   经同一环境变量取得状态根，杜绝两套路径真相源漂移；
 * - 日志三件套（StandardOutput/StandardError=journal + SyslogIdentifier）：
 *   stdout/stderr 全部落 journald，`journalctl --user -t codearts-bridge` 可查
 *   （R-sv2"日志到 journal"断言对象）。
 */
export function renderServiceUnit(input: ServiceUnitInput): string {
  const bunPath = requireAbsolute("bunPath", input.bunPath);
  const cliPath = requireAbsolute("cliPath", input.cliPath);
  const stateDir = requireAbsolute("stateDir", input.stateDir);
  const userLine = input.user !== undefined ? `User=${input.user}\n` : "";
  return [
    "[Unit]",
    "Description=codearts-bridge 守护进程（目标引擎常驻宿主）",
    "After=network.target",
    "",
    "[Service]",
    userLine,
    `ExecStart="${bunPath}" "${cliPath}" daemon`,
    "Restart=always",
    `RestartSec=${SERVICE_RESTART_SEC}`,
    `Environment="CODEARTS_BRIDGE_STATE_DIR=${stateDir}"`,
    "StandardOutput=journal",
    "StandardError=journal",
    "SyslogIdentifier=codearts-bridge",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/**
 * 渲染 watchdog 单元对（R-sv2 纯函数）：oneshot 探测服务 + 每分钟触发 timer。
 *
 * - watchdog.service 由 timer 激活（不单独 enable），Type=oneshot 跑完即退；
 * - timer OnCalendar=minutely 每分钟一次；Persistent=true 补跑休眠/停机期间
 *   错过的触发（探针幂等，补跑无害）；
 * - ExecStart 与守护单元同参渲染（绝对路径断言一致，见头注偏差登记）。
 */
export function renderWatchdogUnits(input: ServiceUnitInput): { service: string; timer: string } {
  const bunPath = requireAbsolute("bunPath", input.bunPath);
  const cliPath = requireAbsolute("cliPath", input.cliPath);
  const service = [
    "[Unit]",
    `Description=codearts-bridge watchdog 探测（每分钟；连续 ${WATCHDOG_FAIL_THRESHOLD} 次无响应重启守护）`,
    `After=${SERVICE_UNIT_NAMES.daemon}`,
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart="${bunPath}" "${cliPath}" watchdog-probe`,
    "StandardOutput=journal",
    "StandardError=journal",
    "SyslogIdentifier=codearts-bridge-watchdog",
    "",
  ].join("\n");
  const timer = [
    "[Unit]",
    "Description=codearts-bridge watchdog 探测定时器（每分钟）",
    "",
    "[Timer]",
    "OnCalendar=minutely",
    "Persistent=true",
    `Unit=${SERVICE_UNIT_NAMES.watchdogService}`,
    "",
    "[Install]",
    "WantedBy=timers.target",
    "",
  ].join("\n");
  return { service, timer };
}

/* ───── 探测评估纯函数（R-sv1） ───── */

/** 探测裁决动作（R-sv1 固定三值）。 */
export type ProbeAction = "ok" | "increment" | "restart";

/** evaluateProbe 输入（纯数据；命令层负责把真实探测归一到这三字段）。 */
export interface EvaluateProbeInput {
  /**
   * 本轮探测的 HTTP 状态码：0 = 无响应（连接拒绝/超时等一切未拿到 HTTP 应答的
   * 失败）；非 0 = 收到 HTTP 应答——任意状态码（含 401/500）都证明事件循环活着
   * （dsh 原型口径；体级异常的分类留痕归命令层 stderr，不参与重启判定）。
   */
  httpCode: number;
  /** 上一轮累计的连续无响应次数（计数文件读数；≥0）。 */
  prevFails: number;
  /** 宽限期内（不探测）：ok 且计数原样保留，不计数不清零（dsh 原型同语义）。 */
  graceActive: boolean;
}

/** 探测裁决（R-sv1 输出形态 + atMs 时间戳供结构化日志）。 */
export interface ProbeVerdict {
  action: ProbeAction;
  /**
   * 本轮应落盘的计数：0 = 应清除计数文件；>0 = 应写入该值。
   * 宽限期跳过时原样回传 prevFails（命令层对应"不动计数文件"）。
   */
  fails: number;
  /** 评估时刻（入参 now 透传；stderr/journal 结构化行取时用）。 */
  atMs: number;
}

function requireNonNegativeInt(field: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new BridgeError(
      "WATCHDOG_INPUT_INVALID",
      `${field} 必须为非负整数，实际为 ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * watchdog 探测裁决（R-sv1 纯函数）：
 * - graceActive → ok（计数原样）：宽限期不探测、不动计数（含既有计数不清零，
 *   对齐 dsh 原型"宽限期内直接退出"）；
 * - httpCode > 0 → ok 且计数清零：有应答 = 事件循环存活；
 * - httpCode = 0 → fails = prevFails + 1：达到阈值 → restart（计数清零，重启后
 *   重新累计）；未达阈值 → increment（落盘新计数，等下一轮）。
 */
export function evaluateProbe(input: EvaluateProbeInput, now: number): ProbeVerdict {
  const httpCode = requireNonNegativeInt("httpCode", input.httpCode);
  const prevFails = requireNonNegativeInt("prevFails", input.prevFails);
  if (!Number.isFinite(now)) {
    throw new BridgeError("WATCHDOG_INPUT_INVALID", `now 必须为有限数字，实际为 ${JSON.stringify(now)}`);
  }
  if (input.graceActive) {
    return { action: "ok", fails: prevFails, atMs: now };
  }
  if (httpCode > 0) {
    return { action: "ok", fails: 0, atMs: now };
  }
  const fails = prevFails + 1;
  if (fails >= WATCHDOG_FAIL_THRESHOLD) {
    return { action: "restart", fails: 0, atMs: now };
  }
  return { action: "increment", fails, atMs: now };
}
