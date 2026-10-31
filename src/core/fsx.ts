/**
 * codearts-bridge 文件原语（T1-03 起；R-b 主控裁定：fsx 提前）。
 *
 * T1-03：`sha256File`（node:crypto 流式哈希）；
 * T1-04（R-fx1/R-fx2）：`sameDevice`（st_dev 比较）/ `atomicWriteFile`（同目录
 * tmp+rename）/ `copyDeploy`（同目录 tmp 写全 + fsync + rename 的原子替换部署）。
 * 全仓库只允许这一处文件哈希实现，禁止任何调用方自带第二份哈希逻辑
 * （裁定 R-b：禁止哈希两处重复实现）。
 *
 * 错误纪律（禁静默兜底）：任何读取失败（含 ENOENT）都显式抛
 * BridgeError("FS_READ_FAILED")，消息含路径与原因码，原始错误挂 cause。
 * ENOENT 的"缺失属正常态"语义由调用方（如 probeInstall 的 stat 预检）负责，
 * 本原语不代判——哈希目标理应存在，读不到就是异常。
 *
 * 写侧错误纪律（T1-04）：写/改名/同步失败统一抛 BridgeError("FS_WRITE_FAILED")，
 * 消息含操作、源/目标路径与 errno 原因码；失败时目标文件保持旧内容原位、
 * 本函数创建的临时件一律清理（R-fx1：失败时旧文件原位、临时件清理）。
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open as fsOpen, chmod, rename, rm, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import * as path from "node:path";
import { BridgeError } from "./errors";

/** 从错误对象提取 errno 形态的 code（如 ENOENT/EACCES）；无则 undefined。 */
export function errnoOf(e: unknown): string | undefined {
  if (typeof e === "object" && e !== null && "code" in e) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * 流式计算文件 SHA-256（十六进制小写，64 位）。
 *
 * 流式而非整读：安装二进制可达数十 MB，避免一次性载入内存；
 * node:crypto createHash 按 chunk 喂入，与 `sha256sum` 结果一致。
 */
export async function sha256File(filePath: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", (e: unknown) => {
      const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
      reject(
        new BridgeError("FS_READ_FAILED", `读取文件失败：path=${filePath} reason=${reason}`, {
          cause: e,
        }),
      );
    });
    stream.on("data", (chunk: unknown) => {
      hash.update(chunk as Buffer);
    });
    stream.on("end", () => {
      resolve(hash.digest("hex"));
    });
  });
}

/* ───── 写侧原语（T1-04，R-fx1/R-fx2） ───── */

/** 统一写侧错误出口：保原因码（errno）与原始错误 cause。 */
function writeError(operation: string, detail: string, e: unknown): BridgeError {
  const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
  return new BridgeError("FS_WRITE_FAILED", `${operation}失败：${detail} reason=${reason}`, {
    cause: e,
  });
}

/** 失败路径的临时件清理（尽力而为）：主错误照常上抛，此处只负责不留垃圾件。 */
async function cleanupTmp(tmpPath: string): Promise<void> {
  await rm(tmpPath, { force: true }).catch(() => undefined);
}

/**
 * st_dev 比较（任务书接口：sameDevice）。两个路径都必须存在——
 * 不存在的路径无法给出设备号，显式报错（禁止静默假定同/异设备）。
 * 用途：T1-05 升级暂存目录选址（暂存与 bin 必须同文件系统才能安全 rename）。
 */
export async function sameDevice(a: string, b: string): Promise<boolean> {
  const statOne = async (p: string): Promise<{ dev: number }> => {
    try {
      return await stat(p);
    } catch (e) {
      const reason = errnoOf(e) ?? (e instanceof Error ? e.name : "UNKNOWN");
      throw new BridgeError("FS_STAT_FAILED", `stat 失败：path=${p} reason=${reason}`, {
        cause: e,
      });
    }
  };
  const [sa, sb] = await Promise.all([statOne(a), statOne(b)]);
  return sa.dev === sb.dev;
}

