/**
 * T1-05 受控升级测试 fixtures（fake Fetcher / 包与布局物料 / content-driven exec / 本地 ustar 构建）。
 *
 * 纪律（主控裁定 + 隔离沿用 R-e）：
 * - 测试绝不联网：Fetcher 全部注入 fake（R-up7）；
 * - 测试绝不真跑 codearts 二进制：exec 注入"按目标文件内容回答 --version"的
 *   content-driven fake（fixture 内容嵌入 VERSION=x.y.z 标记，内容决定版本输出，
 *   与真实二进制"内容决定 --version"的语义同构，且与调用顺序无关）；
 * - FS 落点由调用方传入的目录派生（约定在插件 .tmp/upgrade-test/ 之下）；
 * - buildUstarGzip 纯 node:zlib 本地构建，不 spawn tar——真实 tar 进程仅在
 *   defaultExtract 专项测试出现（系统工具，非 codearts 二进制）。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { gzipSync } from "node:zlib";
import * as path from "node:path";
import type { Exec } from "../../src/core/install";
import type { Fetcher, Release } from "../../src/core/upgrade";

/* ───── 版本与内容物料（确定性字节串，哈希可复现） ───── */

export const OLD_VERSION = "26.10.9";
export const NEW_VERSION = "26.11.0";

/** fake fetcher 下发的下载地址（仅测试内约定值，不发起任何真实网络请求）。 */
export const FAKE_URL = "https://fake.example/codearts-26.11.0.tar.gz";

/** 旧版二进制内容（ELF 魔数 + VERSION 标记；仅 fixture，绝非真二进制）。 */
export const OLD_ELF_CONTENT = "\x7fELF-fake codearts old payload VERSION=26.10.9\n";

/** 新版二进制内容（正常：版本与 Release.version 一致）。 */
export const NEW_ELF_CONTENT = "\x7fELF-fake codearts new payload VERSION=26.11.0\n";

/** 新版二进制内容（无 VERSION 标记：自检 --version 无法解析 → PACKAGE_BINARY_INVALID）。 */
export const NEW_ELF_NO_VERSION = "\x7fELF-fake codearts payload without version marker\n";

/** 新版二进制内容（版本与 Release.version 不符 → PACKAGE_VERSION_MISMATCH）。 */
export const NEW_ELF_WRONG_VERSION = "\x7fELF-fake codearts payload VERSION=26.99.99\n";

/** 旧版二进制内容（无 VERSION 标记：旧版不可读版本 → from=unknown、备份跳过）。 */
export const OLD_ELF_NO_VERSION = "\x7fELF-fake codearts old payload no marker\n";

/** 可选脚本（根目录名 codearts、#! 开头 → 一并部署到 <installDir>/codearts）。 */
export const NEW_SCRIPT_CONTENT = "#!/bin/sh\nprintf 'codearts-wrapper\\n'\n";

/** fake 包字节（哈希校验的载荷；happy path 的 extract 为注入实现，不真解压它）。 */
export const PACKAGE_BYTES = "fake codearts release package bytes v26.11.0\n";

/** happy path 默认解压布局（R-up5：bin/codearts 为二进制 + 根目录 codearts 脚本）。 */
export const DEFAULT_LAYOUT: Record<string, string> = {
  "bin/codearts": NEW_ELF_CONTENT,
  codearts: NEW_SCRIPT_CONTENT,
};

