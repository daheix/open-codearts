#!/usr/bin/env bash
#
# codearts-bridge 安装引导脚本（T4-05）——开箱即用 + 幂等可重跑。
#
# 流程（任一步骤失败即显式报错、非 0 退出；无静默兜底）：
#   1. 前置探测：git / bun（PATH → ~/.bun/bin；bun 缺失走官方脚本装到 ~/.bun）；
#   2. 定位仓库根（本脚本所在目录）并 bun install；
#   3. opencode 接线（幂等）：写 ~/.config/opencode/plugins/codearts-bridge.ts
#      （一行 re-export 指向本仓库 index.ts 绝对路径）；已等价 → 跳过；
#      已存在但不等价 → 先备份 .bak-<时间戳> 再写；
#   4. systemd 守护（默认开；--no-daemon 跳过）：codearts-bridge service install
#      （生成 user 单元 + daemon-reload + enable --now）；无 systemctl → 跳过并提示；
#   5. 质量门：bun run typecheck && bun test；
#   6. doctor 体检 + 结尾摘要（各组件状态与后续指引）。
#
# 参数：
#   --no-daemon          跳过 systemd 守护安装（前台运行 codearts-bridge daemon 亦可）
#   --state-dir <路径>   状态根（绝对路径；缺省 ~/.codearts-bridge，经环境变量
#                        CODEARTS_BRIDGE_STATE_DIR 传递给 service install 与 doctor）
#   --skip-gate          跳过第 5 步质量门（仅供测试/CI：嵌套 bun test 会自递归；
#                        正常安装不要使用）
#   --help               打印本帮助
#
# 纪律：set -euo pipefail；只写 HOME 下的接线与 systemd 单元；绝不改动仓库内容。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WITH_DAEMON=1
STATE_DIR=""
SKIP_GATE=0

log()  { echo "[install] $*"; }
die()  { echo "[install] ✗ $*" >&2; exit 1; }

usage() {
  awk 'NR>1 && !/^#/ {exit} NR>1 {print substr($0, 3)}' "${BASH_SOURCE[0]}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --no-daemon) WITH_DAEMON=0; shift ;;
    --state-dir)
      [ $# -ge 2 ] || die "--state-dir 需要一个绝对路径参数"
      STATE_DIR="$2"; shift 2 ;;
    --skip-gate) SKIP_GATE=1; shift ;;
    --help) usage; exit 0 ;;
    *) die "未知参数：$1（--help 查看用法）" ;;
  esac
done

if [ -n "$STATE_DIR" ]; then
  case "$STATE_DIR" in
    /*) ;;
    *) die "--state-dir 必须为绝对路径：$STATE_DIR" ;;
  esac
  export CODEARTS_BRIDGE_STATE_DIR="$STATE_DIR"
fi

# ── 1. 前置探测 ──────────────────────────────────────────────
command -v git >/dev/null 2>&1 || die "git 未安装：请先安装 git（apt install git 等）后重试"

if command -v bun >/dev/null 2>&1; then
  BUN="$(command -v bun)"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
  export PATH="$HOME/.bun/bin:$PATH"
else
  log "未检出 bun → 官方脚本安装到 ~/.bun ..."
  command -v curl >/dev/null 2>&1 || die "curl 未安装：无法自动安装 bun，请手动安装 bun 后重试"
  curl -fsSL https://bun.sh/install | bash
  [ -x "$HOME/.bun/bin/bun" ] || die "bun 安装脚本执行完成但 $HOME/.bun/bin/bun 不在场（安装失败）"
  BUN="$HOME/.bun/bin/bun"
  export PATH="$HOME/.bun/bin:$PATH"
fi
log "✓ bun：$("$BUN" --version)（$BUN）"
log "✓ git：$(git --version)"

# ── 2. 依赖安装 ──────────────────────────────────────────────
cd "$REPO_ROOT"
log "bun install（repo=$REPO_ROOT）..."
"$BUN" install
log "✓ 依赖就绪"

# ── 3. opencode 接线（幂等，先备份后写） ─────────────────────
PLUGIN_DIR="$HOME/.config/opencode/plugins"
TARGET="$PLUGIN_DIR/codearts-bridge.ts"
EXPECTED="export { default } from \"${REPO_ROOT}/index.ts\";"
if [ -f "$TARGET" ] && [ "$(cat "$TARGET")" = "$EXPECTED" ]; then
  log "✓ opencode 接线已等价，跳过：$TARGET"
else
  mkdir -p "$PLUGIN_DIR"
  if [ -f "$TARGET" ]; then
    BACKUP="${TARGET}.bak-$(date +%Y%m%d%H%M%S)"
    cp "$TARGET" "$BACKUP"
    log "⚠ 既有接线不等价，已备份：$BACKUP"
  fi
  printf '%s\n' "$EXPECTED" > "$TARGET"
  log "✓ opencode 接线已写入：$TARGET → $REPO_ROOT/index.ts"
fi

# ── 4. systemd 守护（--no-daemon 跳过；无 systemctl 跳过并提示） ──
if [ "$WITH_DAEMON" = "1" ]; then
  if command -v systemctl >/dev/null 2>&1; then
    log "安装 systemd user 单元（守护 + watchdog，enable --now）..."
    "$BUN" "$REPO_ROOT/src/cli.ts" service install
    log "✓ systemd 守护已安装并启动（journalctl --user -t codearts-bridge 可查日志）"
  else
    log "⚠ 未检出 systemctl：跳过守护安装；前台运行：$BUN $REPO_ROOT/src/cli.ts daemon"
  fi
else
  log "--no-daemon：跳过 systemd 守护安装（前台运行：$BUN $REPO_ROOT/src/cli.ts daemon）"
fi

# ── 5. 质量门（--skip-gate 跳过；仅供测试/CI） ───────────────
if [ "$SKIP_GATE" = "1" ]; then
  log "--skip-gate：跳过质量门（typecheck/test）——仅供测试/CI 使用"
else
  log "质量门：bun run typecheck ..."
  "$BUN" run typecheck
  log "质量门：bun test ..."
  "$BUN" test
  log "✓ 质量门通过"
fi

# ── 6. doctor 体检 + 摘要 ────────────────────────────────────
log "doctor 环境体检 ..."
"$BUN" "$REPO_ROOT/src/cli.ts" doctor || die "doctor 体检存在失败项（✗），请按上方修复指引处理后重跑"

echo ""
log "✓ 安装完成。组件摘要："
log "  - bridge 仓库：$REPO_ROOT（codearts-bridge self-upgrade 可自升级）"
log "  - opencode 接线：$TARGET（重启 opencode 会话或等待热加载生效）"
if [ "$WITH_DAEMON" = "1" ] && command -v systemctl >/dev/null 2>&1; then
  log "  - 守护：systemd user 常驻（codearts-bridge service status 查看）"
else
  log "  - 守护：未安装（前台运行 $BUN $REPO_ROOT/src/cli.ts daemon）"
fi
log "  - codearts CLI：未装时执行 codearts-bridge upgrade-cli 安装；升级用 codearts-bridge upgrade-cli"
log "  - 卸载：bash $REPO_ROOT/uninstall.sh（--purge 连状态目录一并清除）"
