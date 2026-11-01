/**
 * codearts-bridge 受控升级（T1-05，R-up1：独立新文件，install.ts 仅共享导出）。
 *
 * 职责（主控裁定 R-up2..R-up9）：把 codearts CLI 升级做成"失败零损坏"的受控流程。
 *
 * 背景事故（本任务直接动因）：厂商升级流程"先改名（codearts→codearts.delete）后部署"，
 * 部署失败会静默遗留 .delete 残局；跨 ZFS 数据集 rename 必失败（EXDEV 实测）。
 * 本实现反其道而行：
 * - 全程不改动现有安装，唯一的破坏性动作是最后一步 copyDeploy 的同目录原子 rename
 *   （目标要么旧内容要么新内容，R-fx1 语义）；任何更早的失败都零损坏；
 * - 暂存目录固定 `<stateDir>/tmp/staging-<version>`（R-up2），创建后立即断言与
 *   `<installDir>/bin` 同文件系统（st_dev），跨设备显式拒绝（STAGING_CROSS_DEVICE），
 *   不动现有安装——断言特意前置到下载之前（仍是裁定要求的"部署前"，且免去
 *   白白下载数十 MB 后才失败的浪费）；
 * - single-flight（R-up4）：进程内并发第二个 upgrade → ALREADY_RUNNING；
 * - 包布局识别最小规则（R-up5）：候选 `bin/codearts`、`agentkernel`、`codearts`
 *   中首个 ELF 魔数（\x7fELF）常规文件；全无 → PACKAGE_LAYOUT_INVALID。
 *   可选脚本 = 提取根目录名为 codearts 且以 #! 开头的文件（存在则一并部署到
 *   `<installDir>/codearts`；不存在不算错）；
 * - 部署顺序：可选脚本先、二进制后——最后一步才动关键件，脚本部署失败时旧二进制
 *   原位不动（零损坏面只收不放）；
 * - 旧版转备份（R-up9）在复验通过之后才落地：部署前先把旧二进制快照进暂存
 *   （同数据集 copy），复验通过再 copyDeploy 成 `codearts.bak-<旧版本>`——
 *   升级失败的运行绝不在 binDir 留下任何新文件；
 * - 审计事件族（spec §8 / 修复环 I1）：install.jsonl 单一审计流（与 repair/ensure-backup
 *   共用）写全 upgrade{start,step,fail,done}——start 在 single-flight 置位后立即写
 *   （auditId/请求版本/安装落点；release 实际版本由紧随的 release 步骤承载）；
 *   任何失败在 rethrow 前写 fail（code/step/回滚细节），原错误语义不变；
 *   最终 done 含 from/to/hash/auditId。
 * - 复验失败回滚（修复环 I2）：复验不过时破坏性 rename 已发生（旧二进制已被覆盖，
 *   首次升级又无历史备份）——先按 <staging>/old-codearts 快照回滚 binPath 再抛
 *   UPGRADE_VERIFY_FAILED（无旧安装则移除新部署件）；回滚失败保留暂存与快照
 *   （fail 审计含 snapshotPath 供人工恢复），维持"失败不在 binDir 留新文件"。
 *
 * 钉版说明：R-up9 收尾语义不含 pinned.json 回写——升级后 pinState 以 drift 口径
 * 如实呈现"已钉但不一致"，是否重钉属调用方策略，本文件不写钉版记录。
 *
 * 与任务书的偏差（主控裁定覆盖，均为显式登记）：
 * - 升级逻辑落本新文件（R-up1），任务书 Files 栏"Modify: src/core/install.ts"
 *   仅保留共享导出调整（export statOrEnoent/detectVersion/appendInstallAudit）；
 * - deps 增列可选 extract 注入（R-up8：可注入解压，缺省 defaultExtract）。
 *
 * 网络边界（R-up7）：唯一允许联网的是 httpFetcher（官方 release-info 与 OBS 下载）；
 * 测试一律注入 fake，绝不联网。
 */
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import { chmod, open as fsOpen, mkdir, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import * as path from "node:path";
import type { BridgeConfig } from "./config";
import { ensureStateDirs } from "./config";
import { BridgeError } from "./errors";
import { copyDeploy, errnoOf, fsyncDir, sameDevice, sha256File } from "./fsx";
import {
  appendInstallAudit,
  binPathOf,
  detectVersion,
  probeInstall,
  statOrEnoent,
  type Exec,
  type ExecResult,
} from "./install";

/* ───── Release 与 Fetcher（R-up7） ───── */

/** 官方 release-info 接口字段（R-up7）。 */
export interface Release {
  version: string;
  url: string;
  hash: string;
}

/**
 * 升级物料获取抽象（R-up7）：latest 取最新版本清单，download 拉取安装包到 dest。
 * 测试注入 fake（绝不联网）；生产用 httpFetcher。
 */
export interface Fetcher {
  latest(): Promise<Release>;
  download(url: string, dest: string): Promise<void>;
}

/**
 * 官方 release-info 地址（R-up7 主控裁定固定值）。
 * 响应实测形状（2026-10 官方接入）：`{"result":{"version":"26.11.0","url":"<obs>","hash":"<sha256>"}}`。
 */
const RELEASE_INFO_URL =
  "https://ide.cn-north-4.myhuaweicloud.com/v1/release-info/latest" +
  "?sub_product_name=cli-linux-x64&os_type=debian&arch=X86-64";

const SHA256_HEX_RE = /^[0-9a-fA-F]{64}$/;

/** 校验 release-info 响应形状（禁静默兜底：任何字段缺失/类型非法都显式报错）。 */
function parseRelease(raw: unknown): Release {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new BridgeError("RELEASE_INVALID", `release-info 响应顶层须为 JSON 对象`);
  }
  const result = (raw as Record<string, unknown>)["result"];
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new BridgeError("RELEASE_INVALID", `release-info 响应缺少 result 对象（实测形状 {result:{version,url,hash}}）`);
  }
  const record = result as Record<string, unknown>;
  const version = record["version"];
  const url = record["url"];
  const hash = record["hash"];
  if (typeof version !== "string" || version.length === 0) {
    throw new BridgeError("RELEASE_INVALID", `release-info 的 result.version 缺失或非字符串`);
  }
  if (typeof url !== "string" || url.length === 0) {
    throw new BridgeError("RELEASE_INVALID", `release-info 的 result.url 缺失或非字符串`);
  }
  if (typeof hash !== "string" || !SHA256_HEX_RE.test(hash)) {
    throw new BridgeError("RELEASE_INVALID", `release-info 的 result.hash 须为 64 位十六进制 sha256`);
  }
  return { version, url, hash: hash.toLowerCase() };
}

