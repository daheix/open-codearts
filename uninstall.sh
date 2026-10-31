#!/usr/bin/env bash
#
# codearts-bridge 卸载引导脚本（T4-05）——转调 codearts-bridge uninstall 子命令。
#
# 默认保留 ~/.codearts-bridge 状态数据与 codearts CLI；--purge 才清状态目录。
# 非交互环境必须带 --yes（卸载子命令的确认门）。
#
# 用法：bash uninstall.sh [--yes] [--purge] [codearts-bridge uninstall 其余参数]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "[uninstall] ✗ $*" >&2; exit 1; }

if command -v bun >/dev/null 2>&1; then
  BUN="$(command -v bun)"
elif [ -x "$HOME/.bun/bin/bun" ]; then
  BUN="$HOME/.bun/bin/bun"
  export PATH="$HOME/.bun/bin:$PATH"
else
  die "bun 未检出（卸载命令需要运行 bun）：请安装 bun 或将其加入 PATH 后重试"
fi

exec "$BUN" "$REPO_ROOT/src/cli.ts" uninstall "$@"
