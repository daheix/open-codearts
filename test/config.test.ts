/**
 * T1-02 配置与状态根测试（bun:test）。
 *
 * 纪律（主控裁定 2026-10-31）：
 * - 测试绝不触碰真实 HOME（~/.codearts-bridge 与 ~/.codeartsdoer 是用户真实环境）：
 *   loadConfig 本身无 FS 副作用，可安全用默认值断言；所有 FS 落点（ensureStateDirs /
 *   readAksk）一律通过 overrides 注入到 <插件根>/.tmp/config-test/ 下。
 * - env 参数显式传 {} 或构造记录，与真实 process.env 隔离，保证可复现。
 * - afterAll 清理临时目录（用后即删）。
 */
import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import * as path from "node:path";
import { ensureStateDirs, loadConfig, readAksk } from "../src/core/config";

/** 插件根目录（test/ 的上一级）。 */
const PLUGIN_ROOT = path.resolve(import.meta.dir, "..");
/** 本套件专属临时目录（.tmp/ 已 gitignore）。 */
const TEST_ROOT = path.join(PLUGIN_ROOT, ".tmp", "config-test");

/** 状态根子目录契约（与 ensureStateDirs 实现逐一对应，测试侧钉死）。 */
const STATE_SUBDIRS = ["goals", "audit", "health", "logs", "tmp"] as const;

beforeEach(async () => {
  await rm(TEST_ROOT, { recursive: true, force: true });
  await mkdir(TEST_ROOT, { recursive: true });
});

afterAll(async () => {
  // 只删本套件专属目录，不动 .tmp/ 根（可能被其他套件并行使用）
  await rm(TEST_ROOT, { recursive: true, force: true });
});

describe("loadConfig 默认值", () => {
  it("defaults: installDir/stateDir/daemonUrl/thresholds/akskFile 默认值正确", () => {
    const cfg = loadConfig({}, {});
    expect(cfg.stateDir).toBe(path.join(homedir(), ".codearts-bridge"));
    expect(cfg.installDir).toBe(path.join(homedir(), ".codeartsdoer", "installers"));
    expect(cfg.daemonUrl).toBe("http://127.0.0.1:4577");
    expect(cfg.thresholds).toEqual({
      stallSeconds: 60,
      retryCapSeconds: 60,
      strikes: 3,
      echoGuardMs: 3000,
    });
    // akskFile 默认由解析后的 stateDir 派生：<stateDir>/config.env
    expect(cfg.akskFile).toBe(path.join(homedir(), ".codearts-bridge", "config.env"));
    // 枚举与布尔字段缺省（transport/ptyHost 默认 auto；autoNudge 默认 true——主控裁决 2026-10-31）
    expect(cfg.transport).toBe("auto");
    expect(cfg.ptyHost).toBe("auto");
    expect(cfg.autoNudge).toBe(true);
  });

  it("thresholds 默认值每次调用返回新对象（调用方改写不污染后续默认值）", () => {
    const a = loadConfig({}, {});
    a.thresholds.stallSeconds = 999;
    const b = loadConfig({}, {});
    expect(b.thresholds.stallSeconds).toBe(60);
  });
});

