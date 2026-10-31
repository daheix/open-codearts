/**
 * fake-run.ts — `codearts run` 测试替身（T2-04）。
 *
 * 经生产 seam（nodeRunSpawnProc）真实 spawn（离线本地；绝不跑真实 codearts）。
 * 由测试装配的 `<installDir>/bin/codearts` wrapper 调用，形态：
 *   wrapper: #!/bin/sh
 *            exec '<bun>' '<本文件>' --scenario <s> "$@"
 *   传输层拼装的回合 argv（不含 bin 本体）经 "$@" 透传：
 *            run <prompt> [--session <id>] --format json --print-logs
 *
 * 场景（--scenario）：
 *   normal（缺省）: 首回合输出 session.id + 两条 message.part；带 --session 则
 *                   输出"续接:<id>"一条 message.part（证明参数经 wrapper 端到端
 *                   送达）；退出码 0。
 *   session-continuation: 显式续接场景——有 --session 输出"续接:<id>"；否则输出
 *                   新 session.id + "首回合:<prompt>"；退出码 0。
 *   echo:           输出自身回合 argv（JSON 行，type=argv）——供测试断言传输层
 *                   拼装的 argv 形态（含 --session、空格 prompt 不被拆词）；退出码 0。
 *   env:            输出 CODEARTS_CLI_AK/CODEARTS_CLI_SK 键存在性（"set"/"unset"，
 *                   **绝不输出值**——凭据不跨进程边界）；退出码 0。
 *   error:          输出 {"type":"error", message:"认证失败…"}（F2 实测文案）；
 *                   退出码 0（error 事件 ≠ 回合失败；回合失败由退出码表达）。
 *   crash:          向 stderr 输出非 JSON 行（宽容解析样本）后以退出码 7 终止
 *                   （回合失败路径：exit≠0 → error 信号、无 done）。
 *   stall:          输出 session.id 后常驻（永不退出的 interval），供 stop 进程组
 *                   终止测试经 /proc 扫描核对无残留。
 *
 * 退出方式：一律 process.exitCode 赋值 + 自然结束（避免 pipe 缓冲未刷即退）；
 * 仅 stall 例外（常驻，靠外部 kill）。
 */

const args = process.argv.slice(2);

let scenario = "normal";
if (args[0] === "--scenario") {
  scenario = args[1] ?? "normal";
}

/** 回合参数解析（传输层拼装形态：run <prompt> [--session <id>] --format json --print-logs） */
const runIdx = args.indexOf("run");
const roundPrompt = runIdx >= 0 ? (args[runIdx + 1] ?? "") : "";
const sessionIdx = args.indexOf("--session");
const sessionId = sessionIdx >= 0 ? (args[sessionIdx + 1] ?? null) : null;

/** 结构化事件输出：一行一个 JSON 对象（JSONL）。 */
const out = (obj: Record<string, unknown>): void => {
  console.log(JSON.stringify(obj));
};

switch (scenario) {
  case "stall": {
    out({ type: "session.id", sessionID: "ses-stall-1" });
    setInterval(() => {}, 1_000_000); // 常驻：直到被进程组 kill
    break;
  }
  case "error": {
    out({
      type: "error",
      message: "认证失败，没有设置环境变量CODEARTS_CLI_AK/CODEARTS_CLI_SK",
    });
    process.exitCode = 0;
    break;
  }
  case "crash": {
    console.error("kernel panic: fake 内部崩溃（非 JSON 行，宽容解析样本）");
    process.exitCode = 7;
    break;
  }
  case "echo": {
    out({ type: "argv", argv: args });
    process.exitCode = 0;
    break;
  }
  case "env": {
    out({
      type: "env",
      CODEARTS_CLI_AK: process.env.CODEARTS_CLI_AK !== undefined ? "set" : "unset",
      CODEARTS_CLI_SK: process.env.CODEARTS_CLI_SK !== undefined ? "set" : "unset",
    });
    process.exitCode = 0;
    break;
  }
  case "session-continuation": {
    if (sessionId !== null) {
      out({ type: "message.part", part: { type: "text", text: `续接:${sessionId}` } });
    } else {
      out({ type: "session.id", sessionID: "ses-cont-1" });
      out({ type: "message.part", part: { type: "text", text: `首回合:${roundPrompt}` } });
    }
    process.exitCode = 0;
    break;
  }
  default: {
    if (sessionId !== null) {
      out({ type: "message.part", part: { type: "text", text: `续接:${sessionId}` } });
    } else {
      out({ type: "session.id", sessionID: "ses-fake-001" });
      out({ type: "message.part", part: { type: "text", text: `回复:${roundPrompt}` } });
      out({ type: "message.part", part: { type: "text", text: "done-part" } });
    }
    process.exitCode = 0;
    break;
  }
}
