/**
 * T1-07 hygiene 治理测试（bun:test）。
 *
 * 覆盖（任务书 Step1 + 主控裁定 R-hy1..R-hy5）：
 * - purge-dumps：plan 仅列超过 olderThanDays 的 dump-*.heapsnapshot（含子目录递归、
 *   非转储不入选、未到期不入选）；dry-run 清单 = apply 实际删除清单（逐一断言）（R-hy4）；
 * - wal-checkpoint：预置含热 WAL 的 sqlite（保持一条空闲连接使 WAL 非自愈态——
 *   钉死"显式 PRAGMA 起效"而非"打开时自动恢复"），apply 后 WAL 尺寸趋零且数据完整
 *   （原连接与重开只读连接双验）（R-hy1）；
 * - rotate-logs：仅 kernel-*.log（按 mtime 保留最近 keep 个），experience-*.log 等
 *   异构日志不参与轮转（R-hy2）；
 * - 审计：apply 写 hygiene.apply（删除清单/checkpoint 结果/轮转数）；plan 纯只读不写审计
 *   （R-hy4）；
 * - 边界守卫：候选须位于 <kernelDataDir>/log 内（realpath + 前缀双重校验），越界/
 *   符号链接外逃/名单不符/目标失踪一律显式报错且不删除；WAL 目标缺失不静默建库
 *   （R-hy3 + 禁静默兜底）。
 *
 * 隔离纪律（主控裁定）：绝不触碰真实 HOME；FS 落点全在 .tmp/hygiene-test/，清理见钩子。
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { loadConfig } from "../src/core/config";
import type { BridgeConfig } from "../src/core/config";
import { BridgeError } from "../src/core/errors";
import {
  HYGIENE_DEFAULT_LOGS_KEEP,
  HYGIENE_DEFAULT_OLDER_THAN_DAYS,
  applyHygiene,
  planHygiene,
} from "../src/core/health";
import type { HygieneAction } from "../src/core/health";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
const TEST_ROOT = path.join(PLUGIN_ROOT, ".tmp", "hygiene-test");

const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

/** 隔离配置（路径全在本测试根内，绝不依赖真实 HOME）。 */
function cfgOf(): BridgeConfig {
  return loadConfig(
    {
      installDir: path.join(TEST_ROOT, "installers"),
      stateDir: path.join(TEST_ROOT, "state"),
    },
    {},
  );
}

/** 把 mtime 固定到"now - days 天"（atime 同步设置，测试确定性不依赖写入先后）。 */
async function ageFile(file: string, days: number): Promise<void> {
  const t = new Date(Date.now() - days * DAY_MS);
  await utimes(file, t, t);
}