/** 真实 Fetcher（R-up7）：官方 release-info + OBS 下载（流式落盘，不整读入内存）。 */
export const httpFetcher: Fetcher = {
  async latest(): Promise<Release> {
    let res: Response;
    try {
      res = await fetch(RELEASE_INFO_URL);
    } catch (e) {
      const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
      throw new BridgeError("RELEASE_INFO_FAILED", `release-info 请求失败：url=${RELEASE_INFO_URL} reason=${reason}`, {
        remediation: "检查网络连通性后重试；官方接入/升级入口：https://codearts.huaweicloud.com/portal/settings/cli-auth",
        cause: e,
      });
    }
    if (!res.ok) {
      throw new BridgeError("RELEASE_INFO_FAILED", `release-info 请求失败：HTTP ${res.status} url=${RELEASE_INFO_URL}`, {
        remediation: "服务端返回非 2xx：稍后重试；持续失败请核查官方服务状态",
      });
    }
    let raw: unknown;
    try {
      raw = await res.json();
    } catch (e) {
      throw new BridgeError("RELEASE_INVALID", `release-info 响应非合法 JSON`, { cause: e });
    }
    return parseRelease(raw);
  },

  async download(url: string, dest: string): Promise<void> {
    let res: Response;
    try {
      res = await fetch(url);
    } catch (e) {
      const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
      throw new BridgeError("DOWNLOAD_FAILED", `安装包下载失败：url=${url} reason=${reason}`, {
        remediation: "检查网络连通性后重试升级",
        cause: e,
      });
    }
    if (!res.ok || res.body === null) {
      throw new BridgeError("DOWNLOAD_FAILED", `安装包下载失败：HTTP ${res.status} url=${url}`, {
        remediation: "服务端返回非 2xx：稍后重试；持续失败请核查官方下载源",
      });
    }
    try {
      // 流式落盘（安装包可达数十 MB，禁止整读入内存）；dest 位于本轮新建的暂存目录内
      await pipeline(
        Readable.fromWeb(res.body as unknown as NodeWebReadableStream<Uint8Array>),
        createWriteStream(dest, { flags: "wx" }),
      );
    } catch (e) {
      await rm(dest, { force: true }).catch(() => undefined); // 失败路径不留半写包体（尽力清理，主错误照常上抛）
      const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
      throw new BridgeError("DOWNLOAD_FAILED", `安装包写入失败：dest=${dest} reason=${reason}`, { cause: e });
    }
  },
};

