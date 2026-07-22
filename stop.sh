#!/usr/bin/env bash

# Stops only Lexloop development processes. Docker data services are left running.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIDS="$(pgrep -f "$ROOT_DIR" || true)"
STOPPED=0

for pid in $PIDS; do
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$command" in
    *"$ROOT_DIR/node_modules"*turbo*|*"$ROOT_DIR/apps/web"*next*|*"$ROOT_DIR/apps/api"*nest*|*"$ROOT_DIR/apps/api/dist/src/main"*|*"$ROOT_DIR/apps/worker"*)
      kill -TERM "$pid" 2>/dev/null || true
      STOPPED=1
      ;;
  esac
done

if [ "$STOPPED" -eq 1 ]; then
  echo "已停止 Lexloop 的 Web、API、Worker 与 Turbo 开发进程。Docker 服务仍在运行。"
else
  echo "未发现正在运行的 Lexloop 开发进程。"
fi