/**
 * 原子写文件（R-fx2）：同目录 `.<名>.atomic-tmp-<rand>` 写全 + fsync + rename。
 *
 * - 支持 `string`（UTF-8）与 `Uint8Array` 两种载荷；
 * - `mode` 可选：给定则显式 chmod（umask 无关）；未给定则沿用创建掩码产生的常规权限；
 * - 崩溃/失败中断时目标文件保持原状（目标只经同目录 rename 变更，绝无半写）；
 *   失败路径清理本函数创建的临时件。
 */
export async function atomicWriteFile(p: string, data: string | Uint8Array, mode?: number): Promise<void> {
  const tmpPath = path.join(
    path.dirname(p),
    `.${path.basename(p)}.atomic-tmp-${randomBytes(6).toString("hex")}`,
  );
  try {
    const fh = await fsOpen(tmpPath, "wx", 0o644); // wx：独占创建，防误伤同名件
    try {
      await fh.writeFile(data); // string 按 UTF-8 编码
      await fh.sync(); // 落盘后 rename（裁定 R-fx2/R-fx1 同机制）
      if (mode !== undefined) await fh.chmod(mode); // 显式 chmod，umask 无关
    } finally {
      await fh.close();
    }
    await rename(tmpPath, p); // 同目录同文件系统，原子替换
  } catch (e) {
    await cleanupTmp(tmpPath);
    throw writeError("原子写文件", `path=${p}`, e);
  }
}

/**
 * copy 部署（R-fx1 原子替换语义）：目标文件要么是旧内容要么是新内容，绝无半写。
 *
 * 机制（主控裁定 R-fx1）：同目录 `.<名>.deploy-tmp-<rand>` 流式写全（不从 src
 * 整读入内存——安装二进制可达数十 MB）→ fsync → 显式 chmod → rename。
 * rename 发生在同目录（同文件系统），天然满足"禁止跨文件系统 rename"约束。
 *
 * - `mode` 默认 0o755（二进制部署惯例），显式 chmod 与 umask 无关；
 * - 失败时旧文件原位、临时件清理、错误显式上抛（含 src/dst 与 errno）。
 */
export async function copyDeploy(src: string, dst: string, mode = 0o755): Promise<void> {
  const tmpPath = path.join(
    path.dirname(dst),
    `.${path.basename(dst)}.deploy-tmp-${randomBytes(6).toString("hex")}`,
  );
  try {
    // 流式拷贝：src → 同目录 tmp（wx 独占创建）
    await pipeline(createReadStream(src), createWriteStream(tmpPath, { flags: "wx" }));
    await chmod(tmpPath, mode); // 显式 chmod（裁定：mode 默认 755，chmod 显式）
    const fh = await fsOpen(tmpPath, "r+");
    try {
      await fh.sync(); // 数据落盘后再 rename（裁定 R-fx1）
    } finally {
      await fh.close();
    }
    await rename(tmpPath, dst); // 原子替换：目标要么旧内容要么新内容
  } catch (e) {
    await cleanupTmp(tmpPath);
    throw writeError("copy 部署", `src=${src} dst=${dst}`, e);
  }
}

/**
 * 目录 fsync（T1-05，R-up6）：把目录项变更（部署/备份的 rename）冲刷到磁盘。
 *
 * 用途：升级部署完成 rename 后，对 `<installDir>/bin`（及脚本所在 `<installDir>`）
 * 做目录级 fsync——文件内容已由 copyDeploy 的 fh.sync() 落盘，目录项（文件名→inode
 * 映射）则依赖所在目录的 fsync 才能保证崩溃后仍可见。
 *
 * 机制：只读打开目录 fd（Linux 允许 O_RDONLY 打开目录）→ fsync → close。
 * 失败显式抛 BridgeError("FS_WRITE_FAILED")（裁定 R-up6：失败显式报错，禁静默）。
 */
export async function fsyncDir(dir: string): Promise<void> {
  let fh: FileHandle | undefined;
  try {
    fh = await fsOpen(dir, "r");
    await fh.sync();
  } catch (e) {
    throw writeError("目录 fsync", `dir=${dir}`, e);
  } finally {
    await fh?.close().catch(() => undefined); // 关闭失败不掩盖主错误（仅资源回收）
  }
}
