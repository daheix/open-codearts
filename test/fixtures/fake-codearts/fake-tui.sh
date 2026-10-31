#!/usr/bin/env bash
# fake-tui.sh — codearts TUI 测试替身（T2-02）。
#
# 经 script(1) PTY 宿主实跑（test/transport-script.test.ts），行为与真实 TUI
# 的可观测面一致：文本字符累积缓冲；提交回车触发回显与提交标记。
#
# 用法: fake-tui.sh [--scenario stall|error|exit|utf8|family]
#   默认:   逐字符读 stdin（-icanon，绕过 canonical 行缓冲——行模式无法把
#           "提交用 \r"与文本行终结区分开）；\r/\n 提交时：缓冲非空 →
#           打印 "[RX:<buf>]" + "[ENTER]"（两段式提交的两个可观测事件），
#           缓冲为空（单独 \r）→ 仅 "[ENTER]"；EOF 退出 0。
#   stall:  静默消费 stdin、永不输出（供 abort/stop 语义测试）。
#   error:  打印 "[FAKE-ERROR]" 后 exit 3（非零退出场景）。
#   exit:   打印 "[FAKE-EXIT]" 后 exit 0（自然退出场景）。
#   utf8:   分两次写入多字节字符"你好"的原始字节（模拟跨 chunk 拆分）后待机。
#   family: 后台拉起带标记的孙进程（argv[0]=codearts-tree-marker）后待机，
#           供 stop 全树终止测试（R-p4）经 /proc 扫描核对无残留。
set -u

scenario="default"
if [[ $# -ge 2 && "$1" == "--scenario" ]]; then
  scenario="$2"
fi

case "$scenario" in
  stall)
    # 静默待机：读 stdin 不输出，EOF 退出
    while IFS= read -r _; do :; done
    exit 0
    ;;
  error)
    printf '[FAKE-ERROR]\n'
    exit 3
    ;;
  exit)
    printf '[FAKE-EXIT]\n'
    exit 0
    ;;
  utf8)
    # "你好" 的 UTF-8 字节拆两半写入（e4 bd a0 / e5 a5 bd），中间留间隔，
    # 令管道 chunk 边界大概率落在多字节序列中间（StringDecoder 跨 chunk 场景）
    printf '\xe4\xbd'
    sleep 0.15
    printf '\xa0\xe5\xa5\xbd\n'
    while IFS= read -r _; do :; done
    exit 0
    ;;
  family)
    # 孙进程：argv[0] 改为唯一标记，便于 /proc 扫描核对（不依赖 sleep 时长断言）
    bash -c 'exec -a codearts-tree-marker sleep 300' &
    while IFS= read -r _; do :; done
    exit 0
    ;;
  default)
    # 逐字符读：关 canonical 行缓冲（stty 作用于本 PTY slave；非 tty 直跑时
    # 退化为行读——仅影响手动调试，测试恒经 PTY）
    stty -icanon min 1 time 0 2>/dev/null || :
    buf=""
    while IFS= read -r -N 1 ch; do
      case "$ch" in
        $'\r' | $'\n')
          if [[ -n "$buf" ]]; then
            printf '[RX:%s]\n' "$buf"
            buf=""
          fi
          printf '[ENTER]\n'
          ;;
        *)
          buf+="$ch"
          ;;
      esac
    done
    exit 0
    ;;
esac