/* ───── 解压（R-up8：可注入，缺省本地 tar -xzf 经注入 Exec 离线执行） ───── */

/**
 * 默认解压器：`tar -xzf <package> -C <destDir>`（经注入 Exec，离线）。
 * 独立导出供专项测试（真实 fixture tar + 真实 tar 进程）与调用方复用。
 *
 * - 退出码非 0 → BridgeError(EXTRACT_FAILED)（stderr 摘要限长 400 字符，仅防日志超长）；
 * - exec 抛错（tar 缺失等 spawn 层失败）→ 同样收敛为 EXTRACT_FAILED（cause 保留）。
 */
export async function defaultExtract(exec: Exec, packagePath: string, destDir: string): Promise<void> {
  let result: ExecResult;
  try {
    result = await exec.run(["tar", "-xzf", packagePath, "-C", destDir]);
  } catch (e) {
    const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
    throw new BridgeError(
      "EXTRACT_FAILED",
      `tar 执行失败：package=${packagePath} reason=${reason}`,
      { remediation: "tar 不可用或包不可读：确认系统 tar 与安装包完整性后重试", cause: e },
    );
  }
  if (result.code !== 0) {
    throw new BridgeError(
      "EXTRACT_FAILED",
      `tar 解压失败：package=${packagePath} code=${result.code} stderr=${result.stderr.slice(0, 400)}`,
      { remediation: "安装包缺失/损坏或格式不受支持（默认仅支持 gzip tar）：确认下载完整性后重试升级" },
    );
  }
}

/**
 * 解压后补执行位（26.10.13 官方包实测：包内二进制无 +x 位，直接探测 EACCES）。
 * 候选路径存在才 chmod 0755；不存在静默跳过（布局识别自会处理缺失候选）。
 */
async function ensureExecBits(destDir: string, relpaths: readonly string[]): Promise<void> {
  for (const rel of relpaths) {
    const target = path.join(destDir, rel);
    try {
      await chmod(target, 0o755);
    } catch (e) {
      const code = errnoOf(e);
      if (code !== "ENOENT") {
        throw new BridgeError("FS_CHMOD_FAILED", `补执行位失败：path=${target} reason=${code}`, {
          remediation: "检查暂存目录权限与文件系统",
          cause: e,
        });
      }
    }
  }
}

/* ───── 包布局识别（R-up5） ───── */

/** 候选二进制相对路径（按优先级取首个 ELF 魔数常规文件）。 */
const CANDIDATE_BIN_RELPATHS = ["bin/codearts", "agentkernel", "codearts"] as const;

/** 可选脚本名（提取根目录；#! 开头文本件 → 一并部署到 <installDir>/codearts）。 */
const SCRIPT_NAME = "codearts";

/** ELF 魔数 \x7fELF。 */
const ELF_MAGIC = [0x7f, 0x45, 0x4c, 0x46] as const;

/** 读取文件头部字节并与魔数比较；读取失败显式抛 FS_READ_FAILED（禁静默当 false）。 */
async function fileStartsWith(target: string, magic: readonly number[]): Promise<boolean> {
  let fh: FileHandle | undefined;
  try {
    fh = await fsOpen(target, "r");
    const buf = new Uint8Array(magic.length);
    const read = await fh.read(buf, 0, magic.length, 0);
    if (read.bytesRead < magic.length) return false; // 文件比魔数还短：不可能匹配（显式事实，非兜底）
    return magic.every((byte, i) => buf[i] === byte);
  } catch (e) {
    const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
    throw new BridgeError("FS_READ_FAILED", `读取文件头失败：path=${target} reason=${reason}`, { cause: e });
  } finally {
    await fh?.close().catch(() => undefined); // 关闭失败不掩盖主错误（仅资源回收）
  }
}

/** 布局识别结果：新二进制路径 + 内容哈希 + 可选脚本路径。 */
interface PackageLayout {
  newBinPath: string;
  newBinSha256: string;
  scriptPath?: string;
}

/**
 * 布局识别（R-up5）：候选中首个 ELF 魔数常规文件为新二进制；根目录 codearts
 * 若存在、是常规文件、非二进制本身且以 #! 开头则为可选脚本。全无 ELF →
 * BridgeError(PACKAGE_LAYOUT_INVALID)（消息列出候选与提取目录）。
 */
