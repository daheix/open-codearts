/**
 * T3-03 监督状态机测试（bun:test）——语义源：codeartsGUI `src/goalrunner.cpp`
 * + `src/retryengine.cpp`（v0.2.6）逐条移植；策略参数对齐 spec §6.3.2。
 *
 * 裁定依据（progress.md Task 16 派发记录）：
 * - R-rn1 纯 tick：一切时间推进由假时钟 + tick() 驱动，runner 内无定时器；
 * - R-rn2 并发串行化："pause 后并发 tick 不产生注入"有专测钉死；
 * - R-rn3 策略默认：停滞 60s / 重试无上限（首立即 60s 封顶 ≥10 告警）/
 *   strikes≥3 告警不终止 / done+verify 双过 / verify fail 注入继续；
 * - R-rn4 增量口径：文本变化指纹 + 信号批次密度双口径（重绘欺骗与转轮
 *   高频两类 v0.2.6 教训各有用例）；
 * - R-rn5 classifyModelError/normalizeReceived 移植（含 `\\b`→`\b` 适配）。
 */
import { describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import type { BridgeConfig } from "../src/core/config";
import { loadConfig } from "../src/core/config";
import {
  CONTINUE_PROMPT,
  buildContract,
  buildResumeContract,
} from "../src/core/goal/protocol";
import {
  GoalRunner,
  classifyModelError,
  normalizeReceived,
  type GoalState,
  type RunnerDeps,
} from "../src/core/goal/runner";
import { BridgeError } from "../src/core/errors";
import { FakeTransport } from "../src/core/transport/fake";
import { createScriptTransport, type PtyChild } from "../src/core/transport/pty-script";
import type { CodeartsTransport, SessionRef } from "../src/core/transport/types";

/* ───── 测试台架：假时钟 + FakeTransport + 审计/log 收集 ───── */

interface AuditEvent {
  type: string;
  [k: string]: unknown;
}

interface Harness {
  transport: FakeTransport;
  audits: AuditEvent[];
  logs: AuditEvent[];
  deps: RunnerDeps;
  state: GoalState;
  advance(ms: number): void;
  now(): number;
  verifyCalls: string[][];
}

/** 默认 verifyRun：全部通过并记录调用 argv；传 failAt 使第 idx 条（0 基）失败。 */
function makeHarness(opts?: {
  verify?: string[];
  failAt?: number;
  failOut?: string;
  session?: SessionRef;
  injected?: string[];
}): Harness {
  const transport = new FakeTransport();
  const audits: AuditEvent[] = [];
  const logs: AuditEvent[] = [];
  const verifyCalls: string[][] = [];
  let t = 1_000_000;
  const failAt = opts?.failAt ?? -1;
  const deps: RunnerDeps = {
    clock: { now: () => t },
    transport,
    audit: (e) => audits.push(e as AuditEvent),
    log: (e) => logs.push(e as AuditEvent),
    thresholds: { stallSeconds: 60, retryCapSeconds: 60, strikes: 3, echoGuardMs: 3000 },
    verifyRun:
      opts?.verify === undefined
        ? undefined
        : async (cmd: string[]) => {
            verifyCalls.push(cmd);
            const idx = verifyCalls.length - 1;
            if (idx === failAt) return { ok: false, out: opts?.failOut ?? "FAIL" };
            return { ok: true, out: "OK" };
          },
  };
  const state: GoalState = {
    goalId: "g1",
    objective: "实现登录页",
    verify: opts?.verify ?? [],
    phase: "active",
    rounds: 0,
    steps: [],
    strikes: 0,
    injected: opts?.injected ?? [],
    lastProgressAt: t,
    session: opts?.session,
  };
  return {
    transport,
    audits,
    logs,
    deps,
    state,
    verifyCalls,
    advance: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

function ofType(h: Harness, type: string): AuditEvent[] {
  return h.audits.filter((e) => e.type === type);
}

/** 构造 runner 并完成引导 tick（新会话 + 契约注入）。 */
async function boot(h: Harness): Promise<GoalRunner> {
  const r = new GoalRunner(h.state, h.deps);
  await r.tick();
  return r;
}

const EMPTY_CFG = {} as BridgeConfig;

/* ───── 构造校验（显式报错，禁静默兜底） ───── */

describe("构造校验", () => {
  it("goalId 为空 → GOAL_STATE_INVALID", () => {
    const h = makeHarness();
    h.state.goalId = "";
    expect(() => new GoalRunner(h.state, h.deps)).toThrow(BridgeError);
    try {
      new GoalRunner(h.state, h.deps);
    } catch (e) {
      expect((e as BridgeError).code).toBe("GOAL_STATE_INVALID");
    }
  });

  it("objective 为空白 → GOAL_STATE_INVALID", () => {
    const h = makeHarness();
    h.state.objective = "   ";
    expect(() => new GoalRunner(h.state, h.deps)).toThrow(BridgeError);
  });

  it("终态 phase 构造 → GOAL_STATE_INVALID（complete/stopped 不可作为运行态）", () => {
    const h = makeHarness();
    h.state.phase = "stopped";
    expect(() => new GoalRunner(h.state, h.deps)).toThrow(BridgeError);
  });

  it("verify 非空但无 verifyRun → GOAL_VERIFY_RUN_MISSING（fail-fast）", () => {
    const h = makeHarness();
    h.state.verify = ["bun test"];
    h.deps.verifyRun = undefined;
    expect(() => new GoalRunner(h.state, h.deps)).toThrow(BridgeError);
    try {
      new GoalRunner(h.state, h.deps);
    } catch (e) {
      expect((e as BridgeError).code).toBe("GOAL_VERIFY_RUN_MISSING");
    }
  });

  it("state() 返回副本：改写返回值数组不渗入内部状态", async () => {
    const h = makeHarness();
    const r = await boot(h);
    const s = r.state();
    s.steps.push(99);
    s.injected.push("污染");
    expect(r.state().steps).toEqual([]);
    expect(r.state().injected.length).toBe(1);
  });
});

/* ───── 引导与契约 ───── */

describe("引导与契约", () => {
  it("首次 tick 无会话 → start 新会话 + 注入契约 + goal.start 审计 + rounds=1", async () => {
    const h = makeHarness({ verify: ["bun test"] });
    const r = await boot(h);
    const st = r.state();
    expect(st.session).not.toBeUndefined();
    expect(h.transport.injections.length).toBe(1);
    expect(h.transport.injections[0]!.text).toBe(buildContract("实现登录页", ["bun test"]));
    expect(st.rounds).toBe(1);
    expect(ofType(h, "goal.start").length).toBe(1);
    expect(ofType(h, "goal.inject").length).toBe(1);
  });

  it("对账恢复：已带存活会话且 injected 为空 → 注入契约重锚；injected 非空 → 不重复注入", async () => {
    // 变体 A：injected 空 → 重锚契约
    const ha = makeHarness();
    ha.state.session = await ha.transport.start(EMPTY_CFG);
    const ra = new GoalRunner(ha.state, ha.deps);
    await ra.tick();
    expect(ha.transport.injections.length).toBe(1);
    // 变体 B：injected 非空（持久化恢复）→ 不注入
    const hb = makeHarness({ injected: ["【/goal 目标契约】旧会话已下发…"] });
    hb.state.session = await hb.transport.start(EMPTY_CFG);
    const rb = new GoalRunner(hb.state, hb.deps);
    await rb.tick();
    expect(hb.transport.injections.length).toBe(0);
    expect(rb.state().phase).toBe("active");
  });
});

/* ───── 停滞看门狗（R-rn4 双口径） ───── */

describe("停滞看门狗", () => {
  it("stall: 无新信号推进 60s → 注入 CONTINUE_PROMPT（一次）；再 60s 无进展 → 再注入", async () => {
    const h = makeHarness();
    const r = await boot(h);
    expect(h.transport.injections.length).toBe(1);
    h.advance(61_000);
    await r.tick();
    expect(h.transport.injections.length).toBe(2);
    expect(h.transport.injections[1]!.text).toContain(CONTINUE_PROMPT);
    // 同一停滞窗口内重复 tick 不重复注入（一次）
    await r.tick();
    await r.tick();
    expect(h.transport.injections.length).toBe(2);
    // 再 60s 无进展 → 再注入
    h.advance(61_000);
    await r.tick();
    expect(h.transport.injections.length).toBe(3);
  });

  it("fast output: 3s 内 ≥12 块 → 判活刷新不打断（不注入）；静默超阈值后才注入", async () => {
    const h = makeHarness();
    const r = await boot(h);
    const ref = r.state().session!;
    // 12 块布在 1.2s 内（同文本，文本指纹不刷新——专验批次密度口径）
    for (let i = 0; i < 12; i++) {
      h.advance(100);
      h.transport.emit(ref, "output", "working");
    }
    h.advance(59_600); // 距最后一块（按消费时刻计）59.6s < 60s
    await r.tick();
    expect(h.transport.injections.length).toBe(1); // 不打断（批次密度刷新判活）
    h.advance(61_000); // 距信号消费时刻 61s ≥ 60s（头注分歧 5：计时刻=消费时刻）
    await r.tick();
    expect(h.transport.injections.length).toBe(2); // 静默后注入
  });

  it("重绘欺骗：文本重复重绘不刷新活动指纹（低频、批次不足）→ 仍判停滞注入", async () => {
    const h = makeHarness();
    const r = await boot(h);
    const ref = r.state().session!;
    // 首次出现的新文本刷新一次活动基线（C++ 同语义），随后每次重绘单独消费：
    // feed 确实执行了 5 次，但指纹相同 → 基线纹丝不动。
    h.advance(1_000);
    h.transport.emit(ref, "output", "⠋ 加载中");
    await r.tick(); // 消费：基线 = t0+1s
    for (let i = 1; i <= 5; i++) {
      h.advance(10_000);
      h.transport.emit(ref, "output", "⠋ 加载中"); // 每次相同文本
      await r.tick(); // 逐次消费：不刷新（批次 1<12、指纹未变）
    }
    h.advance(11_000); // t0+62s：距唯一一次基线刷新 61s ≥ 60s
    await r.tick();
    expect(h.transport.injections.length).toBe(2); // 重绘骗不过看门狗
  });

  it("nudge 文本为轻量继续指令（含 CONTINUE_PROMPT 与续跑协议提示），非全文契约", async () => {
    const h = makeHarness();
    const r = await boot(h);
    h.advance(61_000);
    await r.tick();
    const text = h.transport.injections[1]!.text;
    expect(text).toContain(CONTINUE_PROMPT);
    expect(text).toContain("[GOAL-STEP n/N]");
    expect(text).not.toContain("【/goal 目标契约】");
  });
});

/* ───── 错误重试（RetryEngine 移植：首立即 / 60s 封顶 / ≥10 告警不停止） ───── */

describe("错误重试", () => {
  it("retryable error 信号：首次立即重试（无时钟推进）", async () => {
    const h = makeHarness();
    const r = await boot(h);
    const ref = r.state().session!;
    h.transport.emit(ref, "error", "Request timed out");
    await r.tick();
    expect(h.transport.injections.length).toBe(2); // 立即
    expect(ofType(h, "goal.retry").length).toBe(1);
  });

  it("连续失败：退避 60s 封顶（59s 不注、60s 注，不随次数增长）", async () => {
    const h = makeHarness();
    const r = await boot(h);
    const ref = r.state().session!;
    h.transport.emit(ref, "error", "Request timed out");
    await r.tick(); // 立即（#2）
    h.transport.emit(ref, "error", "429 too many requests");
    await r.tick(); // 未到期
    expect(h.transport.injections.length).toBe(2);
    h.advance(59_000);
    await r.tick();
    expect(h.transport.injections.length).toBe(2); // 59s 不到期
    h.advance(1_000);
    await r.tick();
    expect(h.transport.injections.length).toBe(3); // 60s 到期
  });

  it("连续 10 次：≥10 告警事件（不停止、不转 blocked）", async () => {
    const h = makeHarness();
    const r = await boot(h);
    const ref = r.state().session!;
    h.transport.emit(ref, "error", "Request timed out");
    await r.tick(); // #1 立即
    h.transport.emit(ref, "error", "ECONNRESET");
    await r.tick(); // #2 未决
    h.advance(60_000);
    await r.tick(); // #2 到期注入
    expect(h.transport.injections.length).toBe(3);
    for (let i = 3; i <= 10; i++) {
      h.transport.emit(ref, "error", "fetch failed");
      await r.tick(); // 入队未决
      h.advance(60_000);
      await r.tick(); // 到期注入
    }
    expect(h.transport.injections.length).toBe(11);
    const warns = ofType(h, "goal.warning").filter((e) => e.reason === "consecutive-errors");
    expect(warns.length).toBeGreaterThanOrEqual(1);
    expect(r.state().phase).toBe("active"); // 不停止
  });

  it("output 正文中错误词样同样触发重试；但含步骤标记的行进度优先不误判", async () => {
    const h = makeHarness();
    const r = await boot(h);
    const ref = r.state().session!;
    h.transport.emit(ref, "output", "请求已超时，请稍后重试");
    await r.tick();
    expect(h.transport.injections.length).toBe(2); // 触发重试
    // 步骤行含"超时"字样：进度优先，不按错误处理（C++ feed 同语义）
    h.transport.emit(ref, "output", "[GOAL-STEP 1/3] 处理超时重试 | 推荐方案: 指数退避");
    await r.tick();
    expect(h.transport.injections.length).toBe(2); // 不误判
  });

  it("error 信号分类 refusal → 转 blocked（等人工）+ goal.error 审计；resume 可恢复", async () => {
    const h = makeHarness();
    const r = await boot(h);
    const ref = r.state().session!;
    h.transport.emit(ref, "error", "request refused by content policy");
    await r.tick();
    expect(r.state().phase).toBe("blocked");
    expect(h.transport.injections.length).toBe(1); // blocked 不注入
    const errs = ofType(h, "goal.error");
    expect(errs.length).toBe(1);
    expect(errs[0]!.fatal).toBe(true);
    expect(errs[0]!.kind).toBe("refusal");
    await r.resume();
    expect(r.state().phase).toBe("active");
    expect(h.transport.injections.length).toBe(2);
  });

  it("output 正文出现 refusal 词样 → 仍按重试处理不转 blocked（防方案描述误判中断）", async () => {
    const h = makeHarness();
    const r = await boot(h);
    const ref = r.state().session!;
    h.transport.emit(ref, "output", "若用户请求被拒绝（content policy），应提示用户");
    await r.tick();
    expect(r.state().phase).toBe("active");
    expect(h.transport.injections.length).toBe(2); // 重试注入
  });
});

/* ───── strikes 循环保护（重启/续跑无进展） ───── */

describe("strikes 循环保护", () => {
  it("连续 3 次恢复无进展 → strike≥3 告警；此后仍继续重试不终止；步进复位", async () => {
    const h = makeHarness();
    const r = await boot(h);
    for (let i = 1; i <= 3; i++) {
      h.advance(61_000);
      await r.tick();
    }
    expect(r.state().strikes).toBe(3);
    const warns = ofType(h, "goal.warning").filter((e) => e.reason === "no-progress");
    expect(warns.length).toBe(1);
    // 第 4 次仍继续（告警不终止）
    h.advance(61_000);
    await r.tick();
    expect(r.state().strikes).toBe(4);
    expect(h.transport.injections.length).toBe(5); // 契约 + 4 次 nudge
    expect(r.state().phase).toBe("active");
    // 真实步进 → strikes 复位
    const ref = r.state().session!;
    h.transport.emit(ref, "output", "[GOAL-STEP 2/3] 实现");
    await r.tick();
    expect(r.state().strikes).toBe(0);
    expect(r.state().steps).toEqual([1]);
  });
});

/* ───── done 双过验收 ───── */

describe("done 双过验收", () => {
  it("done 标记 + verifyRun ok → complete + goal.complete 审计", async () => {
    const h = makeHarness({ verify: ["bun test"] });
    const r = await boot(h);
    const ref = r.state().session!;
    h.advance(4_000); // 过守卫窗
    h.transport.emit(ref, "output", "全部完成\n[GOAL-DONE]");
    await r.tick();
    expect(h.verifyCalls).toEqual([["bun", "test"]]); // argv 切分
    expect(r.state().phase).toBe("complete");
    expect(ofType(h, "goal.complete").length).toBe(1);
    // 终态后再 tick 无动作
    h.advance(61_000);
    await r.tick();
    expect(h.transport.injections.length).toBe(1);
  });

  it("verify fail → 注入失败原因继续（首败即停，后续命令不执行），保持 active", async () => {
    const h = makeHarness({ verify: ["bun test", "bun run typecheck"], failAt: 0, failOut: "3 fail" });
    const r = await boot(h);
    const ref = r.state().session!;
    h.advance(4_000);
    h.transport.emit(ref, "output", "[GOAL-DONE]");
    await r.tick();
    expect(h.verifyCalls.length).toBe(1); // 首败即停
    expect(h.transport.injections.length).toBe(2);
    const refeed = h.transport.injections[1]!.text;
    expect(refeed).toContain("验收未通过：3 fail");
    expect(refeed).toContain("完成后再次输出 [GOAL-DONE]");
    expect(r.state().phase).toBe("active");
  });

  it("verify 空清单：done 自报即 complete（与契约省略验收块对称）", async () => {
    const h = makeHarness();
    const r = await boot(h);
    const ref = r.state().session!;
    h.advance(4_000);
    h.transport.emit(ref, "output", "[GOAL-DONE]");
    await r.tick();
    expect(r.state().phase).toBe("complete");
  });
});

/* ───── 回显守卫与 feed 顺序契约（protocol.ts 头注） ───── */

describe("回显守卫与 feed 顺序", () => {
  it("守卫窗口内（echoGuardMs=3s）[GOAL-DONE] 回显作废；窗口外生效", async () => {
    const h = makeHarness({ verify: ["bun test"] });
    const r = await boot(h);
    const ref = r.state().session!;
    h.transport.emit(ref, "output", "已完成\n[GOAL-DONE]");
    await r.tick(); // 注入后 3s 内
    expect(h.verifyCalls.length).toBe(0); // 守卫作废
    expect(r.state().phase).toBe("active");
    h.advance(3_100); // 过守卫窗
    h.transport.emit(ref, "output", "已完成\n[GOAL-DONE]");
    await r.tick();
    expect(h.verifyCalls.length).toBe(1); // 真实申报生效
    expect(r.state().phase).toBe("complete");
  });

  it("注入文本整段回显（过守卫）被 stripInjectionEcho 剔除 → 不触发 verify、不误注入", async () => {
    const h = makeHarness({ verify: ["bun test"] });
    const r = await boot(h);
    const ref = r.state().session!;
    const contract = h.transport.injections[0]!.text; // 含 [GOAL-DONE] 协议说明
    h.advance(4_000); // 过守卫窗——此用例专验剥离层
    h.transport.emit(ref, "output", contract);
    await r.tick();
    expect(h.verifyCalls.length).toBe(0);
    expect(h.transport.injections.length).toBe(1);
  });
});

/* ───── 进程死重建（断点续跑） ───── */

describe("进程死重建", () => {
  it("alive=false → goal.restart 审计 + buildResumeContract 断点续跑 + 重建后信号泵存活", async () => {
    const h = makeHarness();
    const r = await boot(h);
    const ref = r.state().session!;
    // 制造进度（step 2 出现 → step 1 完成）
    h.transport.emit(ref, "output", "[GOAL-STEP 1/3] 调研\n[GOAL-STEP 2/3] 实现 | 推荐方案: x");
    await r.tick();
    expect(r.state().steps).toEqual([1]);
    // 外部杀会话（模拟进程死）
    await h.transport.stop(ref);
    h.advance(1_000);
    await r.tick();
    expect(ofType(h, "goal.restart").length).toBe(1);
    expect(h.transport.injections.length).toBe(2);
    expect(h.transport.injections[1]!.text).toBe(
      buildResumeContract({ objective: "实现登录页", doneSteps: [1] }),
    );
    expect(h.transport.injections[1]!.text).toContain("已完成 1/1 步");
    expect(await h.transport.alive(r.state().session!)).toBe(true);
    expect(r.state().strikes).toBe(1); // 重启计入循环保护
    // 重建后信号泵存活：新 step 可消费
    h.transport.emit(r.state().session!, "output", "[GOAL-STEP 3/3] 收尾");
    await r.tick();
    expect(r.state().steps).toEqual([1, 2]);
    expect(r.state().strikes).toBe(0);
  });

  it("无进度时进程死 → 重发全文契约（C++ forceRestart 同判据）", async () => {
    const h = makeHarness();
    const r = await boot(h);
    const ref = r.state().session!;
    await h.transport.stop(ref);
    h.advance(1_000);
    await r.tick();
    expect(h.transport.injections.length).toBe(2);
    expect(h.transport.injections[1]!.text).toBe(buildContract("实现登录页", []));
  });
});

/* ───── pause/resume/stop 与并发串行化（R-rn2） ───── */

describe("pause/resume/stop 与并发", () => {
  it("Review-Focus-5: pause 与 tick 并发 → pause 后并发 tick 不产生注入（串行化断言）", async () => {
    const h = makeHarness();
    const r = await boot(h);
    h.advance(61_000); // 停滞已到期——若不串行化，此 tick 必然注入
    const p = r.tick();
    r.pause(); // 同步翻转，先于 tick 决策
    const st = await p;
    expect(h.transport.injections.length).toBe(1); // 无注入
    expect(st.phase).toBe("paused");
  });

  it("paused：tick 不注入；resume 注入 CONTINUE_PROMPT 转 active", async () => {
    const h = makeHarness();
    const r = await boot(h);
    r.pause();
    h.advance(61_000);
    await r.tick();
    expect(h.transport.injections.length).toBe(1); // paused 不 tick 注入
    await r.resume();
    expect(h.transport.injections.length).toBe(2);
    expect(h.transport.injections[1]!.text).toContain(CONTINUE_PROMPT);
    expect(r.state().phase).toBe("active");
  });

  it("stop：终态 + transport 停 + 幂等；终态后 tick 无注入；终态后 pause/resume 显式报错", async () => {
    const h = makeHarness();
    const r = await boot(h);
    const ref = r.state().session!;
    await r.stop();
    expect(r.state().phase).toBe("stopped");
    expect(await h.transport.alive(ref)).toBe(false);
    expect(ofType(h, "goal.stop").length).toBe(1);
    await r.stop(); // 幂等
    expect(ofType(h, "goal.stop").length).toBe(1);
    h.advance(61_000);
    await r.tick();
    expect(h.transport.injections.length).toBe(1);
    expect(() => r.pause()).toThrow(BridgeError);
    await expect(r.resume()).rejects.toThrow(BridgeError);
  });
});

/* ───── classifyModelError / normalizeReceived 移植（R-rn5） ───── */

describe("classifyModelError（源：GoalProtocol::classifyModelError 逐条搬运）", () => {
  it("六类模式表（首匹配优先，大小写不敏感）", () => {
    // timeout
    expect(classifyModelError("Request timed out")).toBe("timeout");
    expect(classifyModelError("info timeout")).toBe("timeout");
    expect(classifyModelError("ETIMEDOUT")).toBe("timeout");
    expect(classifyModelError("请求已超时")).toBe("timeout");
    expect(classifyModelError("超时")).toBe("timeout");
    // rate_limit
    expect(classifyModelError("429")).toBe("rate_limit");
    expect(classifyModelError("Rate Limit exceeded")).toBe("rate_limit");
    expect(classifyModelError("too many requests")).toBe("rate_limit");
    expect(classifyModelError("限流")).toBe("rate_limit");
    // server
    expect(classifyModelError("500")).toBe("server");
    expect(classifyModelError("internal server error")).toBe("server");
    expect(classifyModelError("服务端错误")).toBe("server");
    // network（ECONNREFUSED 命中 network，先于 refusal——C++ 表序）
    expect(classifyModelError("ECONNRESET")).toBe("network");
    expect(classifyModelError("ECONNREFUSED")).toBe("network");
    expect(classifyModelError("fetch failed")).toBe("network");
    expect(classifyModelError("网络错误")).toBe("network");
    // empty
    expect(classifyModelError("no response")).toBe("empty");
    expect(classifyModelError("无返回")).toBe("empty");
    // refusal
    expect(classifyModelError("content policy")).toBe("refusal");
    expect(classifyModelError("被拒绝")).toBe("refusal");
  });

  it("ANSI 转义落在错误词中间/包裹时仍命中（对齐 C++ goalprotocol.cpp:118-120 内部 stripAnsi）", () => {
    // 包裹形式：转义序列在错误词前后（裁定示例原样）
    expect(classifyModelError("\x1b[?25l请求已超时\x1b[0m")).toBe("timeout");
    // 交错形式：转义序列把"超时"劈开——裸文本匹配漏检，stripAnsi 后命中
    expect(classifyModelError("请求已超\x1b[0m时\x1b[0m")).toBe("timeout");
  });

  it("\\b 词边界与负例（C++ `\\\\b` 即 TS 正则 \\b；timeout= 配置文本不算错误）", () => {
    expect(classifyModelError("timeout: 30s")).toBeNull(); // (?!\s*[=:]) 负向前瞻
    expect(classifyModelError("timeouted")).toBeNull(); // \\btimeout\\b 边界
    expect(classifyModelError("xtimeout")).toBeNull();
    expect(classifyModelError("hello world")).toBeNull();
    expect(classifyModelError("")).toBeNull();
  });

  it("normalizeReceived（TS 适配：清理未配对代理；合法文本原样）", () => {
    expect(normalizeReceived("中文 ok")).toBe("中文 ok");
    expect(normalizeReceived("a\uD800b")).toBe("a\uFFFDb"); // 未配对代理 → U+FFFD
    expect(normalizeReceived("𠀀")).toBe("𠀀"); // 合法代理对原样
    expect(normalizeReceived("")).toBe("");
  });
});

/* ───── 注入留痕与轮次 ───── */

describe("注入留痕", () => {
  it("rounds 随每次注入递增；injected 保留最近 6 条（C++ noteInjection 上限）", async () => {
    const h = makeHarness();
    const r = await boot(h);
    expect(r.state().rounds).toBe(1);
    for (let i = 0; i < 7; i++) {
      h.advance(61_000);
      await r.tick();
    }
    expect(r.state().rounds).toBe(8); // 契约 + 7 nudge
    expect(r.state().injected.length).toBe(6);
    // 最旧的是第 3 次注入（第 1、2 条被挤出）
    expect(r.state().injected[0]).toBe(h.transport.injections[2]!.text);
  });
});

/* ───── quiesce 排空窗口（T3-05 守护集成实证缺陷回归） ───── */

describe("quiesce 同块连推多信号（T3-05 集成发现回归）", () => {
  it("同一同步块内连推步进+完成信号：一次 tick 全部消费（决策前消费契约）", async () => {
    // 缺陷史：quiesce 单轮采样在 async generator 唤醒管线（恢复→yield→泵续，
    // 2~3 个微任务轮）未走完时误判排空——同块连推的第 2+ 个信号迟到决策后，
    // done 被推迟到下一次 tick 才核验。修复后：连续 4 轮稳定窗口覆盖管线深度。
    const h = makeHarness();
    const r = await boot(h);
    const ref = r.state().session!;
    h.advance(4000); // 越过回显守卫窗口
    h.transport.emit(ref, "output", "[GOAL-STEP 1/1] 完成 | 推荐方案: x");
    h.transport.emit(ref, "output", "全部完成\n[GOAL-DONE]");
    await r.tick(); // 同一 tick：步进标记落地 + done 申报 + 双过核验
    expect(r.state().phase).toBe("complete");
    // 1/1 标记 = 当前步语义（C++ steps[i].done：n 号标记把 1..n-1 记完成）→ 无完成步
    expect(r.state().steps).toEqual([]);
  });

  it("同块连推 5 个信号（压力形态）：一次 tick 全部消费、无遗漏", async () => {
    const h = makeHarness();
    const r = await boot(h);
    const ref = r.state().session!;
    h.advance(4000);
    for (let i = 1; i <= 5; i++) {
      h.transport.emit(ref, "output", `chunk-${i} 文本${i}`);
    }
    h.transport.emit(ref, "output", "done\n[GOAL-DONE]");
    await r.tick();
    expect(r.state().phase).toBe("complete"); // done 未迟到（6 信号全消费）
  });
});

/* ───── 修复环第 1 轮（真机 T4-02 五缺陷：③⑤②） ───── */

// script 传输台架（真实 createScriptTransport + 受控 fake child）：重建语义在
// 真实传输层验证（FakeTransport 的复活语义天然满足裁定，测不出风暴回归）。
// wrapper fixture 落插件 test/.tmp/（用后即删由 rm -rf .tmp 纪律覆盖）。

const T4_TMP = path.join(import.meta.dir, ".tmp", "runner-t4");
const T4_INSTALL = path.join(T4_TMP, "install");
mkdirSync(T4_INSTALL, { recursive: true });
writeFileSync(path.join(T4_INSTALL, "codearts"), "#!/bin/sh\nexit 0\n", "utf8");
chmodSync(path.join(T4_INSTALL, "codearts"), 0o755);
const SCRIPT_CFG: BridgeConfig = loadConfig(
  { stateDir: "/nonexistent/runner-t4", installDir: T4_INSTALL },
  {},
);

interface T4Child extends PtyChild {
  writes: string[];
  isAlive: boolean;
  die(): void;
}

function makeT4Child(pid: number): T4Child {
  let cb: ((chunk: string) => void) | null = null;
  const c: T4Child = {
    pid,
    writes: [],
    isAlive: true,
    onData(fn) {
      cb = fn;
    },
    write(d) {
      c.writes.push(d);
    },
    kill() {
      c.isAlive = false;
    },
    alive() {
      return c.isAlive;
    },
    die() {
      c.isAlive = false;
    },
  };
  return c;
}

interface ScriptHarness {
  transport: CodeartsTransport;
  audits: AuditEvent[];
  deps: RunnerDeps;
  state: GoalState;
  children: T4Child[];
  advance(ms: number): void;
}

function makeScriptHarness(): ScriptHarness {
  const children: T4Child[] = [];
  const transport = createScriptTransport({
    spawnPty(): PtyChild {
      const c = makeT4Child(600000 + children.length);
      children.push(c);
      return c;
    },
  });
  const audits: AuditEvent[] = [];
  let t = 1_000_000;
  const state: GoalState = {
    goalId: "g-script",
    objective: "实现登录页",
    verify: [],
    phase: "active",
    rounds: 0,
    steps: [],
    strikes: 0,
    injected: [],
    lastProgressAt: t,
  };
  const deps: RunnerDeps = {
    clock: { now: () => t },
    transport,
    audit: (e) => audits.push(e as AuditEvent),
    log: () => undefined,
    thresholds: { stallSeconds: 60, retryCapSeconds: 60, strikes: 3, echoGuardMs: 3000 },
    cfg: SCRIPT_CFG,
  };
  return {
    transport,
    audits,
    deps,
    state,
    children,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

/** 注入可拒绝的传输替身（② 状态失真回归用）：failNext 置位后下一次 inject 显式抛错。 */
class RejectingInjectTransport extends FakeTransport {
  failNext = false;
  override async inject(ref: SessionRef, text: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new BridgeError("INJECT_REJECTED", "模拟传输拒绝注入（真机 INJECT_TEXT 场景同型）");
    }
    return super.inject(ref, text);
  }
}

describe("修复环第 1 轮（真机 T4-02 五缺陷）", () => {
  it("③ 一次 restart 后不再连续 restart（时钟推进两 tick 断言）：死会话 → 重建活会话 + 契约重发", async () => {
    const h = makeScriptHarness();
    const r = new GoalRunner(h.state, h.deps);
    await r.tick(); // 引导：child0 + 契约注入
    expect(h.children.length).toBe(1);
    h.children[0]!.die(); // 进程死（模拟外部 kill -9）
    h.advance(1_000);
    await r.tick(); // restart：销毁残留 → 重建 child1 + 重发契约
    expect(h.audits.filter((e) => e.type === "goal.restart").length).toBe(1);
    expect(h.children.length).toBe(2);
    expect(await h.transport.alive(r.state().session!)).toBe(true);
    // 时钟推进两 tick：不再连续 restart（风暴期症状 = 每 tick 一次 restart/tick-failed）
    h.advance(5_000);
    await r.tick();
    h.advance(5_000);
    await r.tick();
    expect(h.audits.filter((e) => e.type === "goal.restart").length).toBe(1);
    expect(h.children.length).toBe(2); // 无新 spawn
  });

  it("⑤ 死会话 resume：先按重建路径复活会话 → 注入续跑契约 → phase=active（不再永久失败）", async () => {
    const h = makeHarness();
    const r = await boot(h);
    const ref = r.state().session!;
    r.pause();
    await h.transport.stop(ref); // 暂停期间会话死亡
    await r.resume();
    expect(r.state().phase).toBe("active");
    expect(await h.transport.alive(r.state().session!)).toBe(true);
    expect(h.transport.injections.length).toBe(2); // 契约 + 重建后契约/续跑注入
    expect(ofType(h, "goal.restart").length).toBe(1); // 死会话走重建路径（审计可溯）
  });

  it("② 注入被传输拒绝 → 状态零失真：injected 指纹回滚、rounds 不变、无 goal.inject 审计", async () => {
    const h = makeHarness();
    const rt = new RejectingInjectTransport();
    h.deps.transport = rt;
    h.transport = rt;
    const r = await boot(h); // bootstrap 注入成功
    expect(rt.injections.length).toBe(1);
    rt.failNext = true;
    h.advance(61_000);
    await expect(r.tick()).rejects.toBeInstanceOf(BridgeError); // nudge 注入被拒 → 显式上抛
    expect(r.state().rounds).toBe(1); // 回滚：rounds 不变（真机缺陷②"注入被拒仍 rounds+1"回归断言）
    expect(rt.injections.length).toBe(1); // 无注入留痕
    expect(h.audits.filter((e) => e.type === "goal.inject").length).toBe(1); // 仅 bootstrap 一条
  });
});
