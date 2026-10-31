/**
 * T1-03/T1-04 fsx 文件原语测试。
 *
 * T1-03（R-b）：sha256File；
 * T1-04（R-fx1/R-fx2）：sameDevice（st_dev 比较）/ atomicWriteFile（同目录 tmp+rename）/
 * copyDeploy（同目录 tmp 写全 + fsync + rename 的原子替换部署）。
 *
 * 纪律：FS 落点在插件 .tmp/fsx-test/ 之下，beforeEach 重建、afterAll 清理；
 * 期望哈希用 node:crypto createHash 独立计算（测试侧 oracle，与被测实现分列）。
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { atomicWriteFile, copyDeploy, sameDevice, sha256File } from "../src/core/fsx";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
const TEST_ROOT = path.join(PLUGIN_ROOT, ".tmp", "fsx-test");

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("sha256File", () => {
  it("小文件哈希与独立 oracle（createHash）一致", async () => {
    const file = path.join(TEST_ROOT, "small.bin");
    const content = "fake codearts binary payload v26.10.9\n";
    await writeFile(file, content, "utf8");
    const expected = createHash("sha256").update(content, "utf8").digest("hex");
    expect(await sha256File(file)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("空文件哈希为 SHA-256 空串标准值", async () => {
    const file = path.join(TEST_ROOT, "empty.bin");
    await writeFile(file, "", "utf8");
    expect(await sha256File(file)).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("大文件（跨流式 chunk，>128KB）哈希正确", async () => {
    const file = path.join(TEST_ROOT, "large.bin");
    // 确定性内容拼到 300KB（超过默认 64KB 流 chunk，覆盖多 chunk 聚合路径）
    const piece = "codearts-bridge-sha256-chunk-boundary-payload-0123456789\n";
    const content = piece.repeat(Math.ceil(300 * 1024 / piece.length));
    await writeFile(file, content, "utf8");
    const expected = createHash("sha256").update(content, "utf8").digest("hex");
    expect(await sha256File(file)).toBe(expected);
  });

  it("文件不存在 → 抛 BridgeError(FS_READ_FAILED)，消息含路径与原因", async () => {
    const file = path.join(TEST_ROOT, "nope.bin");
    const err: unknown = await sha256File(file).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("BridgeError");
    expect((err as { code?: string }).code).toBe("FS_READ_FAILED");
    expect((err as Error).message).toContain(file);
    expect((err as Error).message).toContain("ENOENT");
  });
});

describe("sameDevice（st_dev 比较；T1-05 暂存目录选址依据）", () => {
  it("同目录树下两个路径 → true", async () => {
    const a = path.join(TEST_ROOT, "a.txt");
    const b = path.join(TEST_ROOT, "sub", "b.txt");
    await mkdir(path.dirname(b), { recursive: true });
    await writeFile(a, "a", "utf8");
    await writeFile(b, "b", "utf8");
    expect(await sameDevice(a, b)).toBe(true);
  });

  it("/tmp 与仓库 .tmp 分属 ZFS 双数据集 → false（本机实测 st_dev 不同）", async () => {
    // 前提自检：若本机两路径恰在同设备，该用例前提失效（显式失败而非静默通过）
    const devTmp = (await stat("/tmp")).dev;
    const devRepo = (await stat(TEST_ROOT)).dev;
    expect(devTmp).not.toBe(devRepo);
    expect(await sameDevice("/tmp", TEST_ROOT)).toBe(false);
  });

  it("任一路径不存在 → 抛 BridgeError（显式，禁止静默假定同/异设备）", async () => {
    const err: unknown = await sameDevice(TEST_ROOT, path.join(TEST_ROOT, "nope")).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("BridgeError");
    expect((err as { code?: string }).code).toBe("FS_STAT_FAILED");
    expect((err as Error).message).toContain("nope");
  });
});

describe("atomicWriteFile（R-fx2：同目录 tmp+rename，崩溃中断目标保持原状）", () => {
  it("写入 string：内容一致，显式 mode 生效（0o667 不被 umask 0002 掩蔽 → 证明显式 chmod）", async () => {
    const file = path.join(TEST_ROOT, "state.json");
    await atomicWriteFile(file, '{"a":1}\n', 0o667);
    const content = await readFile(file, "utf8");
    expect(content).toBe('{"a":1}\n');
    const mode = (await stat(file)).mode & 0o777;
    expect(mode).toBe(0o667); // umask 0002 下 open mode 只会得到 0o665；0o667 证明显式 chmod 生效
  });

  it("写入 Uint8Array：字节级一致", async () => {
    const file = path.join(TEST_ROOT, "blob.bin");
    const data = new Uint8Array([0, 1, 2, 250, 251, 255]);
    await atomicWriteFile(file, data, 0o644);
    const raw = new Uint8Array(await readFile(file));
    expect(Array.from(raw)).toEqual([0, 1, 2, 250, 251, 255]);
  });

  it("覆盖旧文件：新内容完整、目录无 *.tmp-* 残留（rename 收尾干净）", async () => {
    const file = path.join(TEST_ROOT, "target.txt");
    await writeFile(file, "old-content", "utf8");
    await atomicWriteFile(file, "new-content-complete", 0o644);
    expect(await readFile(file, "utf8")).toBe("new-content-complete");
    const leftovers = (await readdir(TEST_ROOT)).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("崩溃注入：手工构造半写 tmp 残留（模拟写 tmp 后进程中断）→ 目标文件保持原状，且后续写入照常成功", async () => {
    const file = path.join(TEST_ROOT, "target.txt");
    await writeFile(file, "old-content", "utf8");
    // 模拟崩溃残留：tmp 已写出但 rename 未发生（进程在此刻被杀死）
    await writeFile(path.join(TEST_ROOT, ".target.txt.atomic-tmp-deadbeef"), "half-written", "utf8");
    // 崩溃后目标仍为旧内容（tmp+rename 语义：目标只经 rename 变更）
    expect(await readFile(file, "utf8")).toBe("old-content");
    // 后续写入不受残留影响：成功、内容正确、自身 tmp 收尾
    await atomicWriteFile(file, "recovered-content", 0o644);
    expect(await readFile(file, "utf8")).toBe("recovered-content");
  });

  it("失败注入（目录只读，tmp 无法创建）→ 抛 BridgeError(FS_WRITE_FAILED) 含路径与 EACCES；目标保持旧内容", async () => {
    const dir = path.join(TEST_ROOT, "ro-dir");
    const file = path.join(dir, "target.txt");
    await mkdir(dir, { recursive: true });
    await writeFile(file, "old-content", "utf8");
    await chmod(dir, 0o555); // 非 root（uid 1000）：写 tmp 必 EACCES
    try {
      const err: unknown = await atomicWriteFile(file, "new", 0o644).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("BridgeError");
      expect((err as { code?: string }).code).toBe("FS_WRITE_FAILED");
      expect((err as Error).message).toContain(file);
      expect((err as Error).message).toContain("EACCES");
      expect(await readFile(file, "utf8")).toBe("old-content"); // 中断不伤目标
    } finally {
      await chmod(dir, 0o755); // 还原以便 afterAll 清理
    }
  });
});

describe("copyDeploy（R-fx1：原子替换部署——目标要么旧内容要么新内容，绝无半写）", () => {
  it("部署后目标哈希与源一致、mode 默认 0o755 显式生效", async () => {
    const src = path.join(TEST_ROOT, "src.bin");
    const dst = path.join(TEST_ROOT, "bin", "codearts");
    const content = "fake codearts binary payload v26.10.9\n";
    await mkdir(path.dirname(dst), { recursive: true });
    await writeFile(src, content, "utf8");
    await copyDeploy(src, dst);
    expect(await sha256File(dst)).toBe(createHash("sha256").update(content, "utf8").digest("hex"));
    expect((await stat(dst)).mode & 0o777).toBe(0o755);
  });

  it("自定义 mode（0o667）生效（umask 0002 下证明 chmod 显式而非继承创建掩码）", async () => {
    const src = path.join(TEST_ROOT, "src2.bin");
    const dst = path.join(TEST_ROOT, "dst2.bin");
    await writeFile(src, "x", "utf8");
    await copyDeploy(src, dst, 0o667);
    expect((await stat(dst)).mode & 0o777).toBe(0o667);
  });

  it("覆盖已有目标：原子替换完成、无 *.tmp-* 残留、目标哈希=新源", async () => {
    const src = path.join(TEST_ROOT, "src3.bin");
    const dst = path.join(TEST_ROOT, "bin3", "codearts");
    await mkdir(path.dirname(dst), { recursive: true });
    await writeFile(dst, "old-binary", "utf8");
    await writeFile(src, "new-binary", "utf8");
    await copyDeploy(src, dst);
    expect(await readFile(dst, "utf8")).toBe("new-binary");
    const leftovers = (await readdir(path.dirname(dst))).filter((n) => n.includes(".tmp-"));
    expect(leftovers).toEqual([]);
  });

  it("源缺失 → 抛 BridgeError(FS_WRITE_FAILED) 含源路径与 ENOENT；目标不受影响", async () => {
    const dst = path.join(TEST_ROOT, "dst4.bin");
    await writeFile(dst, "keep-old", "utf8");
    const err: unknown = await copyDeploy(path.join(TEST_ROOT, "no-such-src"), dst).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).toBe("BridgeError");
    expect((err as { code?: string }).code).toBe("FS_WRITE_FAILED");
    expect((err as Error).message).toContain("no-such-src");
    expect(await readFile(dst, "utf8")).toBe("keep-old");
  });

  it("目标目录只读 → 抛 BridgeError(FS_WRITE_FAILED) 含目标路径与 EACCES（Review-Focus-1 同源：结构化 IO 错误含路径与原因）；目标保持旧内容", async () => {
    const dir = path.join(TEST_ROOT, "ro-bin");
    const dst = path.join(dir, "codearts");
    const src = path.join(TEST_ROOT, "src5.bin");
    await mkdir(dir, { recursive: true });
    await writeFile(dst, "old-binary", "utf8");
    await writeFile(src, "new-binary", "utf8");
    await chmod(dir, 0o555);
    try {
      const err: unknown = await copyDeploy(src, dst).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name).toBe("BridgeError");
      expect((err as { code?: string }).code).toBe("FS_WRITE_FAILED");
      expect((err as Error).message).toContain(dst);
      expect((err as Error).message).toContain("EACCES");
      expect(await readFile(dst, "utf8")).toBe("old-binary"); // 失败时旧文件原位（裁定 R-fx1）
    } finally {
      await chmod(dir, 0o755);
    }
  });
});