async function identifyLayout(extractDir: string): Promise<PackageLayout> {
  let newBinPath: string | undefined;
  for (const rel of CANDIDATE_BIN_RELPATHS) {
    const candidate = path.join(extractDir, rel);
    const st = await statOrEnoent(candidate);
    if (st === undefined || !st.isFile()) continue;
    if (await fileStartsWith(candidate, ELF_MAGIC)) {
      newBinPath = candidate;
      break;
    }
  }
  if (newBinPath === undefined) {
    throw new BridgeError("PACKAGE_LAYOUT_INVALID", `安装包布局无效：${extractDir} 下候选 ${CANDIDATE_BIN_RELPATHS.join(" / ")} 均非 ELF 常规文件`, {
      remediation: "确认安装包来源与内容后重试；若包由官方下发仍报此错，请连同审计 install.jsonl 上报",
    });
  }
  // 可选脚本（不存在不算错，R-up5）：仅提取根目录的 codearts；若它就是二进制本身则不重复对待
  let scriptPath: string | undefined;
  const scriptCandidate = path.join(extractDir, SCRIPT_NAME);
  if (scriptCandidate !== newBinPath) {
    const st = await statOrEnoent(scriptCandidate);
    if (st !== undefined && st.isFile() && (await fileStartsWith(scriptCandidate, [0x23, 0x21]))) {
      scriptPath = scriptCandidate; // 0x23 0x21 = "#!"
    }
  }
  return { newBinPath, newBinSha256: await sha256File(newBinPath), scriptPath };
}

/* ───── upgradeInstall（R-up9 受控流程） ───── */

/** 升级结果（任务书接口契约）。 */
export interface UpgradeResult {
  /** 旧版本（旧二进制可解析版本；不可解析="unknown"；无旧安装="none"）。 */
  from: string;
  /** 新版本（= Release.version）。 */
  to: string;
  /** 部署后二进制 sha256（复验通过值）。 */
  sha256: string;
  /** 本轮暂存目录路径（成功/失败后均已清理；字段为审计回溯用途）。 */
  stagingDir: string;
  /** 审计关联 ID（upg-<时间戳>-<随机短码>，贯穿步骤级审计与最终 upgrade.done）。 */
  auditId: string;
}

/** upgradeInstall 可注入依赖（任务书接口 + R-up8 可选 extract）。 */
export interface UpgradeDeps {
  /** 缺省 httpFetcher（真实网络）；测试注入 fake（绝不联网）。 */
  fetcher?: Fetcher;
  /** 命令执行抽象（自检/复验 --version 与默认解压 tar 均经它，测试注入 fake）。 */
  exec: Exec;
  /** 可选解压注入（R-up8）；缺省 defaultExtract（tar -xzf）。 */
  extract?: (packagePath: string, destDir: string) => Promise<void>;
}

/** single-flight 标志（R-up4）：进程内同一时刻至多一个升级。多进程互斥属 T3-04 状态层职责。 */
let upgradeInFlight = false;

/** auditId 形如 upg-<epoch 毫秒>-<6 位随机十六进制>（与 repair 的 rep- 前缀区分动作族）。 */
function newUpgradeAuditId(): string {
  return `upg-${Date.now()}-${randomBytes(3).toString("hex")}`;
}

/** 步骤级审计（R-up9）：kind=upgrade.step，追加到与 repair/ensure-backup 同一 install.jsonl。 */
async function auditStep(
  cfg: BridgeConfig,
  auditId: string,
  step: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  await appendInstallAudit(cfg, { ts: new Date().toISOString(), auditId, kind: "upgrade.step", step, ...fields });
}