/** 测试侧哈希 oracle（独立于被测实现，与 fsx.test.ts 同纪律）。 */
export function sha256Oracle(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/* ───── fake Fetcher（R-up7：全部注入，绝不联网） ───── */

export interface FakeDownloadRecord {
  url: string;
  dest: string;
}

/**
 * 构造 fake Fetcher：latest 返回固定 Release（hash 默认与 download 写入字节一致），
 * download 把包字节写到 dest 并记录调用。可显式给错 hash 构造 HASH_MISMATCH 路径。
 */
export function makeFakeFetcher(
  params: { version?: string; url?: string; hash?: string; bytes?: string } = {},
  downloads: FakeDownloadRecord[] = [],
): Fetcher {
  const bytes = params.bytes ?? PACKAGE_BYTES;
  const release: Release = {
    version: params.version ?? NEW_VERSION,
    url: params.url ?? FAKE_URL,
    hash: params.hash ?? sha256Oracle(bytes),
  };
  return {
    latest: async () => release,
    download: async (url: string, dest: string) => {
      downloads.push({ url, dest });
      await writeFile(dest, bytes, "utf8");
    },
  };
}

/* ───── 注入式 extract（R-up8：happy path"实为 copy fixture"） ───── */

export interface FakeExtractRecord {
  pkg: string;
  destDir: string;
}

/** 构造注入 extract：把布局物料落进 destDir（模拟解压产物），并记录调用。 */
export function copyExtract(
  layout: Record<string, string>,
  calls: FakeExtractRecord[] = [],
): (packagePath: string, destDir: string) => Promise<void> {
  return async (pkg: string, destDir: string): Promise<void> => {
    calls.push({ pkg, destDir });
    for (const [rel, content] of Object.entries(layout)) {
      const target = path.join(destDir, rel);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
  };
}

/* ───── content-driven fake exec（绝不真跑二进制） ───── */

/**
 * 按目标文件内容回答 --version 的 fake exec：
 * 读 cmd[0] 文件 → 提取 /VERSION=(\d+\.\d+\.\d+)/ → stdout 输出该版本。
 * 文件缺失/无标记 → 非零退出码（对应真实"无法执行/解析失败"，detectVersion 转 undefined）。
 */
export function contentVersionExec(calls: string[][]): Exec {
  return {
    run: async (cmd: string[]) => {
      calls.push(cmd);
      const target = cmd[0];
      if (target === undefined) return { code: 1, stdout: "", stderr: "empty cmd" };
      let text: string;
      try {
        text = await readFile(target, "utf8");
      } catch {
        return { code: 127, stdout: "", stderr: `cannot open ${target}` };
      }
      const match = /VERSION=(\d+\.\d+\.\d+)/.exec(text);
      if (match === null) return { code: 1, stdout: "", stderr: "no version marker" };
      return { code: 0, stdout: `${match[1]}\n`, stderr: "" };
    },
  };
}

/* ───── 本地 ustar+gzip 构建（默认解压器专项测试用；不 spawn tar） ───── */

/** 单文件 ustar 头（512 字节；name ≤100 字节，越界显式失败——fixture 自身 bug 立刻暴露）。 */
function tarHeader(name: string, size: number): Buffer {
  if (Buffer.byteLength(name, "utf8") > 100) {
    throw new Error(`fixture tar 文件名超长（ustar 无前缀扩展）：${name}`);
  }
  const buf = Buffer.alloc(512, 0);
  buf.write(name, 0, "utf8");
  buf.write("0000755\0", 100, "utf8"); // mode
  buf.write("0000000\0", 108, "utf8"); // uid
  buf.write("0000000\0", 116, "utf8"); // gid
  buf.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "utf8"); // size
  buf.write("00000000000\0", 136, "utf8"); // mtime=0
  buf.write("        ", 148, "utf8"); // chksum 占位（8 空格参与求和）
  buf.write("0", 156, "utf8"); // typeflag：常规文件
  buf.write("ustar\0", 257, "utf8");
  buf.write("00", 263, "utf8");
  let sum = 0;
  for (const byte of buf) sum += byte;
  buf.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "utf8");
  return buf;
}

/** 本地构建 gzip 压缩的 ustar（含相对路径文件；父目录由 tar 解压时自动创建）。 */
export function buildUstarGzip(files: Array<{ rel: string; content: string }>): Buffer {
  const chunks: Buffer[] = [];
  for (const file of files) {
    const data = Buffer.from(file.content, "utf8");
    chunks.push(tarHeader(file.rel, data.length));
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }
  chunks.push(Buffer.alloc(1024, 0)); // 两块全零结束符
  return gzipSync(Buffer.concat(chunks));
}