describe("loadConfig 优先级 overrides > env(CODEARTS_BRIDGE_*) > defaults", () => {
  it("env 覆盖默认值；akskFile 随解析后的 stateDir 派生", () => {
    const env = {
      CODEARTS_BRIDGE_STATE_DIR: path.join(TEST_ROOT, "env-state"),
      CODEARTS_BRIDGE_TRANSPORT: "structured",
      CODEARTS_BRIDGE_DAEMON_URL: "http://127.0.0.1:9999",
      CODEARTS_BRIDGE_AUTO_NUDGE: "false",
    };
    const cfg = loadConfig({}, env);
    expect(cfg.stateDir).toBe(path.join(TEST_ROOT, "env-state"));
    expect(cfg.transport).toBe("structured");
    expect(cfg.daemonUrl).toBe("http://127.0.0.1:9999");
    // env 显式 "false" 压过默认 true（显式退出高级选项，主控裁决 2026-10-31）
    expect(cfg.autoNudge).toBe(false);
    expect(cfg.akskFile).toBe(path.join(TEST_ROOT, "env-state", "config.env"));
  });

  it("overrides 压过 env；env 未覆盖字段保持 env 值", () => {
    const env = {
      CODEARTS_BRIDGE_STATE_DIR: path.join(TEST_ROOT, "env-state"),
      CODEARTS_BRIDGE_TRANSPORT: "structured",
      CODEARTS_BRIDGE_DAEMON_URL: "http://127.0.0.1:9999",
      CODEARTS_BRIDGE_AUTO_NUDGE: "true",
    };
    const cfg = loadConfig(
      { stateDir: path.join(TEST_ROOT, "ovr-state"), transport: "pty", autoNudge: false },
      env,
    );
    expect(cfg.stateDir).toBe(path.join(TEST_ROOT, "ovr-state"));
    expect(cfg.transport).toBe("pty");
    expect(cfg.daemonUrl).toBe("http://127.0.0.1:9999");
    // overrides 显式 false 压过 env "true"——显式退出覆盖仍生效（主控裁决 2026-10-31）
    expect(cfg.autoNudge).toBe(false);
  });

  it("akskFile 显式覆盖优先于 stateDir 派生", () => {
    const cfg = loadConfig(
      {
        stateDir: path.join(TEST_ROOT, "s"),
        akskFile: path.join(TEST_ROOT, "custom.env"),
      },
      {},
    );
    expect(cfg.akskFile).toBe(path.join(TEST_ROOT, "custom.env"));
  });

  it("installDir/ptyHost 经 env 覆盖", () => {
    const cfg = loadConfig(
      {},
      {
        CODEARTS_BRIDGE_INSTALL_DIR: path.join(TEST_ROOT, "env-installers"),
        CODEARTS_BRIDGE_PTY_HOST: "tmux",
        CODEARTS_BRIDGE_AKSK_FILE: path.join(TEST_ROOT, "env.env"),
      },
    );
    expect(cfg.installDir).toBe(path.join(TEST_ROOT, "env-installers"));
    expect(cfg.ptyHost).toBe("tmux");
    expect(cfg.akskFile).toBe(path.join(TEST_ROOT, "env.env"));
  });
});

describe("loadConfig 非法输入显式报错（禁静默兜底）", () => {
  it("transport 非法值（env 与 overrides 两个来源）都抛错", () => {
    expect(() => loadConfig({}, { CODEARTS_BRIDGE_TRANSPORT: "grpc" })).toThrow(/transport/);
    expect(() => loadConfig({ transport: "grpc" as unknown as "auto" }, {})).toThrow(/transport/);
  });

  it("ptyHost/autoNudge/thresholds/daemonUrl 非法值抛错", () => {
    expect(() => loadConfig({ ptyHost: "zsh" as unknown as "auto" }, {})).toThrow(/ptyHost/);
    expect(() => loadConfig({}, { CODEARTS_BRIDGE_AUTO_NUDGE: "yes" })).toThrow(/AUTO_NUDGE/);
    expect(() =>
      loadConfig(
        {
          thresholds: {
            stallSeconds: -1,
            retryCapSeconds: 60,
            strikes: 3,
            echoGuardMs: 3000,
          },
        },
        {},
      ),
    ).toThrow(/thresholds\.stallSeconds/);
    expect(() => loadConfig({ daemonUrl: "ftp://127.0.0.1:4577" }, {})).toThrow(/daemonUrl/);
    expect(() => loadConfig({ daemonUrl: "not-a-url" }, {})).toThrow(/daemonUrl/);
  });

  it("空环境变量与相对路径显式报错", () => {
    expect(() => loadConfig({}, { CODEARTS_BRIDGE_STATE_DIR: "" })).toThrow(/CODEARTS_BRIDGE_STATE_DIR/);
    expect(() => loadConfig({ stateDir: "relative/state" }, {})).toThrow(/绝对路径/);
  });
});

