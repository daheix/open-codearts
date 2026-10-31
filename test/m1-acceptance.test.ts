/**
 * T1-08 M1 工具接线与验收测试（bun:test）。
 *
 * 覆盖（任务书 Step1 + 主控裁定 R-t1..R-t4）：
 * - 注册精度：五个工具名 status/repair/upgrade/health/hygiene、namespace=codearts、
 *   输入 schema 严格 additionalProperties:false（经 fake ctx 捕获 editor 后断言）；
 * - codearts_status：五类 fixture（+R-a 未钉版共六行）表驱动摘要断言
 *   （present/version/drift/pinState/备份/autoupdate/健康摘要字段）+ AK-SK 存在性
 *   （凭据值绝不回显）；
 * - codearts_repair：权限门（action/resources/save/source 精确断言）、only-delete 残局
 *   + 有效备份恢复成功（R-t4 组合场景：哈希+auditId）、already-healthy 幂等（R-t3）、
 *   fixAutoupdate 透传（修复路径与健康路径都生效且保留未知字段）、无备份 → content 中
 *   BIN_MISSING_NO_BACKUP + remediation（R-t1 结构化错误，不抛裸异常）；
 * - codearts_upgrade：权限门精确断言；被拒 → PERMISSION_DENIED 且 fetcher 零调用
 *   （不执行）；
 * - codearts_hygiene：apply=false 只返回计划（零权限调用、零审计、零删除）；
 *   apply=true 走权限门且执行清单=计划清单（R-hy4 fake 环境复核）；
 * - codearts_health：返回 collectHealth 快照（fake cli-data）。
 *
 * 隔离纪律（沿用 R-e）：绝不真跑 codearts 二进制（exec/fetcher 全注入）、绝不联网、
 * 绝不触碰真实 HOME（installDir/stateDir/kernelDataDir 全部显式注入 fixture 路径）。
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { Plugin } from "@opencode/plugin";
import plugin, { buildPlugin, TOOL_NAMES } from "../src/server";
import { PLUGIN_ID, TOOL_NAMESPACE } from "../src/core/config";
import { sha256File } from "../src/core/fsx";
import {
  BIN_CONTENT,
  PINNED_VERSION,
  makeInstallFixture,
  writePinnedFile,
} from "./fixtures/install-fixtures";
import {
  DEFAULT_LAYOUT,
  NEW_ELF_CONTENT,
  NEW_VERSION,
  contentVersionExec,
  copyExtract,
  makeFakeFetcher,
  sha256Oracle,
} from "./fixtures/fake-release";
import type { Exec } from "../src/core/install";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
const TEST_ROOT = path.join(PLUGIN_ROOT, ".tmp", "m1-acceptance-test");
const DAY_MS = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
});

/* ───── fake 宿主上下文（捕获 editor + 记录权限调用） ───── */

/** add 被调用时捕获到的工具信息（只取测试关心的字段）。 */
interface CapturedTool {
  name: string;
  description: string;
  input: Record<string, unknown>;
  options?: { namespace?: string };
  execute: (input: unknown, context: unknown) => Promise<unknown>;
}

/** 权限门 fake：记录每次 assert 入参；deny=true 时拒绝。 */
function makePermissionFake(opts: { deny?: boolean } = {}) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    permission: {
      assert: async (input: Record<string, unknown>) => {
        calls.push(input);
        if (opts.deny === true) throw new Error("用户拒绝了授权请求（fake deny）");
      },
    },
  };
}

/** 组装 fake 宿主上下文：transform 立即以捕获编辑器回调 + 注入 permission/options。 */
function makeFakeContext(opts: {
  permission: ReturnType<typeof makePermissionFake>["permission"];
  options?: Record<string, unknown>;
}) {
  const added: CapturedTool[] = [];
  const ctx = {
    options: opts.options ?? {},
    permission: opts.permission,
    tool: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({ add: (tool: CapturedTool) => added.push(tool) });
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx: ctx as unknown as Parameters<Plugin.Plugin["setup"]>[0], added };
}

/** 工具执行上下文 fake（ToolContext 的 M1 关心子集；signal/progress 本层未用）。 */
const TOOL_CTX = {
  sessionID: "ses_m1test",
  agent: "agent_m1test",
  messageID: "msg_m1test",
  id: "call_m1test",
};