/**
 * 受控升级（R-up9 成功路径）：
 * 下载 → 哈希校验 → 解压 → 新二进制 --version 自检 → 同数据集暂存（断言前置到
 * 下载前，见头注）→ copyDeploy（可选脚本先、二进制后）→ 复验（哈希+版本）→
 * 旧版转备份（复验通过后才在 binDir 落地）→ fsyncDir → 审计 upgrade.done → 返回。
 *
 * 失败分支（全部显式、零损坏——唯一破坏性动作是最后一步的原子 rename）：
 * - 并发第二个升级 → ALREADY_RUNNING（R-up4）；
 * - opts.version 与 latest 不符 → RELEASE_VERSION_MISMATCH；
 * - 暂存与 <installDir>/bin 异设备 → STAGING_CROSS_DEVICE，不动现有安装（R-up2）；
 * - 包哈希与清单不符 → HASH_MISMATCH（R-up3）；
 * - 解压失败 → EXTRACT_FAILED（注入实现抛出的 BridgeError 原样透传）（R-up3/R-up8）；
 * - 布局无 ELF 候选 → PACKAGE_LAYOUT_INVALID（R-up5）；
 * - 新二进制不可执行/版本不可解析 → PACKAGE_BINARY_INVALID；版本与清单不符 →
 *   PACKAGE_VERSION_MISMATCH（R-up9 自检）；
 * - 部署/备份写失败 → FS_WRITE_FAILED（copyDeploy 原子语义：旧文件原位，R-fx1）；
 * - 部署后复验不过 → UPGRADE_VERIFY_FAILED（不谎报成功；修复环 I2：先按暂存
 *   旧版快照回滚 binPath 再抛——回滚失败则保留暂存与快照供人工恢复）。
 *
 * 失败运行的清理：暂存目录在 finally 中尽力回收（含临时件；T1-04 cleanupTmp 同款
 * 纪律——主错误照常上抛，清理失败不掩盖主错误；回滚失败时改保留暂存，见 verify 块）；
 * binDir 在部署步骤之前绝无写入，部署中断时旧二进制逐字节原位（R-up3 零损坏矩阵），
 * 复验失败经回滚恢复旧内容（I2）。
 */
