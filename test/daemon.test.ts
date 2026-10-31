/**
 * T3-01 守护进程骨架与 API 测试（bun:test）。
 *
 * 纪律：
 * - 绝不触碰真实 HOME：stateDir/daemonUrl 一律经 loadConfig overrides 注入到
 *   <插件根>/.tmp/daemon-test/ 下的临时目录；env 参数显式传 {} 与真实 process.env 隔离。
 * - 端口一律 0（内核随机分配）或显式探测的空闲端口（freeTcpPort），绝不与真实 4577 抢占；
 *   fetch 直打 127.0.0.1 临时端口（任务书 Step 1 口径）。
 * - R-d3 裁定：GET /health 免鉴权（探活零依赖防 watchdog 死锁，裁定依据见 src/daemon.ts
 *   头注）。任务书 Step1 早稿"无 token→401"已被主控裁定取代，本文件按裁定钉死新契约：
 *   /health 无 token/错误 token 均 200；鉴权语义经"未知路由 401/404"验证。
 * - CLI daemon 前台命令以真进程（bun src/cli.ts daemon）+ SIGINT 驱动（R-d5 全链路）。
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { readFile, rm, mkdir, stat } from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { loadConfig } from "../src/core/config";
import type { BridgeConfig } from "../src/core/config";
import { createDaemon, daemonPortOf } from "../src/daemon";
import { daemonCommand, statusCommand } from "../src/cli";

/** 插件根目录（test/ 的上一级）。 */
const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
/** 本套件专属临时目录（.tmp/ 已 gitignore）。 */
const TEST_ROOT = path.join(PLUGIN_ROOT, ".tmp", "daemon-test");

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  // 只删本套件专属目录，不动 .tmp/ 根（可能被其他套件并行使用）
  await rm(TEST_ROOT, { recursive: true, force: true });
});

/** 构造注入型配置：stateDir 落临时目录；daemonUrl 缺省端口 0（随机端口）。 */
function cfgFor(name: string, daemonUrl = "http://127.0.0.1:0"): BridgeConfig {
  return loadConfig({ stateDir: path.join(TEST_ROOT, name), daemonUrl }, {});
}

/** 探测一个空闲 TCP 端口（监听 :0 → 取端口 → 立即关闭；仅测试定位用）。 */
async function freeTcpPort(): Promise<number> {
  const srv = http.createServer();
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const addr = srv.address();
  if (addr === null || typeof addr === "string") throw new Error(`非预期地址形态：${String(addr)}`);
  const port = addr.port;
  await new Promise<void>((resolve) => srv.close(() => resolve()));
  return port;
}

/** fetch JSON 响应的归一结果。 */
interface FetchResult {
  status: number;
  body: unknown;
  contentType: string;
}

/** GET 请求并把响应体按 JSON 解析（解析失败保留原文，交由断言暴露）。 */
async function get(url: string, token?: string): Promise<FetchResult> {
  const res = await fetch(url, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = text;
  }
  return { status: res.status, body, contentType: res.headers.get("content-type") ?? "" };
}

/** 捕获 console 输出执行 fn（finally 必然还原，防污染其他用例输出）。 */
async function captureConsole<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; logs: string[]; errors: string[] }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args.map((a) => String(a)).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const result = await fn();
    return { result, logs, errors };
  } finally {
    console.log = origLog;
    console.error = origError;
  }
}

describe("daemonPortOf（R-d1 端口口径）", () => {
  it("daemonUrl 无端口段 → 默认 4577；0 保留（随机端口）；显式端口原样解析", () => {
    expect(daemonPortOf("http://127.0.0.1")).toBe(4577);
    expect(daemonPortOf("http://127.0.0.1:0")).toBe(0);
    expect(daemonPortOf("http://127.0.0.1:4577")).toBe(4577);
    expect(daemonPortOf("http://127.0.0.1:65535")).toBe(65535);
  });
});

describe("GET /health（R-d3 免鉴权）", () => {
  it("无 token → 200 {ok:true, version, uptime}，Content-Type 为 JSON", async () => {
    const cfg = cfgFor("health-no-token");
    const daemon = createDaemon(cfg);
    const { port } = await daemon.start();
    try {
      const r = await get(`http://127.0.0.1:${port}/health`);
      expect(r.status).toBe(200);
      expect(r.contentType).toContain("application/json");
      const body = r.body as Record<string, unknown>;
      expect(body["ok"]).toBe(true);
      expect(body["version"]).toBe("dev");
      expect(typeof body["uptime"]).toBe("number");
      expect(body["uptime"] as number).toBeGreaterThanOrEqual(0);
    } finally {
      await daemon.stop();
    }
  });

  it("带错误 token 仍 200（免鉴权语义钉死，防回归为 401）", async () => {
    const cfg = cfgFor("health-wrong-token");
    const daemon = createDaemon(cfg);
    const { port } = await daemon.start();
    try {
      const r = await get(`http://127.0.0.1:${port}/health`, "deadbeef");
      expect(r.status).toBe(200);
      expect((r.body as Record<string, unknown>)["ok"]).toBe(true);
    } finally {
      await daemon.stop();
    }
  });
});