describe("ensureStateDirs", () => {
  it("创建 stateDir 及 5 个子目录，umask 0777 下 mode 仍为 0700（显式 chmod，umask 无关）", async () => {
    const stateDir = path.join(TEST_ROOT, "state-a");
    const cfg = loadConfig({ stateDir }, {});
    const prev = process.umask(0o777);
    try {
      await ensureStateDirs(cfg);
    } finally {
      process.umask(prev);
    }
    for (const dir of [stateDir, ...STATE_SUBDIRS.map((s) => path.join(stateDir, s))]) {
      const st = await stat(dir);
      expect(st.isDirectory()).toBe(true);
      expect(st.mode & 0o777).toBe(0o700);
    }
  });

  it("幂等：重复调用不抛；已存在目录（0755）不改属主但确保 mode 收紧为 0700", async () => {
    const stateDir = path.join(TEST_ROOT, "state-b");
    const logsDir = path.join(stateDir, "logs");
    await mkdir(logsDir, { recursive: true });
    await chmod(logsDir, 0o755);
    const before = await stat(logsDir);

    const cfg = loadConfig({ stateDir }, {});
    await ensureStateDirs(cfg);
    await ensureStateDirs(cfg); // 第二次调用不抛

    const after = await stat(logsDir);
    expect(after.mode & 0o777).toBe(0o700);
    expect(after.uid).toBe(before.uid); // chmod 不改属主
    expect(after.isDirectory()).toBe(true);
  });
});

describe("readAksk", () => {
  it("缺失文件返回 undefined（未配置是显式状态，绝不抛错）", async () => {
    expect(await readAksk(path.join(TEST_ROOT, "nope.env"))).toBeUndefined();
  });

  it("解析 KEY=VALUE env 文件（容忍注释/空行/CRLF/键值两侧空白）", async () => {
    const file = path.join(TEST_ROOT, "aksk.env");
    await writeFile(file, "# 注释行\r\n\r\nAK = ak-value-1\r\nSK=sk-value-2\n", "utf8");
    expect(await readAksk(file)).toEqual({ AK: "ak-value-1", SK: "sk-value-2" });
  });

  it("仅含单一键时返回单键对象；空文件/纯注释返回空对象", async () => {
    const onlyAk = path.join(TEST_ROOT, "only-ak.env");
    await writeFile(onlyAk, "AK=ak-only\n", "utf8");
    expect(await readAksk(onlyAk)).toEqual({ AK: "ak-only" });

    const empty = path.join(TEST_ROOT, "empty.env");
    await writeFile(empty, "# 只有注释\n\n", "utf8");
    expect(await readAksk(empty)).toEqual({});
  });

  it("其他读取错误显式抛出且消息含路径（以目录路径触发 EISDIR，非 ENOENT）", async () => {
    const dir = path.join(TEST_ROOT, "as-dir");
    await mkdir(dir);
    const err: unknown = await readAksk(dir).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(dir);
  });

  it("格式错误行显式抛出：消息含路径与行号，绝不回显行内疑似凭据", async () => {
    const file = path.join(TEST_ROOT, "bad.env");
    await writeFile(file, "AK=ok-1\nGARBAGE without equals secretvalue999\n", "utf8");
    const err: unknown = await readAksk(file).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain(file);
    expect(message).toContain("2"); // 行号
    expect(message).not.toContain("secretvalue999");
  });

  it("未知键显式抛出（防拼写错误静默丢凭据）：消息含键名、不含键值", async () => {
    const file = path.join(TEST_ROOT, "unknown-key.env");
    await writeFile(file, "AccessKey=keyvalue888\n", "utf8");
    const err: unknown = await readAksk(file).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("AccessKey");
    expect(message).not.toContain("keyvalue888");
  });

  it("键重复定义显式抛出", async () => {
    const file = path.join(TEST_ROOT, "dup.env");
    await writeFile(file, "AK=first\nAK=second\n", "utf8");
    await expect(readAksk(file)).rejects.toThrow(/重复/);
  });
});