export async function upgradeInstall(
  cfg: BridgeConfig,
  deps: UpgradeDeps,
  opts: { version?: string } = {},
): Promise<UpgradeResult> {
  // R-up4 single-flight：同步检查并置位（async 函数体首个 await 前同步执行，窗口确定）
  if (upgradeInFlight) {
    throw new BridgeError("ALREADY_RUNNING", "已有升级在执行中（single-flight，同一时刻至多一个）", {
      remediation: "等待当前升级结束（查审计 install.jsonl 的 upgrade.step/upgrade.done）后重试",
    });
  }
  upgradeInFlight = true;

  const fetcher = deps.fetcher ?? httpFetcher;
  const binPath = binPathOf(cfg.installDir);
  const binDir = path.dirname(binPath);
  const auditId = newUpgradeAuditId();
  let ownsStaging = false;
  let stagingDir = "";
  // 修复环 I1：失败终态审计的定位字段——step 追踪当前阶段，failExtra 承载复验回滚
  // 细节（唯一写入点见 verify 块），二者在 catch 中并入该轮唯一的 upgrade.fail 事件。
  let step = "start";
  let failExtra: Record<string, unknown> = {};

  try {
    await ensureStateDirs(cfg); // tmp/ 与 audit/ 就绪（0700）

    // 0) upgrade.start（修复环 I1/spec §8）：single-flight 置位成功后立即写。
    //    此时尚未发起任何网络调用（release 实际版本不可知，禁为审计提前联网），
    //    请求版本与安装落点先行入账；实际版本由紧随其后的 release 步骤审计承载。
    await appendInstallAudit(cfg, {
      ts: new Date().toISOString(),
      auditId,
      kind: "upgrade.start",
      installDir: cfg.installDir,
      requestedVersion: opts.version ?? null,
    });

    // 1) 旧版状态采集（零损坏基线，先于任何外部调用与写入）
    const oldStat = await statOrEnoent(binPath);
    const oldPresent = oldStat !== undefined && oldStat.isFile() && oldStat.size > 0;
    const oldSha256 = oldPresent ? await sha256File(binPath) : undefined; // 进入审计，供事后对账
    const oldVersion = oldPresent ? await detectVersion(deps.exec, binPath) : undefined;
    const from = oldPresent ? (oldVersion ?? "unknown") : "none";

    // 2) 版本清单（R-up7）；opts.version 指定时不符即显式报错（禁静默改拉 latest）
    step = "release";
    const release = await fetcher.latest();
    if (opts.version !== undefined && release.version !== opts.version) {
      throw new BridgeError(
        "RELEASE_VERSION_MISMATCH",
        `最新版本（${release.version}）与请求版本（${opts.version}）不符`,
        { remediation: "官方 latest 渠道仅提供最新版：等待目标版本成为 latest，或去除 version 参数升级到最新" },
      );
    }
    await auditStep(cfg, auditId, "release", {
      from,
      oldSha256,
      version: release.version,
      url: release.url,
    });

    step = "staging";
    // 3) 暂存准备 + 同数据集断言（R-up2；固定命名，残留先清后建）
    //    断言前置到下载之前（仍满足裁定"部署前"，免浪费下载）；binDir 不存在时
    //    sameDevice 显式报 FS_STAT_FAILED——无法证实同数据集即拒绝执行。
    stagingDir = path.join(cfg.stateDir, "tmp", `staging-${release.version}`);
    await rm(stagingDir, { recursive: true, force: true });
    await mkdir(stagingDir, { recursive: true, mode: 0o700 });
    ownsStaging = true; // 之后任何出口都由 finally 回收本轮暂存
    if (!(await sameDevice(stagingDir, binDir))) {
      throw new BridgeError(
        "STAGING_CROSS_DEVICE",
        `暂存目录与安装目录不在同一文件系统：staging=${stagingDir} binDir=${binDir}`,
        {
          remediation:
            "跨文件系统 rename 必失败（EXDEV 实测）：为 stateDir 与 installDir 配置同一数据集下的路径后重试",
        },
      );
    }
    await auditStep(cfg, auditId, "staging", { stagingDir, sameDevice: true });

    step = "download";
    // 4) 下载（R-up7）：包体落在暂存目录内
    const packagePath = path.join(stagingDir, "package.tar.gz");
    await fetcher.download(release.url, packagePath);
    await auditStep(cfg, auditId, "download", { packagePath, url: release.url });

    step = "hash";
    // 5) 哈希校验（R-up3）：内容身份闸门，不过即整体失败（现有安装从未被触碰）
    const packageSha256 = await sha256File(packagePath);
    if (packageSha256 !== release.hash) {
      throw new BridgeError(
        "HASH_MISMATCH",
        `安装包 sha256 与官方清单不符：expected=${release.hash} actual=${packageSha256} package=${packagePath}`,
        { remediation: "重试升级；若复现，下载链路可能被劫持，请核查网络与官方下载源后上报" },
      );
    }
    await auditStep(cfg, auditId, "hash", { sha256: packageSha256 });

    step = "extract";
    // 6) 解压（R-up8）：注入实现优先，缺省 tar -xzf；注入抛出的 BridgeError 原样透传
    const extractDir = path.join(stagingDir, "extracted");
    await mkdir(extractDir, { recursive: true });
    try {
      if (deps.extract !== undefined) {
        await deps.extract(packagePath, extractDir);
      } else {
        await defaultExtract(deps.exec, packagePath, extractDir);
        await ensureExecBits(extractDir, CANDIDATE_BIN_RELPATHS);
      }
    } catch (e) {
      if (e instanceof BridgeError) throw e;
      throw new BridgeError(
        "EXTRACT_FAILED",
        `解压失败：package=${packagePath} reason=${e instanceof Error ? e.message : String(e)}`,
        { remediation: "安装包损坏或格式不受支持：确认下载完整性后重试升级", cause: e },
      );
    }
    await auditStep(cfg, auditId, "extract", { extractDir });

    step = "layout";
    // 7) 布局识别（R-up5）+ 新二进制自检（R-up9）：先验货，后动手
    const layout = await identifyLayout(extractDir);
    await auditStep(cfg, auditId, "layout", {
      bin: path.relative(extractDir, layout.newBinPath),
      script: layout.scriptPath !== undefined,
    });

    step = "self-check";
    // 官方入口优先（26.10.13+ 新架构实测）：agentkernel 为引擎核心、codearts 为
    // 环境 wrapper（设 LD/内核参数后 exec 引擎）。直接探测 agentkernel 会因缺
    // wrapper 环境失败（PACKAGE_BINARY_INVALID 实测）——有 wrapper 探 wrapper。
    // 自检顺序：引擎本体（chmod 后）→ wrapper（staging 无部署布局，wrapper 大概率失败，仅末位尝试）
    let newVersion = await detectVersion(deps.exec, layout.newBinPath);
    if (newVersion === undefined && layout.scriptPath !== undefined) {
      newVersion = await detectVersion(deps.exec, layout.scriptPath);
    }
    if (newVersion === undefined) {
      throw new BridgeError(
        "PACKAGE_BINARY_INVALID",
        `新二进制自检失败（--version 不可执行或版本不可解析）：bin=${layout.newBinPath}`,
        { remediation: "安装包内容异常：确认来源后重试；若官方包复现请连同审计上报" },
      );
    }
    if (newVersion !== release.version) {
      throw new BridgeError(
        "PACKAGE_VERSION_MISMATCH",
        `新二进制自检版本（${newVersion}）与清单版本（${release.version}）不符：bin=${layout.newBinPath}`,
        { remediation: "安装包与版本清单不一致：重试升级；复现请连同审计上报" },
      );
    }
    await auditStep(cfg, auditId, "self-check", { version: newVersion });

    step = "deploy";
    // 8) 部署（R-up6 copyDeploy 原子替换；R-up9 顺序：脚本先、二进制后——
    //    最后一步才动关键件；旧版快照此刻进暂存，备份实体等复验通过再落地）。
    //    修复环 I2：快照条件放宽为 oldPresent（不再要求版本可读）——否则 from=unknown
    //    场景复验失败时无快照可回滚，旧版内容随破坏性 rename 彻底丢失。
    const oldSnapshot = oldPresent ? path.join(stagingDir, "old-codearts") : undefined;
    if (oldSnapshot !== undefined) {
      await copyDeploy(binPath, oldSnapshot, 0o755); // 同数据集（staging 已断言）
    }
    if (layout.scriptPath !== undefined) {
      await copyDeploy(layout.scriptPath, path.join(cfg.installDir, SCRIPT_NAME), 0o755);
    }
    await copyDeploy(layout.newBinPath, binPath, 0o755);
    await auditStep(cfg, auditId, "deploy", { script: layout.scriptPath !== undefined });

    // 9) 复验（哈希+版本，R-up9）：不过即 UPGRADE_VERIFY_FAILED，绝不谎报成功。
    //    修复环 I2（裁定①②③）：复验失败先回滚再抛——此时破坏性 rename 已发生
    //    （旧二进制已被覆盖，首次升级无历史备份时直接失败将令旧版不可恢复）：
    //    - 有快照：copyDeploy(<staging>/old-codearts, binPath) 恢复旧内容；
    //    - 无快照（from=none）：部署前 binPath 不存在，回滚=移除新部署件
    //      （维持"失败不在 binDir 留新文件"前提）；
    //    - 回滚成功 → fail 审计 rolledBack:true、暂存照常清理；回滚失败 → 暂存与
    //      快照一并保留（ownsStaging 置 false），fail 审计与 remediation 携带
    //      snapshotPath 供人工恢复。错误码与消息保持原语义，仅 remediation 如实
    //      反映回滚状态。
    step = "verify";
    const deployedSha256 = await sha256File(binPath);
    // 复验版本同样走官方入口（wrapper 优先，与自检口径一致）
    const deployedScriptPath = path.join(cfg.installDir, SCRIPT_NAME);
    const deployedVersion = await detectVersion(
      deps.exec,
      layout.scriptPath !== undefined && existsSync(deployedScriptPath) ? deployedScriptPath : binPath,
    );
    if (deployedSha256 !== layout.newBinSha256 || deployedVersion !== release.version) {
      if (oldSnapshot !== undefined) {
        try {
          await copyDeploy(oldSnapshot, binPath, 0o755);
          failExtra = { rolledBack: true, snapshotPath: oldSnapshot };
        } catch (rbErr) {
          failExtra = {
            rolledBack: false,
            snapshotPath: oldSnapshot,
            rollbackError: errnoOf(rbErr) ?? (rbErr instanceof Error ? rbErr.name : "UNKNOWN"),
          };
        }
      } else {
        try {
          await rm(binPath, { force: true });
          failExtra = { rolledBack: true, reason: "no-snapshot" };
        } catch (rbErr) {
          failExtra = {
            rolledBack: false,
            reason: "no-snapshot",
            rollbackError: errnoOf(rbErr) ?? (rbErr instanceof Error ? rbErr.name : "UNKNOWN"),
          };
        }
      }
      const rolledBack = failExtra["rolledBack"] === true;
      if (!rolledBack) ownsStaging = false; // 回滚失败：暂存连快照一并保留（裁定③不得清理）
      throw new BridgeError(
        "UPGRADE_VERIFY_FAILED",
        `升级后复验失败：bin=${binPath} sha256 一致=${deployedSha256 === layout.newBinSha256} 版本复验=${deployedVersion ?? "undefined"} 期望=${release.version}`,
        {
          remediation: rolledBack
            ? oldSnapshot !== undefined
              ? "复验未通过，已从暂存快照回滚旧版二进制（安装目录已恢复原状）；可重试升级，或用 codearts_repair 从备份恢复"
              : "复验未通过，已移除本次新部署件（恢复升级前无二进制状态）；可重试升级"
            : oldSnapshot !== undefined
              ? `复验未通过且自动回滚失败：旧版快照保留于 ${oldSnapshot}（暂存目录未清理），请人工以该快照恢复 ${binPath} 后重试升级`
              : `复验未通过且回滚移除失败：新部署件残留于 ${binPath}，请人工移除后重试升级`,
        },
      );
    }
    await auditStep(cfg, auditId, "verify", { sha256: deployedSha256, version: deployedVersion });

    step = "backup";
    // 10) 旧版转备份（R-up9：复验通过后才在 binDir 落地；仅"旧版有效且备份缺失"时创建）。
    //     备份命名需旧版本号，版本不可读（修复环 I2 后有快照）也不落地备份——该快照
    //     服务于复验失败回滚。成功路径"备份在复验通过后才落地"顺序保持不动。
    if (oldSnapshot !== undefined && oldVersion !== undefined) {
      const backupPath = path.join(binDir, `codearts.bak-${oldVersion}`);
      const existing = await statOrEnoent(backupPath);
      if (existing === undefined) {
        await copyDeploy(oldSnapshot, backupPath, 0o755);
        await auditStep(cfg, auditId, "backup", { result: "created", backupPath });
      } else {
        await auditStep(cfg, auditId, "backup", { result: "exists", backupPath });
      }
    } else {
      // 旧版无效（缺失/空/非常规/版本不可解析）：无备份可转，显式记录原因（禁静默略过）
      await auditStep(cfg, auditId, "backup", { result: oldPresent ? "old-invalid" : "no-old-binary" });
    }

    step = "fsync";
    // 11) 目录 fsync（R-up6）：部署与备份的目录项落盘；脚本所在 <installDir> 一并
    await fsyncDir(binDir);
    if (layout.scriptPath !== undefined) {
      await fsyncDir(cfg.installDir);
    }
    await auditStep(cfg, auditId, "fsync", { binDir });

    step = "done";
    // 12) 最终审计 + 返回（R-up9：upgrade.done 含 from/to/hash/auditId）
    await appendInstallAudit(cfg, {
      ts: new Date().toISOString(),
      auditId,
      kind: "upgrade.done",
      from,
      to: release.version,
      sha256: deployedSha256,
      stagingDir,
    });
    return { from, to: release.version, sha256: deployedSha256, stagingDir, auditId };
  } catch (e) {
    // 修复环 I1：失败终态审计——任何失败在 rethrow 前写 upgrade.fail（code/step +
    // 回滚细节 failExtra，auditId 与同轮 upgrade.start 串联）。原错误原样 rethrow，
    // 不改变错误语义；审计写失败不掩盖主错误（失败路径纪律，同暂存清理）。
    await appendInstallAudit(cfg, {
      ts: new Date().toISOString(),
      auditId,
      kind: "upgrade.fail",
      code: e instanceof BridgeError ? e.code : "UNKNOWN",
      step,
      ...failExtra,
    }).catch(() => undefined);
    throw e;
  } finally {
    upgradeInFlight = false; // R-up4：成功失败都释放（finally 保证）
    if (ownsStaging) {
      // 暂存尽力回收（R-up3 临时件清理；T1-04 cleanupTmp 同纪律：清理失败不掩盖主错误）
      await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

/* ───── upgradeCli（T4-05：受控升级的"开箱"封装） ───── */

/** upgradeCli 结果：无更新（already-latest）或完整受控升级结果（语义继承 UpgradeResult）。 */
export type UpgradeCliResult =
  | { action: "already-latest"; version: string }
  | ({ action: "upgraded" } & UpgradeResult);

/**
 * codearts CLI 受控升级封装（T4-05 §D 薄封装）：
 * 1. probeInstall 探测当前安装（只读快照）；
 * 2. fetcher.latest() 取官方清单；
 * 3. 当前版本与清单一致（在场且可解析）→ already-latest，零下载零部署；
 * 4. 否则 → upgradeInstall 受控升级（锚定同一清单版本，防两次调用间清单漂移；
 *    失败零损坏语义——下载/校验/解压/自检任何失败都不触碰现有安装——完整继承）。
 *
 * 未安装（present=false）不属"无更新"：直接走受控升级完成首次安装（开箱形态）。
 * 审计由 upgradeInstall 内部落账（install.jsonl 单一审计流），本封装零额外审计。
 */
export async function upgradeCli(cfg: BridgeConfig, deps: UpgradeDeps): Promise<UpgradeCliResult> {
  const status = await probeInstall(cfg, { exec: deps.exec });
  const fetcher = deps.fetcher ?? httpFetcher;
  const release = await fetcher.latest();
  if (status.present && status.version !== undefined && status.version === release.version) {
    return { action: "already-latest", version: release.version };
  }
  const result = await upgradeInstall(cfg, deps, { version: release.version });
  return { action: "upgraded", ...result };
}