/** 读取审计文件（install.jsonl）为对象数组；空行跳过。 */
async function readAuditLines(stateDir: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path.join(stateDir, "audit", "install.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** 构造 purge 用 fixture：新旧转储（顶层+子目录）、非转储、内核日志各就位。 */
async function makeDumpFixture(root: string, olderThanDays = 30): Promise<string> {
  const kernelDataDir = path.join(root, "cli-data");
  const logDir = path.join(kernelDataDir, "log");
  await mkdir(path.join(logDir, "sub"), { recursive: true });

  const dumpOld = path.join(logDir, "dump-old.heapsnapshot");
  const dumpSub = path.join(logDir, "sub", "dump-nested.heapsnapshot");
  const dumpYoung = path.join(logDir, "dump-young.heapsnapshot");
  await writeFile(dumpOld, "old".repeat(10), "utf8");
  await writeFile(dumpSub, "nested".repeat(10), "utf8");
  await writeFile(dumpYoung, "young", "utf8");
  await writeFile(path.join(logDir, "notes.txt"), "not a dump\n", "utf8");
  await writeFile(
    path.join(logDir, "kernel-a.log"),
    "INFO  2026-10-30T20:26:00.000 +1ms service=session \"poll ok\" count=1\n",
    "utf8",
  );
  await ageFile(dumpOld, olderThanDays + 10);
  await ageFile(dumpSub, olderThanDays + 5);
  await ageFile(dumpYoung, 1);
  await ageFile(path.join(logDir, "kernel-a.log"), olderThanDays + 10);
  return kernelDataDir;
}

/* ───── purge-dumps：plan 清单与 apply 删除一致（R-hy3/R-hy4） ───── */

describe("planHygiene purge-dumps", () => {
  it("仅列超过 olderThanDays 的 dump-*.heapsnapshot（递归含子目录；未到期/非转储不入选）", async () => {
    const kernelDataDir = await makeDumpFixture(path.join(TEST_ROOT, "purge-plan"));
    const actions = await planHygiene(cfgOf(), { kernelDataDir, olderThanDays: 30, logsKeep: 5 });

    const purge = actions.find((a): a is Extract<HygieneAction, { kind: "purge-dumps" }> => a.kind === "purge-dumps");
    expect(purge).toBeDefined();
    expect([...purge!.files].sort()).toEqual([
      path.join(kernelDataDir, "log", "dump-old.heapsnapshot"),
      path.join(kernelDataDir, "log", "sub", "dump-nested.heapsnapshot"),
    ]);
    // 内核日志 1 个 ≤ logsKeep=5 → 无轮转动作；无 WAL → 无 checkpoint 动作
    expect(actions.filter((a) => a.kind !== "purge-dumps")).toEqual([]);
  });

  it("plan 纯只读：不创建 stateDir/audit、不改写任何文件（R-hy4）", async () => {
    const kernelDataDir = await makeDumpFixture(path.join(TEST_ROOT, "purge-readonly"));
    const cfg = cfgOf();
    await planHygiene(cfg, { kernelDataDir, olderThanDays: 30, logsKeep: 5 });
    expect(await Bun.file(path.join(cfg.stateDir, "audit", "install.jsonl")).exists()).toBe(false);
    // 计划清单内的文件仍在（未删除）
    expect(await Bun.file(path.join(kernelDataDir, "log", "dump-old.heapsnapshot")).exists()).toBe(true);
  });

  it("默认参数（R-hy2）：olderThanDays=30 / logsKeep=20 — 21 天前转储不清理、第 21 个日志触发轮转", async () => {
    expect(HYGIENE_DEFAULT_OLDER_THAN_DAYS).toBe(30);
    expect(HYGIENE_DEFAULT_LOGS_KEEP).toBe(20);

    const kernelDataDir = path.join(TEST_ROOT, "defaults", "cli-data");
    const logDir = path.join(kernelDataDir, "log");
    await mkdir(logDir, { recursive: true });
    const dump21 = path.join(logDir, "dump-21d.heapsnapshot");
    await writeFile(dump21, "d21", "utf8");
    await ageFile(dump21, 21);
    const dumpOld = path.join(logDir, "dump-40d.heapsnapshot");
    await writeFile(dumpOld, "d40", "utf8");
    await ageFile(dumpOld, 40);

    for (let i = 0; i < 21; i++) {
      const f = path.join(logDir, `kernel-${String(i).padStart(2, "0")}.log`);
      await writeFile(f, `log-${i}\n`, "utf8");
      await ageFile(f, i); // kernel-20.log 最新
    }

    const actions = await planHygiene(cfgOf(), { kernelDataDir });
    const purge = actions.find((a): a is Extract<HygieneAction, { kind: "purge-dumps" }> => a.kind === "purge-dumps");
    expect(purge?.files).toEqual([dumpOld]); // 21 天 < 30 天 → 不入选
    expect(actions).toContainEqual({ kind: "rotate-logs", keep: 20 }); // 21 > 20 → 轮转
  });
});

describe("applyHygiene purge-dumps（清单一致性）", () => {
  it("dry-run 清单 = 实际删除清单：逐一删除、未入选者原位保留", async () => {
    const kernelDataDir = await makeDumpFixture(path.join(TEST_ROOT, "purge-apply"));
    const logDir = path.join(kernelDataDir, "log");
    const planned = await planHygiene(cfgOf(), { kernelDataDir, olderThanDays: 30, logsKeep: 5 });
    const purge = planned.find((a): a is Extract<HygieneAction, { kind: "purge-dumps" }> => a.kind === "purge-dumps");
    expect(purge).toBeDefined();

    const res = await applyHygiene(cfgOf(), planned, { kernelDataDir });
    expect(res.applied).toEqual(["purge-dumps"]);
    expect(res.auditId).toMatch(/^hy-\d+-[0-9a-f]+$/);

    // 逐一断言：计划清单内文件全部消失
    for (const f of purge!.files) expect(await Bun.file(f).exists()).toBe(false);
    // 未入选者原位保留
    expect(await Bun.file(path.join(logDir, "dump-young.heapsnapshot")).exists()).toBe(true);
    expect(await Bun.file(path.join(logDir, "notes.txt")).exists()).toBe(true);
    expect(await Bun.file(path.join(logDir, "kernel-a.log")).exists()).toBe(true);

    // 审计删除清单与 plan 清单逐条一致（R-hy4）
    const lines = await readAuditLines(cfgOf().stateDir);
    const entry = lines.find((l) => l["kind"] === "hygiene.apply");
    expect(entry).toBeDefined();
    expect(entry?.["auditId"]).toBe(res.auditId);
    expect(entry?.["result"]).toBe("ok");
    expect([...(entry?.["purged"] as string[]).values()].sort()).toEqual([...purge!.files].sort());
  });

  it("空目录 → plan 为空数组；apply([]) 仅记审计、applied 为空", async () => {
    const kernelDataDir = path.join(TEST_ROOT, "empty", "cli-data");
    await mkdir(path.join(kernelDataDir, "log"), { recursive: true });
    const actions = await planHygiene(cfgOf(), { kernelDataDir });
    expect(actions).toEqual([]);
    const res = await applyHygiene(cfgOf(), actions, { kernelDataDir });
    expect(res.applied).toEqual([]);
    const lines = await readAuditLines(cfgOf().stateDir);
    expect(lines.filter((l) => l["kind"] === "hygiene.apply").length).toBe(1);
  });
});

/* ───── wal-checkpoint（R-hy1） ───── */

describe("applyHygiene wal-checkpoint", () => {
  it("预置含热 WAL 的库：apply 后 WAL 趋零、数据完整（原连接可读 + 重开可读）", async () => {
    const kernelDataDir = path.join(TEST_ROOT, "wal", "cli-data");
    await mkdir(kernelDataDir, { recursive: true });
    const dbPath = path.join(kernelDataDir, "opencode.db");
    const walPath = `${dbPath}-wal`;

    // 连接 A：WAL 模式建表插入；保持打开（空闲）使 WAL 处于非自愈态——
    // 若实现漏掉 PRAGMA，打开时的自动恢复不会替它完成 checkpoint（测试真实性）
    const dbA = new Database(dbPath);
    dbA.run("PRAGMA journal_mode=WAL");
    dbA.run("PRAGMA wal_autocheckpoint=0");
    dbA.run("CREATE TABLE t(x TEXT)");
    dbA.run("INSERT INTO t VALUES ('hello-checkpoint')");
    const walBefore = (await stat(walPath)).size;
    expect(walBefore).toBeGreaterThan(0);

    const cfg = cfgOf();
    const actions = await planHygiene(cfg, { kernelDataDir });
    expect(actions).toContainEqual({ kind: "wal-checkpoint" });

    const res = await applyHygiene(cfg, actions, { kernelDataDir });
    expect(res.applied).toContain("wal-checkpoint");

    const walAfter = (await stat(walPath)).size;
    expect(walAfter).toBe(0); // 无并发读者 → TRUNCATE 趋零

    // 数据完整：原连接可读 + 关闭后重开（只读）仍可读
    expect(dbA.query("SELECT x FROM t").get()).toEqual({ x: "hello-checkpoint" });
    dbA.close();
    const dbC = new Database(dbPath, { readonly: true });
    expect(dbC.query("SELECT x FROM t").get()).toEqual({ x: "hello-checkpoint" });
    dbC.close();

    // 审计记录 checkpoint 结果
    const lines = await readAuditLines(cfg.stateDir);
    const entry = lines.find((l) => l["kind"] === "hygiene.apply");
    const wal = entry?.["walCheckpoint"] as Record<string, unknown> | undefined;
    expect(wal).toBeDefined();
    expect(wal?.["busy"]).toBe(0);
    expect(wal?.["dbPath"]).toBe(dbPath);
  });

  it("两连接并发：A 持未提交读事务 → WAL_CHECKPOINT_BUSY 且 WAL 不变；A COMMIT 后重跑 → 成功且 WAL 趋零", async () => {
    const kernelDataDir = path.join(TEST_ROOT, "wal-busy", "cli-data");
    await mkdir(kernelDataDir, { recursive: true });
    const dbPath = path.join(kernelDataDir, "opencode.db");
    const walPath = `${dbPath}-wal`;

    // 连接 A：WAL 模式写入数据并保持打开；随后 BEGIN+未提交 SELECT 持读事务
    const dbA = new Database(dbPath);
    dbA.run("PRAGMA journal_mode=WAL");
    dbA.run("PRAGMA wal_autocheckpoint=0");
    dbA.run("CREATE TABLE t(x TEXT)");
    dbA.run("INSERT INTO t VALUES ('busy-case')");
    const walBefore = (await stat(walPath)).size;
    expect(walBefore).toBeGreaterThan(0);
    dbA.run("BEGIN");
    dbA.query("SELECT x FROM t").all(); // 读事务开启且不提交 → 阻塞 TRUNCATE checkpoint

    // ① busy 分支回归：apply 显式抛 WAL_CHECKPOINT_BUSY，且 WAL 字节不变（未误报成功）
    try {
      await applyHygiene(cfgOf(), [{ kind: "wal-checkpoint" }], { kernelDataDir });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe("WAL_CHECKPOINT_BUSY");
    }
    expect((await stat(walPath)).size).toBe(walBefore);

    // ② A 提交后重跑：checkpoint 成功，WAL 趋零，数据完整
    dbA.run("COMMIT");
    const cfg = cfgOf();
    const res = await applyHygiene(cfg, [{ kind: "wal-checkpoint" }], { kernelDataDir });
    expect(res.applied).toContain("wal-checkpoint");
    expect((await stat(walPath)).size).toBe(0);
    expect(dbA.query("SELECT x FROM t").get()).toEqual({ x: "busy-case" });
    dbA.close();

    // 审计：第一次失败留痕（含错误码）+ 第二次成功，各恰一条
    const lines = await readAuditLines(cfg.stateDir);
    const entries = lines.filter((l) => l["kind"] === "hygiene.apply");
    expect(entries.length).toBe(2);
    expect(entries[0]?.["result"]).toBe("failed");
    expect(String(entries[0]?.["error"])).toContain("WAL_CHECKPOINT_BUSY");
    expect(entries[1]?.["result"]).toBe("ok");
  });

  it("db 缺失 → WAL_DB_MISSING 显式抛出，且不得静默创建空库文件", async () => {
    const kernelDataDir = path.join(TEST_ROOT, "wal-missing", "cli-data");
    await mkdir(kernelDataDir, { recursive: true });
    // 手工放一个 WAL 但没有 db（异常态）：apply 必须显式报错而非打开时静默建库
    await writeFile(path.join(kernelDataDir, "opencode.db-wal"), "orphan-wal", "utf8");
    const dbPath = path.join(kernelDataDir, "opencode.db");
    try {
      await applyHygiene(cfgOf(), [{ kind: "wal-checkpoint" }], { kernelDataDir });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe("WAL_DB_MISSING");
    }
    expect(await Bun.file(dbPath).exists()).toBe(false); // 未被静默创建
  });

  it("非 SQLite 垃圾文件 → WAL_CHECKPOINT_FAILED 显式抛出（打开/PRAGMA 失败不降级）", async () => {
    const kernelDataDir = path.join(TEST_ROOT, "wal-garbage", "cli-data");
    await mkdir(kernelDataDir, { recursive: true });
    await writeFile(path.join(kernelDataDir, "opencode.db"), "this is not sqlite", "utf8");
    try {
      await applyHygiene(cfgOf(), [{ kind: "wal-checkpoint" }], { kernelDataDir });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe("WAL_CHECKPOINT_FAILED");
    }
  });
});

/* ───── rotate-logs（R-hy2） ───── */

describe("planHygiene/applyHygiene rotate-logs", () => {
  it("保留最近 keep 个 kernel-*.log（按 mtime），其余删除；异构日志不参与", async () => {
    const kernelDataDir = path.join(TEST_ROOT, "rotate", "cli-data");
    const logDir = path.join(kernelDataDir, "log");
    await mkdir(logDir, { recursive: true });

    const names = ["kernel-e.log", "kernel-a.log", "kernel-c.log", "kernel-b.log", "kernel-d.log"];
    for (let i = 0; i < names.length; i++) {
      const f = path.join(logDir, names[i]!);
      await writeFile(f, `content-${names[i]}\n`, "utf8");
      await ageFile(f, names.length - i); // kernel-d 最新(1天前) > kernel-b(2天) > c(3天) > a(4天) > e(5天)
    }
    await writeFile(path.join(logDir, "experience-2026-09-01.0.log"), "old exp log\n", "utf8");
    await ageFile(path.join(logDir, "experience-2026-09-01.0.log"), 60);

    const cfg = cfgOf();
    const actions = await planHygiene(cfg, { kernelDataDir, olderThanDays: 3650, logsKeep: 2 });
    const rotate = actions.find((a): a is Extract<HygieneAction, { kind: "rotate-logs" }> => a.kind === "rotate-logs");
    expect(rotate).toEqual({ kind: "rotate-logs", keep: 2 });

    const res = await applyHygiene(cfg, actions, { kernelDataDir });
    expect(res.applied).toEqual(["rotate-logs"]);

    // 幸存者 = mtime 最新的 2 个（kernel-d：1 天前、kernel-b：2 天前）
    expect(await Bun.file(path.join(logDir, "kernel-b.log")).exists()).toBe(true);
    expect(await Bun.file(path.join(logDir, "kernel-d.log")).exists()).toBe(true);
    for (const gone of ["kernel-a.log", "kernel-c.log", "kernel-e.log"]) {
      expect(await Bun.file(path.join(logDir, gone)).exists()).toBe(false);
    }
    // 异构日志不参与轮转
    expect(await Bun.file(path.join(logDir, "experience-2026-09-01.0.log")).exists()).toBe(true);

    // 审计：轮转数与被删清单
    const lines = await readAuditLines(cfg.stateDir);
    const entry = lines.find((l) => l["kind"] === "hygiene.apply");
    expect(entry?.["rotatedCount"]).toBe(3);
    expect([...(entry?.["rotated"] as string[]).values()].sort()).toEqual(
      ["kernel-a.log", "kernel-c.log", "kernel-e.log"].map((n) => path.join(logDir, n)).sort(),
    );
  });

  it("kernel 日志数 ≤ keep → 不产生轮转动作", async () => {
    const kernelDataDir = path.join(TEST_ROOT, "rotate-none", "cli-data");
    const logDir = path.join(kernelDataDir, "log");
    await mkdir(logDir, { recursive: true });
    await writeFile(path.join(logDir, "kernel-a.log"), "only\n", "utf8");
    const actions = await planHygiene(cfgOf(), { kernelDataDir, olderThanDays: 3650, logsKeep: 20 });
    expect(actions).toEqual([]);
  });
});

/* ───── purge 边界守卫（R-hy3：realpath/前缀双重校验，越界显式报错不删除） ───── */

describe("applyHygiene 边界守卫（R-hy3）", () => {
  it("候选位于 log 目录之外 → HYGIENE_PATH_ESCAPE，文件原位保留", async () => {
    const root = path.join(TEST_ROOT, "escape-outside");
    const kernelDataDir = await makeDumpFixture(root);
    const outside = path.join(root, "outside", "dump-evil.heapsnapshot");
    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, "evil", "utf8");

    try {
      await applyHygiene(cfgOf(), [{ kind: "purge-dumps", files: [outside] }], { kernelDataDir });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe("HYGIENE_PATH_ESCAPE");
    }
    expect(await Bun.file(outside).exists()).toBe(true); // 未删除
  });

  it("log 目录内的符号链接指向外部文件 → realpath 校验拦截（HYGIENE_PATH_ESCAPE）", async () => {
    const root = path.join(TEST_ROOT, "escape-symlink");
    const kernelDataDir = await makeDumpFixture(root);
    const logDir = path.join(kernelDataDir, "log");
    const outside = path.join(root, "outside", "dump-victim.heapsnapshot");
    await mkdir(path.dirname(outside), { recursive: true });
    await writeFile(outside, "victim", "utf8");
    const link = path.join(logDir, "dump-link.heapsnapshot");
    await symlink(outside, link);

    try {
      await applyHygiene(cfgOf(), [{ kind: "purge-dumps", files: [link] }], { kernelDataDir });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe("HYGIENE_PATH_ESCAPE");
    }
    expect(await Bun.file(outside).exists()).toBe(true); // 外部目标未被删除
  });

  it("log 目录内但文件名不符 dump-*.heapsnapshot → HYGIENE_TARGET_INVALID", async () => {
    const kernelDataDir = await makeDumpFixture(path.join(TEST_ROOT, "invalid-name"));
    const inside = path.join(kernelDataDir, "log", "kernel-a.log");
    try {
      await applyHygiene(cfgOf(), [{ kind: "purge-dumps", files: [inside] }], { kernelDataDir });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe("HYGIENE_TARGET_INVALID");
    }
    expect(await Bun.file(inside).exists()).toBe(true);
  });

  it("计划后目标失踪（plan→apply 竞态）→ HYGIENE_TARGET_MISSING 显式报错", async () => {
    const kernelDataDir = await makeDumpFixture(path.join(TEST_ROOT, "target-missing"));
    const vanished = path.join(kernelDataDir, "log", "dump-vanished.heapsnapshot");
    await writeFile(vanished, "soon gone", "utf8");
    await ageFile(vanished, 40);
    const actions = await planHygiene(cfgOf(), { kernelDataDir, olderThanDays: 30, logsKeep: 5 });
    await rm(vanished); // plan 之后被外部删除

    try {
      await applyHygiene(cfgOf(), actions, { kernelDataDir });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe("HYGIENE_TARGET_MISSING");
    }
  });
});

/* ───── 参数校验（禁静默截断/兜底） ───── */

describe("参数校验", () => {
  it("非法 olderThanDays / logsKeep（负数/非整数/非数字）→ HYGIENE_OPT_INVALID", async () => {
    const kernelDataDir = await makeDumpFixture(path.join(TEST_ROOT, "opt-invalid"));
    for (const bad of [{ olderThanDays: -1 }, { olderThanDays: 1.5 }, { olderThanDays: "30" as unknown as number }]) {
      try {
        await planHygiene(cfgOf(), { kernelDataDir, ...bad });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(BridgeError);
        expect((e as BridgeError).code).toBe("HYGIENE_OPT_INVALID");
      }
    }
    for (const bad of [{ logsKeep: -1 }, { logsKeep: 0.5 }]) {
      try {
        await planHygiene(cfgOf(), { kernelDataDir, olderThanDays: 3650, ...bad });
        expect.unreachable();
      } catch (e) {
        expect(e).toBeInstanceOf(BridgeError);
        expect((e as BridgeError).code).toBe("HYGIENE_OPT_INVALID");
      }
    }
  });

  it("rotate 动作 keep 非法（伪造动作直接 apply）→ HYGIENE_OPT_INVALID", async () => {
    const kernelDataDir = await makeDumpFixture(path.join(TEST_ROOT, "opt-apply-invalid"));
    try {
      await applyHygiene(cfgOf(), [{ kind: "rotate-logs", keep: -3 }], { kernelDataDir });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe("HYGIENE_OPT_INVALID");
    }
  });

  it("未支持的动作 kind → HYGIENE_ACTION_UNKNOWN（防静默跳过）", async () => {
    const kernelDataDir = await makeDumpFixture(path.join(TEST_ROOT, "action-unknown"));
    try {
      await applyHygiene(cfgOf(), [{ kind: "nope" } as unknown as HygieneAction], { kernelDataDir });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BridgeError);
      expect((e as BridgeError).code).toBe("HYGIENE_ACTION_UNKNOWN");
    }
  });
});

/* ───── realpath 基础设施自检（测试自身可靠性） ───── */

describe("测试基础设施", () => {
  it("makeDumpFixture 的时间戳生效（老转储确超 30 天）", async () => {
    const kernelDataDir = await makeDumpFixture(path.join(TEST_ROOT, "fixture-selfcheck"));
    const st = await stat(path.join(kernelDataDir, "log", "dump-old.heapsnapshot"));
    expect(Date.now() - st.mtimeMs).toBeGreaterThan(30 * DAY_MS);
  });
});