describe("token 生命周期（R-d2）", () => {
  it("首启自动生成 64 位 hex 令牌文件且 mode 0600", async () => {
    const cfg = cfgFor("token-gen");
    const tokenPath = path.join(cfg.stateDir, "daemon-token");
    // 前置：首启前文件不存在
    expect(await Bun.file(tokenPath).exists()).toBe(false);
    const daemon = createDaemon(cfg);
    await daemon.start();
    try {
      const content = await readFile(tokenPath, "utf8");
      expect(content).toMatch(/^[0-9a-f]{64}$/);
      const st = await stat(tokenPath);
      expect(st.mode & 0o777).toBe(0o600);
    } finally {
      await daemon.stop();
    }
  });

  it("重启复用同一 token（内容不变，旧 token 鉴权通过）", async () => {
    const cfg = cfgFor("token-reuse");
    const tokenPath = path.join(cfg.stateDir, "daemon-token");
    const first = createDaemon(cfg);
    await first.start();
    const token1 = await readFile(tokenPath, "utf8");
    await first.stop();

    const second = createDaemon(cfg);
    const { port } = await second.start();
    try {
      const token2 = await readFile(tokenPath, "utf8");
      expect(token2).toBe(token1);
      // 旧 token 鉴权通过：未知路由返回 404（鉴权通过后的路由未命中），而非 401
      const r = await get(`http://127.0.0.1:${port}/nope`, token2);
      expect(r.status).toBe(404);
      expect((r.body as Record<string, unknown>)["error"]).toBeDefined();
    } finally {
      await second.stop();
    }
  });
});

describe("路由与鉴权（R-d2/R-d3）", () => {
  it("未知路由无 token → 401 {error:{code:UNAUTHORIZED}} 结构化 JSON", async () => {
    const cfg = cfgFor("auth-missing");
    const daemon = createDaemon(cfg);
    const { port } = await daemon.start();
    try {
      const r = await get(`http://127.0.0.1:${port}/goals`);
      expect(r.status).toBe(401);
      expect(r.contentType).toContain("application/json");
      const err = (r.body as Record<string, { code?: string }>)["error"];
      expect(err?.code).toBe("UNAUTHORIZED");
    } finally {
      await daemon.stop();
    }
  });

  it("未知路由错误 token → 401", async () => {
    const cfg = cfgFor("auth-wrong");
    const daemon = createDaemon(cfg);
    const { port } = await daemon.start();
    try {
      const r = await get(`http://127.0.0.1:${port}/goals`, "not-the-token");
      expect(r.status).toBe(401);
    } finally {
      await daemon.stop();
    }
  });

  it("非 Bearer 方案（Basic）→ 401", async () => {
    const cfg = cfgFor("auth-scheme");
    const daemon = createDaemon(cfg);
    const { port } = await daemon.start();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/goals`, {
        headers: { authorization: "Basic dXNlcjpwYXNz" },
      });
      expect(res.status).toBe(401);
    } finally {
      await daemon.stop();
    }
  });

  it("未知路由正确 token → 404 {error:{code:NOT_FOUND}}（结构化 JSON）", async () => {
    const cfg = cfgFor("route-404");
    const daemon = createDaemon(cfg);
    const { port } = await daemon.start();
    try {
      const token = await readFile(path.join(cfg.stateDir, "daemon-token"), "utf8");
      const r = await get(`http://127.0.0.1:${port}/does-not-exist`, token);
      expect(r.status).toBe(404);
      expect(r.contentType).toContain("application/json");
      const err = (r.body as Record<string, { code?: string }>)["error"];
      expect(err?.code).toBe("NOT_FOUND");
    } finally {
      await daemon.stop();
    }
  });

  it("POST /health 过鉴权（R-d3：非 GET /health 先鉴权）：无 token→401；带正确 token→404", async () => {
    const cfg = cfgFor("post-health");
    const daemon = createDaemon(cfg);
    const { port } = await daemon.start();
    try {
      const noToken = await fetch(`http://127.0.0.1:${port}/health`, { method: "POST" });
      expect(noToken.status).toBe(401);
      const token = await readFile(path.join(cfg.stateDir, "daemon-token"), "utf8");
      const withToken = await fetch(`http://127.0.0.1:${port}/health`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(withToken.status).toBe(404);
      const err = (await withToken.json() as Record<string, { code?: string }>)["error"];
      expect(err?.code).toBe("NOT_FOUND");
    } finally {
      await daemon.stop();
    }
  });
});

