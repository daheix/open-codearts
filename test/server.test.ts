/**
 * 插件入口层测试（T1-01 骨架 → T1-08 M1 五工具接线后更新）。
 *
 * 覆盖：
 * 1. default 导出是 id 为 "codearts-bridge" 的插件定义（Plugin.Plugin 形状）；
 * 2. setup 恰好注册五个 M1 工具（名称集合断言；逐工具的 namespace/schema 精确断言
 *    在 test/m1-acceptance.test.ts）；
 * 3. 运行时不兼容守卫：宿主上下文缺 tool.transform 时显式 throw（修复环 I1 保持）；
 * 4. status 工具以 content 返回（R-t1 新语义，替代 T1-01 的 {output} 冒烟契约）；
 *    用注入 fixture 的 buildPlugin 实例验证，绝不触碰真实 HOME。
 */
import { describe, expect, it } from "bun:test";
import { Plugin } from "@opencode/plugin";
import plugin, { buildPlugin, TOOL_NAMES } from "../src/server";
import { PLUGIN_ID } from "../src/core/config";
import { makeInstallFixture } from "./fixtures/install-fixtures";
import * as path from "node:path";
import * as fs from "node:fs/promises";

/** add 被调用时捕获到的工具信息（只取测试关心的字段）。 */
interface CapturedTool {
  name: string;
  options?: { namespace?: string };
  execute: (input: unknown, context: unknown) => Promise<unknown>;
}

/** 按 @opencode/plugin 的 ToolDomain.transform 契约构造 fake ctx。 */
function makeFakeContext(permission: unknown = undefined): { ctx: unknown; added: CapturedTool[] } {
  const added: CapturedTool[] = [];
  const ctx = {
    options: {},
    permission,
    tool: {
      transform: async (cb: (editor: unknown) => void) => {
        cb({
          add: (tool: CapturedTool) => {
            added.push(tool);
          },
        });
        return { dispose: async () => {} };
      },
    },
  };
  return { ctx, added };
}

/** 把 fake ctx 断言成宿主上下文类型（单测标准做法；真实契约由编译期保证）。 */
function asHostContext(ctx: unknown): Parameters<typeof plugin.setup>[0] {
  return ctx as Parameters<typeof plugin.setup>[0];
}

describe("codearts-bridge 插件入口", () => {
  it("default export is a plugin definition with id \"codearts-bridge\"", () => {
    expect(plugin).toBeDefined();
    const shapeCheck: Plugin.Plugin = plugin;
    expect(shapeCheck.id).toBe(PLUGIN_ID);
    expect(plugin.id).toBe("codearts-bridge");
    expect(typeof plugin.setup).toBe("function");
  });

  it("setup 恰好注册五个 M1 工具（TOOL_NAMES 精确集合）", async () => {
    const { ctx, added } = makeFakeContext();
    await plugin.setup(asHostContext(ctx));
    expect(added.map((t) => t.name)).toEqual([...TOOL_NAMES]);
    expect(`${added[0]!.options?.namespace}_${added[0]!.name}`).toBe("codearts_status");
  });

  it("setup 在宿主上下文缺 tool.transform 时抛出含契约信息的错误（修复环 I1）", async () => {
    // 不兼容宿主的两类形态：完全缺 tool 字段 / tool 存在但缺 transform
    for (const badCtx of [{}, { tool: {} }]) {
      let caught: unknown;
      try {
        await plugin.setup(asHostContext(badCtx));
      } catch (e) {
        caught = e;
      }
      // 出错即显式报错：必须抛出，禁止 console.error 后静默跳过
      expect(caught).toBeInstanceOf(Error);
      const message = (caught as Error).message;
      // 错误消息须含：插件 id、缺失项、期望契约（opencode V2 插件 API）
      expect(message).toContain(PLUGIN_ID);
      expect(message).toContain("tool.transform");
      expect(message).toContain("opencode V2");
    }
  });

  it("status 工具以 content 返回结构化 JSON（R-t1 语义；注入 fixture 隔离真实 HOME）", async () => {
    const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
    const fixture = await makeInstallFixture(
      path.join(PLUGIN_ROOT, ".tmp", "server-smoke-test"),
      "healthy",
    );
    try {
      const isolated = buildPlugin({
        configOverrides: { installDir: fixture.installDir, stateDir: fixture.stateDir },
        exec: fixture.exec,
        kernelDataDir: path.join(fixture.root, "cli-data"),
      });
      const { ctx, added } = makeFakeContext();
      await isolated.setup(asHostContext(ctx));
      const status = added.find((t) => t.name === "status");
      expect(status).toBeDefined();
      const result = (await status!.execute({}, {})) as {
        content: Array<{ type: string; text: string }>;
      };
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]!.type).toBe("text");
      const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
      expect((payload.bridge as Record<string, unknown>).version).toBe("dev");
      expect((payload.install as Record<string, unknown>).present).toBe(true);
    } finally {
      await fs.rm(path.join(PLUGIN_ROOT, ".tmp", "server-smoke-test"), { recursive: true, force: true });
    }
  });
});