/** 按 name 取捕获工具；缺失即断言失败。 */
function toolOf(added: CapturedTool[], name: string): CapturedTool {
  const tool = added.find((t) => t.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

/** 工具结果形态（content[0]=JSON 摘要，content[1]=人类可读文本）。 */
interface ToolResultLike {
  content: Array<{ type: string; text: string }>;
}

/** 解析 content[0] 的 JSON 载荷。 */
function jsonOf(result: unknown): Record<string, any> {
  const r = result as ToolResultLike;
  expect(Array.isArray(r.content)).toBe(true);
  expect(r.content.length).toBeGreaterThanOrEqual(2);
  expect(r.content[0]!.type).toBe("text");
  return JSON.parse(r.content[0]!.text) as Record<string, any>;
}

/** 取 content[1] 的人类可读文本。 */
function humanOf(result: unknown): string {
  const r = result as ToolResultLike;
  expect(r.content[1]!.type).toBe("text");
  return r.content[1]!.text;
}

/** 读取审计文件（install.jsonl）为对象数组。 */
async function readAuditLines(stateDir: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path.join(stateDir, "audit", "install.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/** 审计文件是否存在。 */
async function auditExists(stateDir: string): Promise<boolean> {
  try {
    await stat(path.join(stateDir, "audit", "install.jsonl"));
    return true;
  } catch {
    return false;
  }
}

/** 组装注入了 fixture 路径与 fake 依赖的插件实例（权限经 fake ctx 注入）。 */
function fixturePlugin(fixture: {
  installDir: string;
  stateDir: string;
  exec: Exec;
  root: string;
}, extra: { extract?: (p: string, d: string) => Promise<void>; fetcher?: ReturnType<typeof makeFakeFetcher> } = {}) {
  return buildPlugin({
    configOverrides: { installDir: fixture.installDir, stateDir: fixture.stateDir },
    exec: fixture.exec,
    kernelDataDir: path.join(fixture.root, "cli-data"), // 不存在 → 健康摘要全零（显式注入，绝不触碰真实 HOME）
    ...(extra.extract !== undefined ? { extract: extra.extract } : {}),
    ...(extra.fetcher !== undefined ? { fetcher: extra.fetcher } : {}),
  });
}

/* ───── 注册精度（任务书 Step1 最后一条） ───── */

describe("M1 五工具注册精度", () => {
  it("注册名恰为 status/repair/upgrade/health/hygiene，namespace=codearts，schema 严格封闭", async () => {
    const perm = makePermissionFake();
    const { ctx, added } = makeFakeContext({ permission: perm.permission });
    await plugin.setup(ctx);

    expect(added.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    for (const tool of added) {
      expect(tool.options?.namespace).toBe(TOOL_NAMESPACE);
      expect(`${tool.options?.namespace}_${tool.name}`).toBe(`codearts_${tool.name}`);
      // schema 严格性：顶层 object + 禁止未知字段（任务书 Step3）
      expect(tool.input["type"]).toBe("object");
      expect(tool.input["additionalProperties"]).toBe(false);
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });

  it("default 导出是 id=codearts-bridge 的插件定义（骨架契约保持）", () => {
    expect(plugin.id).toBe(PLUGIN_ID);
    expect(typeof plugin.setup).toBe("function");
  });
});

/* ───── codearts_status：五类 fixture 表驱动（+R-a 未钉版） ───── */

describe("codearts_status 摘要", () => {
  /** 每行 = fixture 形态 → 期望摘要字段（undefined 断言键不存在/为 undefined）。 */
  const ROWS: Array<{
    kind: Parameters<typeof makeInstallFixture>[1];
    present: boolean;
    version: string | undefined;
    pinState: string;
    drift: boolean;
    backupValid: boolean;
    autoupdateFlag: boolean;
  }> = [
    { kind: "healthy", present: true, version: PINNED_VERSION, pinState: "consistent", drift: false, backupValid: true, autoupdateFlag: false },
    { kind: "missing", present: false, version: undefined, pinState: "drift", drift: true, backupValid: true, autoupdateFlag: false },
    { kind: "only-delete", present: false, version: undefined, pinState: "drift", drift: true, backupValid: false, autoupdateFlag: false },
    { kind: "bad-hash", present: true, version: PINNED_VERSION, pinState: "drift", drift: true, backupValid: true, autoupdateFlag: false },
    { kind: "bad-version", present: true, version: "99.99.99", pinState: "drift", drift: true, backupValid: true, autoupdateFlag: false },
    { kind: "unpinned", present: true, version: PINNED_VERSION, pinState: "unpinned", drift: false, backupValid: true, autoupdateFlag: false },
  ];

  for (const row of ROWS) {
    it(`fixture=${row.kind} 摘要如实呈现`, async () => {
      const fixture = await makeInstallFixture(path.join(TEST_ROOT, `status-${row.kind}`), row.kind);
      const perm = makePermissionFake();
      const { ctx, added } = makeFakeContext({ permission: perm.permission });
      await fixturePlugin(fixture).setup(ctx);

      const result = await toolOf(added, "status").execute({}, TOOL_CTX);
      const payload = jsonOf(result);

      expect(payload.install.present).toBe(row.present);
      expect(payload.install.version).toBe(row.version);
      expect(payload.install.pinState).toBe(row.pinState);
      expect(payload.install.drift).toBe(row.drift);
      expect(payload.install.backupValid).toBe(row.backupValid);
      expect(payload.install.autoupdateFlag).toBe(row.autoupdateFlag);
      expect(payload.install.path).toBe(fixture.binPath);
      expect(payload.install.pinnedVersion).toBe(row.kind === "unpinned" ? undefined : PINNED_VERSION);

      // 健康摘要字段（fixture cli-data 不存在 → 全零如实呈现）
      expect(payload.health.dbBytes).toBe(0);
      expect(payload.health.walBytes).toBe(0);
      expect(payload.health.dumps).toEqual({ files: 0, bytes: 0 });
      expect(payload.health.logsBytes).toBe(0);
      expect(payload.health.lastErrorsCount).toBe(0);

      // AK/SK 未配置 + 传输/守护占位（M2）
      expect(payload.credentials.present).toBe(false);
      expect(payload.transport.connected).toBe(false);
      expect(payload.transport.configured).toBe("auto");
      expect(payload.bridge.version).toBe("dev");

      // status 是只读工具：零权限调用
      expect(perm.calls).toHaveLength(0);

      // 人类可读文本
      expect(humanOf(result)).toContain("codearts_status");
    });
  }

  it("AK/SK 存在性如实呈现，且凭据值绝不回显", async () => {
    const fixture = await makeInstallFixture(path.join(TEST_ROOT, "status-aksk"), "healthy");
    await writeFile(fixture.stateDir + "/config.env", "AK=AKTESTVALUE123\nSK=SKTESTVALUE456\n", "utf8");
    const perm = makePermissionFake();
    const { ctx, added } = makeFakeContext({ permission: perm.permission });
    await fixturePlugin(fixture).setup(ctx);

    const result = await toolOf(added, "status").execute({}, TOOL_CTX);
    const payload = jsonOf(result);
    expect(payload.credentials.present).toBe(true);
    const raw = JSON.stringify(payload);
    expect(raw).not.toContain("AKTESTVALUE123");
    expect(raw).not.toContain("SKTESTVALUE456");
  });
});

/* ───── codearts_repair ───── */

describe("codearts_repair", () => {
  it("only-delete 残局 + 有效备份：恢复成功（哈希+auditId，R-t4 组合场景）", async () => {
    const fixture = await makeInstallFixture(path.join(TEST_ROOT, "repair-combo"), "missing");
    // 升级中断残留：bin 缺失 + .delete 残局 + 有效备份并存
    await writeFile(path.join(path.dirname(fixture.binPath), "codearts.delete"), BIN_CONTENT, "utf8");
    const perm = makePermissionFake();
    const { ctx, added } = makeFakeContext({ permission: perm.permission });
    await fixturePlugin(fixture).setup(ctx);

    const result = await toolOf(added, "repair").execute({}, TOOL_CTX);
    const payload = jsonOf(result);

    expect(payload.status).toBe("repaired");
    expect(payload.action).toBe("restore-from-backup");
    expect(payload.to).toBe(fixture.binPath);
    expect(payload.sha256).toBe(fixture.pinnedSha256);
    expect(payload.auditId).toMatch(/^rep-/);
    // 恢复落地复核：部署内容哈希 = 钉版哈希（哈希口径与审计一致）
    expect(await sha256File(fixture.binPath)).toBe(fixture.pinnedSha256);
    // 审计留痕：kind=repair result=restored
    const lines = await readAuditLines(fixture.stateDir);
    const repair = lines.find((l) => l["kind"] === "repair");
    expect(repair).toBeDefined();
    expect(repair!["auditId"]).toBe(payload.auditId);
    expect(repair!["result"]).toBe("restored");
    expect(humanOf(result)).toContain("恢复");
  });

  it("bin 健康时返回 already-healthy（R-t3 幂等，零审计副作用）", async () => {
    const fixture = await makeInstallFixture(path.join(TEST_ROOT, "repair-healthy"), "healthy");
    const perm = makePermissionFake();
    const { ctx, added } = makeFakeContext({ permission: perm.permission });
    await fixturePlugin(fixture).setup(ctx);

    const result = await toolOf(added, "repair").execute({}, TOOL_CTX);
    const payload = jsonOf(result);
    expect(payload.status).toBe("already-healthy");
    expect(payload.fixAutoupdateRequested).toBe(false);
    // 幂等：无任何审计写入
    expect(await auditExists(fixture.stateDir)).toBe(false);
    // 权限门先行（R-t2）：repair 一律过门
    expect(perm.calls).toHaveLength(1);
    expect(perm.calls[0]).toMatchObject({
      sessionID: "ses_m1test",
      agent: "agent_m1test",
      action: "codearts.manage",
      resources: ["install"],
      save: ["install"],
      source: { type: "tool", messageID: "msg_m1test", id: "call_m1test" },
    });
  });

  it("真 only-delete（无备份）：content 返回 BIN_MISSING_NO_BACKUP + remediation（R-t1 结构化错误）", async () => {
    const fixture = await makeInstallFixture(path.join(TEST_ROOT, "repair-nobackup"), "only-delete");
    const perm = makePermissionFake();
    const { ctx, added } = makeFakeContext({ permission: perm.permission });
    await fixturePlugin(fixture).setup(ctx);

    const result = await toolOf(added, "repair").execute({}, TOOL_CTX);
    const payload = jsonOf(result);
    expect(payload.error.code).toBe("BIN_MISSING_NO_BACKUP");
    expect(payload.error.message).toContain(fixture.binPath);
    // remediation 四要素：.delete 残留检查 / 官方重装 / 备份恢复指引 / 官方入口
    expect(payload.error.remediation).toContain("codearts.delete");
    expect(payload.error.remediation).toContain("https://codearts.huaweicloud.com");
    // 二进制仍未恢复、无审计
    expect(await auditExists(fixture.stateDir)).toBe(false);
  });

  it("fixAutoupdate 透传（修复路径）：修复同时把 autoupdate 关停且保留未知字段", async () => {
    const fixture = await makeInstallFixture(path.join(TEST_ROOT, "repair-fixauto"), "missing");
    await writeFile(fixture.cliPath, JSON.stringify({ autoupdate: true, vendorExtra: 1 }), "utf8");
    const perm = makePermissionFake();
    const { ctx, added } = makeFakeContext({ permission: perm.permission });
    await fixturePlugin(fixture).setup(ctx);

    const payload = jsonOf(await toolOf(added, "repair").execute({ fixAutoupdate: true }, TOOL_CTX));
    expect(payload.status).toBe("repaired");
    const after = JSON.parse(await readFile(fixture.cliPath, "utf8")) as Record<string, unknown>;
    expect(after["autoupdate"]).toBe(false);
    expect(after["vendorExtra"]).toBe(1);
  });

  it("fixAutoupdate 透传（健康路径）：already-healthy 短路不丢显式请求", async () => {
    const fixture = await makeInstallFixture(path.join(TEST_ROOT, "repair-healthy-fixauto"), "healthy");
    await writeFile(fixture.cliPath, JSON.stringify({ autoupdate: true, vendorExtra: 1 }), "utf8");
    const perm = makePermissionFake();
    const { ctx, added } = makeFakeContext({ permission: perm.permission });
    await fixturePlugin(fixture).setup(ctx);

    const payload = jsonOf(await toolOf(added, "repair").execute({ fixAutoupdate: true }, TOOL_CTX));
    expect(payload.status).toBe("already-healthy");
    expect(payload.fixAutoupdateApplied).toBe(true);
    const after = JSON.parse(await readFile(fixture.cliPath, "utf8")) as Record<string, unknown>;
    expect(after["autoupdate"]).toBe(false);
    expect(after["vendorExtra"]).toBe(1);
    // 幂等路径的审计 = fix-autoupdate 一条（健康路径无 repair 审计）
    const lines = await readAuditLines(fixture.stateDir);
    expect(lines.filter((l) => l["kind"] === "fix-autoupdate")).toHaveLength(1);
    expect(lines.filter((l) => l["kind"] === "repair")).toHaveLength(0);
  });

  it("权限被拒：PERMISSION_DENIED 结构化返回且不执行（R-t2）", async () => {
    const fixture = await makeInstallFixture(path.join(TEST_ROOT, "repair-denied"), "missing");
    const perm = makePermissionFake({ deny: true });
    const { ctx, added } = makeFakeContext({ permission: perm.permission });
    await fixturePlugin(fixture).setup(ctx);

    const payload = jsonOf(await toolOf(added, "repair").execute({}, TOOL_CTX));
    expect(payload.error.code).toBe("PERMISSION_DENIED");
    expect(perm.calls).toHaveLength(1); // 过门一次，被拒不重试
    expect(await auditExists(fixture.stateDir)).toBe(false); // 未执行
  });
});

/* ───── codearts_upgrade ───── */

describe("codearts_upgrade", () => {
  it("happy path：权限门精确断言 + 受控升级成功（fake fetcher/extract/exec，绝不联网）", async () => {
    const fixture = await makeInstallFixture(path.join(TEST_ROOT, "upgrade-ok"), "healthy");
    const extractCalls: Array<{ pkg: string; destDir: string }> = [];
    const fetcher = makeFakeFetcher();
    const execCalls: string[][] = [];
    const perm = makePermissionFake();
    const { ctx, added } = makeFakeContext({ permission: perm.permission });
    await buildPlugin({
      configOverrides: { installDir: fixture.installDir, stateDir: fixture.stateDir },
      // 升级链用 content-driven exec（按目标文件 VERSION= 标记回答 --version）：
      // 旧 fixture 无标记 → from=unknown；新 ELF 有 VERSION=26.11.0 → 自检/复验通过
      exec: contentVersionExec(execCalls),
      kernelDataDir: path.join(fixture.root, "cli-data"),
      fetcher,
      extract: copyExtract(DEFAULT_LAYOUT, extractCalls),
    }).setup(ctx);

    const result = await toolOf(added, "upgrade").execute({}, TOOL_CTX);
    const payload = jsonOf(result);

    expect(payload.status).toBe("upgraded");
    expect(payload.from).toBe("unknown"); // 旧 fixture 无 VERSION 标记 → 版本不可读（如实呈现）
    expect(payload.to).toBe(NEW_VERSION);
    expect(payload.sha256).toBe(sha256Oracle(NEW_ELF_CONTENT));
    expect(payload.auditId).toMatch(/^upg-/);
    expect(extractCalls).toHaveLength(1);
    // 升级落地复核
    expect(await sha256File(fixture.binPath)).toBe(sha256Oracle(NEW_ELF_CONTENT));
    // 权限门：action/resources/save/source 精确断言（R-t2）
    expect(perm.calls).toHaveLength(1);
    expect(perm.calls[0]).toMatchObject({
      sessionID: "ses_m1test",
      agent: "agent_m1test",
      action: "codearts.manage",
      resources: ["install"],
      save: ["install"],
      source: { type: "tool", messageID: "msg_m1test", id: "call_m1test" },
    });
  });

  it("权限被拒：PERMISSION_DENIED 且 fetcher 零调用（不执行）", async () => {
    const fixture = await makeInstallFixture(path.join(TEST_ROOT, "upgrade-denied"), "healthy");
    let latestCalls = 0;
    const inner = makeFakeFetcher();
    const countingFetcher = {
      latest: async () => {
        latestCalls += 1;
        return inner.latest();
      },
      download: inner.download,
    };
    const perm = makePermissionFake({ deny: true });
    const { ctx, added } = makeFakeContext({ permission: perm.permission });
    await fixturePlugin(fixture, {
      fetcher: countingFetcher as typeof inner,
      extract: copyExtract(DEFAULT_LAYOUT),
    }).setup(ctx);

    const payload = jsonOf(await toolOf(added, "upgrade").execute({}, TOOL_CTX));
    expect(payload.error.code).toBe("PERMISSION_DENIED");
    expect(latestCalls).toBe(0); // 未执行任何网络动作
    expect(await auditExists(fixture.stateDir)).toBe(false); // 无 upgrade.start 审计
  });
});

/* ───── codearts_hygiene ───── */

/** hygiene fixture：1 个到期转储 + 热 WAL（保持连接不关）+ N 个内核日志。 */
async function makeHygieneFixture(root: string, logs: number): Promise<string> {
  const kernelDataDir = path.join(root, "cli-data");
  const logDir = path.join(kernelDataDir, "log");
  await mkdir(logDir, { recursive: true });
  const dump = path.join(logDir, "dump-old.heapsnapshot");
  await writeFile(dump, "heap snapshot payload", "utf8");
  const old = new Date(Date.now() - 31 * DAY_MS);
  await utimes(dump, old, old);
  // 热 WAL：连接故意不关（进程退出即回收），保持 WAL 非自愈态供 checkpoint
  const db = new Database(path.join(kernelDataDir, "opencode.db"));
  db.run("PRAGMA journal_mode=WAL");
  db.run("CREATE TABLE t(x TEXT)");
  db.run("INSERT INTO t VALUES ('hot')");
  for (let i = 0; i < logs; i++) {
    await writeFile(
      path.join(logDir, `kernel-h-${i}.log`),
      `INFO  2026-10-30T20:00:0${i}.000 +1ms service=session "ok"\n`,
      "utf8",
    );
  }
  return kernelDataDir;
}

describe("codearts_hygiene", () => {
  it("apply=false 只返回计划：零权限调用、零审计、零删除", async () => {
    const kernelDataDir = await makeHygieneFixture(path.join(TEST_ROOT, "hy-plan"), 3);
    const stateDir = path.join(TEST_ROOT, "hy-plan", "state");
    const perm = makePermissionFake();
    const { ctx, added } = makeFakeContext({ permission: perm.permission });
    await buildPlugin({
      configOverrides: { installDir: path.join(TEST_ROOT, "hy-plan", "installers"), stateDir },
      exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      kernelDataDir,
    }).setup(ctx);

    const payload = jsonOf(await toolOf(added, "hygiene").execute({ apply: false, olderThanDays: 30, logsKeep: 1 }, TOOL_CTX));
    expect(payload.status).toBe("planned");
    expect(payload.plan.map((a: { kind: string }) => a.kind)).toEqual([
      "purge-dumps",
      "wal-checkpoint",
      "rotate-logs",
    ]);
    expect(perm.calls).toHaveLength(0); // 只读计划不走权限门
    expect(await auditExists(stateDir)).toBe(false); // 纯只读不写审计
    // 未删除任何文件
    await expect(stat(path.join(kernelDataDir, "log", "dump-old.heapsnapshot"))).resolves.toBeDefined();
  });

  it("apply=true 走权限门（resources=state）且执行清单=计划清单", async () => {
    const kernelDataDir = await makeHygieneFixture(path.join(TEST_ROOT, "hy-apply"), 3);
    const stateDir = path.join(TEST_ROOT, "hy-apply", "state");
    const perm = makePermissionFake();
    const { ctx, added } = makeFakeContext({ permission: perm.permission });
    await buildPlugin({
      configOverrides: { installDir: path.join(TEST_ROOT, "hy-apply", "installers"), stateDir },
      exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      kernelDataDir,
    }).setup(ctx);

    const result = await toolOf(added, "hygiene").execute({ apply: true, olderThanDays: 30, logsKeep: 1 }, TOOL_CTX);
    const payload = jsonOf(result);

    // 执行清单 = 计划清单（R-hy4）
    const kinds = payload.plan.map((a: { kind: string }) => a.kind);
    expect(kinds).toEqual(["purge-dumps", "wal-checkpoint", "rotate-logs"]);
    expect(payload.applied).toEqual(kinds);
    expect(payload.auditId).toMatch(/^hy-/);

    // 权限门：hygiene(apply=true) → resources/save=["state"]（R-t2）
    expect(perm.calls).toHaveLength(1);
    expect(perm.calls[0]).toMatchObject({
      action: "codearts.manage",
      resources: ["state"],
      save: ["state"],
      source: { type: "tool", messageID: "msg_m1test", id: "call_m1test" },
    });

    // 落地复核：转储已删、日志轮转 2/3、WAL checkpoint 收敛
    await expect(stat(path.join(kernelDataDir, "log", "dump-old.heapsnapshot"))).rejects.toThrow();
    const lines = await readAuditLines(stateDir);
    const entry = lines.find((l) => l["kind"] === "hygiene.apply");
    expect(entry).toBeDefined();
    expect(entry!["result"]).toBe("ok");
    expect(entry!["auditId"]).toBe(payload.auditId);
    expect(entry!["rotatedCount"]).toBe(2);
    const wal = entry!["walCheckpoint"] as Record<string, unknown>;
    expect(wal["busy"]).toBe(0);
  });

  it("apply=true 权限被拒：PERMISSION_DENIED、零删除、零审计", async () => {
    const kernelDataDir = await makeHygieneFixture(path.join(TEST_ROOT, "hy-denied"), 3);
    const stateDir = path.join(TEST_ROOT, "hy-denied", "state");
    const perm = makePermissionFake({ deny: true });
    const { ctx, added } = makeFakeContext({ permission: perm.permission });
    await buildPlugin({
      configOverrides: { installDir: path.join(TEST_ROOT, "hy-denied", "installers"), stateDir },
      exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      kernelDataDir,
    }).setup(ctx);

    const payload = jsonOf(
      await toolOf(added, "hygiene").execute({ apply: true, olderThanDays: 30, logsKeep: 1 }, TOOL_CTX),
    );
    expect(payload.error.code).toBe("PERMISSION_DENIED");
    expect(await auditExists(stateDir)).toBe(false);
    await expect(stat(path.join(kernelDataDir, "log", "dump-old.heapsnapshot"))).resolves.toBeDefined();
  });
});

/* ───── codearts_health ───── */

describe("codearts_health", () => {
  it("返回 collectHealth 快照（fake cli-data：db/wal/dumps/日志错误/自报 RSS）", async () => {
    const kernelDataDir = path.join(TEST_ROOT, "health-fixture", "cli-data");
    const logDir = path.join(kernelDataDir, "log");
    await mkdir(logDir, { recursive: true });
    await writeFile(path.join(kernelDataDir, "opencode.db"), "sqlite-db-bytes", "utf8");
    await writeFile(path.join(kernelDataDir, "opencode.db-wal"), "wal-bytes", "utf8");
    await writeFile(path.join(logDir, "dump-1.heapsnapshot"), "d".repeat(100), "utf8");
    const kernelLine =
      'INFO  2026-10-31T10:00:01.000 +1ms service=om "当前进程内存使用情况" rssMB=10\n';
    const errorLine = 'ERROR  2026-10-31T10:00:00.000 +5ms service=test "boom" code=EIO\n';
    await writeFile(path.join(logDir, "kernel-a.log"), errorLine + kernelLine, "utf8");

    const stateDir = path.join(TEST_ROOT, "health-fixture", "state");
    const perm = makePermissionFake();
    const { ctx, added } = makeFakeContext({ permission: perm.permission });
    await buildPlugin({
      configOverrides: { installDir: path.join(TEST_ROOT, "health-fixture", "installers"), stateDir },
      exec: { run: async () => ({ code: 0, stdout: "", stderr: "" }) },
      kernelDataDir,
    }).setup(ctx);

    const result = await toolOf(added, "health").execute({}, TOOL_CTX);
    const payload = jsonOf(result);

    expect(payload.status).toBe("ok");
    expect(payload.health.dbBytes).toBe("sqlite-db-bytes".length);
    expect(payload.health.walBytes).toBe("wal-bytes".length);
    expect(payload.health.dumps).toEqual({ files: 1, bytes: 100 });
    // 快照契约 = collectHealth 原样返回（logs 为 {bytes}，lastErrors 为字符串数组）
    expect(payload.health.logs).toEqual({ bytes: 100 + Buffer.byteLength(errorLine + kernelLine, "utf8") });
    expect(payload.health.lastErrors).toHaveLength(1);
    expect(payload.health.lastErrors[0]).toContain('service=test "boom"');
    expect(payload.health.kernelRssFromLog).toBe(10 * 1024 * 1024);
    expect(perm.calls).toHaveLength(0); // health 只读不走权限门
    expect(humanOf(result)).toContain("codearts_health");
  });
});

/* ───── 钉版写入辅助回归（fixtures 共享出口仍可用） ───── */

describe("fixture 共享出口", () => {
  it("writePinnedFile 保持既有格式契约", async () => {
    const stateDir = path.join(TEST_ROOT, "pin-helpers", "state");
    await writePinnedFile(stateDir, { version: "1.2.3", sha256: "a".repeat(64) });
    const raw = JSON.parse(await readFile(path.join(stateDir, "pinned.json"), "utf8")) as Record<string, unknown>;
    expect(raw["version"]).toBe("1.2.3");
    expect(raw["sha256"]).toBe("a".repeat(64));
  });
});