describe("生命周期（R-d4）", () => {
  it("start 幂等复用：二次 start 返回同一端口（不重复 listen）", async () => {
    const cfg = cfgFor("start-idempotent");
    const daemon = createDaemon(cfg);
    const a = await daemon.start();
    try {
      const b = await daemon.start();
      expect(b.port).toBe(a.port);
      expect(b.port).toBeGreaterThan(0);
    } finally {
      await daemon.stop();
    }
  });

  it("daemonUrl 显式端口被采用：start 返回该端口且可用", async () => {
    const port = await freeTcpPort();
    const cfg = cfgFor("explicit-port", `http://127.0.0.1:${port}`);
    const daemon = createDaemon(cfg);
    const started = await daemon.start();
    try {
      expect(started.port).toBe(port);
      const r = await get(`http://127.0.0.1:${port}/health`);
      expect(r.status).toBe(200);
    } finally {
      await daemon.stop();
    }
  });

  it("stop 幂等：未 start 直接 stop 不抛；stop 后可再次 start 并响应", async () => {
    const cfg = cfgFor("stop-idempotent");
    const daemon = createDaemon(cfg);
    await daemon.stop(); // 未启动：幂等空操作
    const { port } = await daemon.start();
    try {
      const r = await get(`http://127.0.0.1:${port}/health`);
      expect(r.status).toBe(200);
    } finally {
      await daemon.stop();
      await daemon.stop(); // 二次 stop：幂等
    }
  });
});

describe("CLI status（R-d5）", () => {
  it("守护在场 → 退出码 0，stdout 输出 ok:true 的 JSON", async () => {
    const cfg = cfgFor("cli-status-ok");
    const daemon = createDaemon(cfg);
    const { port } = await daemon.start();
    try {
      const statusCfg = loadConfig(
        { stateDir: cfg.stateDir, daemonUrl: `http://127.0.0.1:${port}` },
        {},
      );
      const cap = await captureConsole(() => statusCommand(statusCfg));
      expect(cap.result).toBe(0);
      expect(cap.logs.join("\n")).toContain('"ok": true');
    } finally {
      await daemon.stop();
    }
  });

  it("守护不可达 → 非零退出，stderr 结构化摘要（DAEMON_UNAVAILABLE）", async () => {
    const port = await freeTcpPort(); // 已关闭的空闲端口 → 连接拒绝
    const cfg = cfgFor("cli-status-down", `http://127.0.0.1:${port}`);
    const cap = await captureConsole(() => statusCommand(cfg));
    expect(cap.result).not.toBe(0);
    expect(cap.errors.join("\n")).toContain("DAEMON_UNAVAILABLE");
  });
});

describe("CLI daemon 前台命令（R-d5，真进程 SIGINT）", () => {
  it(
    // 真进程全链路：spawn → 监听行 → SIGINT → 优雅 stop → exit 0 → 端口释放。
    // （曾出现的偶发 143 根因是 cli.ts 旧实现"打印就绪行→注册信号处理器"的窗口期
    // 竞态：管道写同步返回后父进程可先于子进程完成注册而 kill——已改为先注册
    // 处理器再启动监听（见 daemonCommand 头注），本用例因此确定性通过。）
    "bun src/cli.ts daemon 前台运行，SIGINT 优雅停止：退出码 0 且端口释放",
    async () => {
      const port = await freeTcpPort();
      const stateDir = path.join(TEST_ROOT, "cli-daemon");
      const env = {
        ...process.env,
        CODEARTS_BRIDGE_STATE_DIR: stateDir,
        CODEARTS_BRIDGE_DAEMON_URL: `http://127.0.0.1:${port}`,
      };
      const proc = Bun.spawn({
        cmd: [process.execPath, "src/cli.ts", "daemon"],
        cwd: PLUGIN_ROOT,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        // 等 stdout 出现监听行（5s 上限防悬挂）
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let seen = "";
        const deadline = Date.now() + 5000;
        for (;;) {
          if (Date.now() > deadline) throw new Error("daemon 前台启动超时（未见到监听行）");
          const { done, value } = await reader.read();
          if (done) break;
          seen += decoder.decode(value, { stream: true });
          if (seen.includes("监听")) break;
        }
        expect(seen).toContain("127.0.0.1");
        proc.kill("SIGINT");
        const code = await proc.exited;
        expect(code).toBe(0);
        // 优雅停止证据：同端口可立即再次监听（server 已 close）
        const cfg = loadConfig({ stateDir, daemonUrl: `http://127.0.0.1:${port}` }, {});
        const again = createDaemon(cfg);
        const restarted = await again.start();
        expect(restarted.port).toBe(port);
        await again.stop();
      } finally {
        try {
          proc.kill(9);
        } catch {
          // 进程已退出：清理为无操作
        }
      }
    },
    20000,
  );
});
