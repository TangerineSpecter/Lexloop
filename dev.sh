#!/usr/bin/env bash

# One-command local development bootstrap for Lexloop.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1090
  source "$HOME/.nvm/nvm.sh"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 未找到。请先安装 Node.js 22（可通过 nvm 安装）。" >&2
  exit 1
fi

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm 未找到。请执行：corepack enable && corepack prepare pnpm@9.15.9 --activate" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "Docker Desktop 未启动。请启动 Docker Desktop 后重试。" >&2
  exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "已从 .env.example 创建 .env；首次部署前请替换其中的 JWT 密钥。"
fi

# Prisma runs from apps/api while the project environment file lives at the repository root.
# Export it once so Prisma, API, Worker, and Turbo children share the same configuration.
set -a
# shellcheck disable=SC1091
source .env
set +a

ensure_port_free() {
  local port="$1"
  local service="$2"
  local listener
  # lsof returns exit status 1 when no process is listening, which is the success case here.
  listener="$( (lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true) | awk 'NR == 2 { print $1 " (PID " $2 ")" }' )"
  if [ -n "$listener" ]; then
    echo "${service} 需要使用端口 ${port}，但该端口正被 ${listener} 占用。" >&2
    echo "请先运行 ./stop.sh（或 pnpm dev:stop）清理 Lexloop 旧进程，再运行 ./dev.sh。" >&2
    exit 1
  fi
}

# Fail before starting any task instead of leaving a half-started Web/API/Worker set.
ensure_port_free 52100 "Web"
ensure_port_free "${PORT:-52101}" "API"

if [ ! -d node_modules ] || [ ! -f pnpm-lock.yaml ]; then
  echo "正在安装项目依赖…"
  pnpm install
fi

echo "正在启动 PostgreSQL、Redis 和 MinIO…"
docker compose up -d --wait

echo "正在生成 Prisma 客户端并执行数据库迁移…"
pnpm db:generate
pnpm --filter @lexloop/api exec prisma migrate deploy

WEB_URL="${WEB_ORIGIN:-http://localhost:52100}"
API_URL="http://127.0.0.1:${PORT:-52101}"

echo "正在启动 Web、API 与 Worker，并等待服务就绪…"
pnpm dev &
DEV_PID=$!
READY=0

shutdown() {
  kill -TERM "$DEV_PID" 2>/dev/null || true
  wait "$DEV_PID" 2>/dev/null || true
}
trap shutdown INT TERM

for _ in $(seq 1 60); do
  if curl --fail --silent --output /dev/null "$WEB_URL" && curl --fail --silent --output /dev/null "$API_URL/api/v1/health"; then
    echo
    echo "Lexloop 已就绪："
    echo "  Web:     ${WEB_URL}"
    echo "  API:     ${API_URL}/api/v1/health"
    echo "  Swagger: ${API_URL}/api/docs"
    echo "  MinIO:   http://localhost:9001"
    echo
    READY=1
    break
  fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then
    echo "服务启动失败；请查看上方日志。" >&2
    exit 1
  fi
  sleep 1
done

if [ "$READY" -ne 1 ]; then
  echo "等待 60 秒后服务仍未就绪；请查看上方日志。" >&2
  shutdown
  exit 1
fi

wait "$DEV_PID"
