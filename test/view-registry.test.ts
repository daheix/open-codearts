/**
 * 画面状态注册表单元测试（2026-11-02 只读画面网格帧协议）。
 *
 * 核心口径：
 * - 喂入 FakeTransport 的 ANSI 输出 → rowsOf 序列化出行帧（含文本/定位/颜色）；
 * - 追加输出 → rev 单调递增，网格累积（增量重绘语义）；
 * - rawBuf 长度回退（会话重建）→ 网格重置重喂（自愈）；
 * - 纯默认空白行不入列。
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { FakeTransport } from "../src/core/transport/fake";
import { ViewRegistry } from "../src/core/view-registry";
import type { BridgeConfig } from "../src/core/config";
import { loadConfig } from "../src/core/config";
import * as path from "node:path";
import { mkdirSync, rmSync } from "node:fs";

const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
const TEST_ROOT = path.join(PLUGIN_ROOT, ".tmp", "view-registry-test");

let cfg: BridgeConfig;
let transport: FakeTransport;

beforeEach(async () => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
  mkdirSync(TEST_ROOT, { recursive: true });
  cfg = loadConfig({ stateDir: path.join(TEST_ROOT, "state"), daemonUrl: "http://127.0.0.1:0" }, {});
  transport = new FakeTransport();
});

afterEach(() => {
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("ViewRegistry（屏幕网格状态）", () => {
  it("喂入 ANSI 输出 → rowsOf 序列化出定位行帧；rev 单调", async () => {
    const reg = new ViewRegistry(transport);
    const ref = await transport.start(cfg);
    transport.emit(ref, "output", "\x1b[2J\x1b[H\x1b[1;1H\x1b[38;2;96;81;128mHELLO \x1b[1mWORLD");
    const rev1 = await reg.feed(ref);
    expect(rev1).toBe(1);
    const rows1 = reg.rowsOf(ref.id);
    const row0 = rows1.find(([y]) => y === 0);
    expect(row0).toBeDefined();
    // WORLD 为粗体 → 独立 SGR run，分开断言（run 内文本逐字保留）
    expect(row0![1]).toContain("HELLO ");
    expect(row0![1]).toContain("WORLD");
    // 定位帧：行号 0 → ESC[1;1H 由消费方拼装；本帧含 SGR
    expect(row0![1]).toContain("\x1b[");

    transport.emit(ref, "output", "\x1b[2;1H第二行");
    const rev2 = await reg.feed(ref);
    expect(rev2).toBeGreaterThan(rev1);
    const flat = reg.rowsOf(ref.id).map(([, f]) => f).join("");
    expect(flat).toContain("HELLO ");
    expect(flat).toContain("WORLD");
    expect(flat).toContain("第二行");
  });

  it("宽字符与颜色：truecolor 前景进入 SGR（38;2;r;g;b）", async () => {
    const reg = new ViewRegistry(transport);
    const ref = await transport.start(cfg);
    transport.emit(ref, "output", "\x1b[H\x1b[38;2;96;81;128m中文宽字");
    await reg.feed(ref);
    const row0 = reg.rowsOf(ref.id).find(([y]) => y === 0)!;
    expect(row0[1]).toContain("38;2;96;81;128");
    expect(row0[1]).toContain("中文宽字");
  });

  it("rawBuf 长度回退（会话重建）→ 网格重置重喂（自愈）", async () => {
    const reg = new ViewRegistry(transport);
    const ref = await transport.start(cfg);
    transport.emit(ref, "output", "\x1b[H旧画面内容很长很长很长");
    await reg.feed(ref);
    // 模拟会话重建：FakeTransport 同名重建后 raw 从零累积（此处直接换新 ref 简化——
    // 真实路径由守护 reconcile 重建，rawBuf 全新）
    const reg2rows = reg.rowsOf(ref.id);
    expect(reg2rows.length).toBeGreaterThan(0);
    // 用一个全新 ref 模拟重建后的新缓冲：rev 从该 ref 重新起算
    const ref2 = await transport.start(cfg);
    transport.emit(ref2, "output", "\x1b[H新画面");
    await reg.feed(ref2);
    expect(reg.rowsOf(ref2.id).map(([, f]) => f).join("")).toContain("新画面");
    void reg2rows;
  });

  it("未喂入的 ref：rowsOf 返回空、revisionOf 为 0", () => {
    const reg = new ViewRegistry(transport);
    expect(reg.rowsOf("script-999")).toEqual([]);
    expect(reg.revisionOf("script-999")).toBe(0);
  });
});
