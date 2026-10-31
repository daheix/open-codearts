#!/usr/bin/env bash
# 真机验收轮询脚本：GET /goals/:id 每 30s 一次，共 N 次（默认 4 次 = 2 分钟窗口）
# 用法: poll.sh <goalId> <次数>
set -u
GOAL_ID="${1:?goalId required}"
N="${2:-4}"
TOKEN=$(cat "$HOME/.codearts-bridge/daemon-token")
DIR="$(cd "$(dirname "$0")" && pwd)"
for i in $(seq 1 "$N"); do
  TS=$(date -Is)
  BODY=$(curl -sS --max-time 10 "http://127.0.0.1:4577/goals/$GOAL_ID" -H "Authorization: Bearer $TOKEN")
  echo "[$TS] poll#$i $BODY" >> "$DIR/poll_timeline.log"
  PHASE=$(echo "$BODY" | sed -n 's/.*"phase":"\([a-z]*\)".*/\1/p')
  if [ "$PHASE" = "complete" ] || [ "$PHASE" = "stopped" ] || [ "$PHASE" = "blocked" ]; then
    echo "[$TS] 终态/blocked: $PHASE — 停止轮询" >> "$DIR/poll_timeline.log"
    exit 0
  fi
  [ "$i" -lt "$N" ] && sleep 30
done
