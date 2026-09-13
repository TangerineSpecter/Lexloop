#!/usr/bin/env bash

set -euo pipefail

readonly DEPLOY_ROOT=/opt/lexloop
readonly REPOSITORY_URL=https://github.com/TangerineSpecter/Lexloop.git
readonly VERSION_INPUT="${1:-}"
readonly BARE_REPOSITORY="${DEPLOY_ROOT}/source/repo.git"
readonly PRODUCTION_ENV="${DEPLOY_ROOT}/config/production.env"

fail() {
  echo "安装失败：$*" >&2
  exit 1
}

if [ "$(id -u)" -ne 0 ]; then
  fail "请使用 sudo 执行此脚本，以便创建 ${DEPLOY_ROOT} 和备份计划。"
fi

if [ -n "$VERSION_INPUT" ]; then
  requested_version="${VERSION_INPUT#v}"
  [[ "$requested_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || \
    fail "版本号必须是稳定 SemVer，例如 v1.0.0。"
fi

for command in docker git openssl curl; do
  command -v "$command" >/dev/null 2>&1 || fail "缺少命令：${command}"
done
docker info >/dev/null 2>&1 || fail "Docker 服务未运行。"
docker compose version >/dev/null 2>&1 || fail "缺少 Docker Compose 插件。"

install -d -m 0755 "${DEPLOY_ROOT}/source" "${DEPLOY_ROOT}/releases"
install -d -m 0700 "${DEPLOY_ROOT}/config" "${DEPLOY_ROOT}/backups" \
  "${DEPLOY_ROOT}/backups/daily" "${DEPLOY_ROOT}/backups/weekly" \
  "${DEPLOY_ROOT}/data/run" "${DEPLOY_ROOT}/data/updater"

if [ ! -d "$BARE_REPOSITORY" ]; then
  git clone --mirror "$REPOSITORY_URL" "$BARE_REPOSITORY"
else
  actual_remote="$(git --git-dir "$BARE_REPOSITORY" remote get-url origin)"
  [ "$actual_remote" = "$REPOSITORY_URL" ] || fail "现有部署仓库来源不可信：${actual_remote}"
fi
git --git-dir "$BARE_REPOSITORY" fetch --prune origin \
  '+refs/heads/master:refs/remotes/origin/master' '+refs/tags/v*:refs/tags/v*'

package_paths=(package.json apps/api/package.json apps/web/package.json \
  apps/worker/package.json packages/types/package.json)

if [ -n "$VERSION_INPUT" ]; then
  VERSION="$requested_version"
  TAG="v${VERSION}"
else
  VERSION=''
  TAG=''
  mapfile -t release_tags < <(
    git --git-dir "$BARE_REPOSITORY" tag --list 'v*' --sort=-v:refname
  )
  for candidate_tag in "${release_tags[@]}"; do
    candidate_version="${candidate_tag#v}"
    [[ "$candidate_version" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]] || continue
    [ "$(git --git-dir "$BARE_REPOSITORY" cat-file -t "refs/tags/${candidate_tag}" 2>/dev/null || true)" = tag ] || continue
    candidate_sha="$(git --git-dir "$BARE_REPOSITORY" rev-list -n 1 "$candidate_tag")"
    git --git-dir "$BARE_REPOSITORY" merge-base --is-ancestor \
      "$candidate_sha" refs/remotes/origin/master || continue
    versions_match=1
    for manifest in "${package_paths[@]}"; do
      package_version="$(git --git-dir "$BARE_REPOSITORY" show "${candidate_sha}:${manifest}" | \
        sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
      if [ "$package_version" != "$candidate_version" ]; then
        versions_match=0
        break
      fi
    done
    if [ "$versions_match" -eq 1 ]; then
      VERSION="$candidate_version"
      TAG="$candidate_tag"
      break
    fi
  done
  [ -n "$TAG" ] || fail "仓库中没有可部署的稳定 annotated tag。"
  echo "未指定版本，将部署最新稳定版本 ${TAG}。"
fi
readonly VERSION TAG

tag_type="$(git --git-dir "$BARE_REPOSITORY" cat-file -t "refs/tags/${TAG}" 2>/dev/null || true)"
[ "$tag_type" = tag ] || fail "${TAG} 不存在或不是 annotated tag。"
commit_sha="$(git --git-dir "$BARE_REPOSITORY" rev-list -n 1 "$TAG")"
git --git-dir "$BARE_REPOSITORY" merge-base --is-ancestor \
  "$commit_sha" refs/remotes/origin/master || fail "${TAG} 不在 origin/master 上。"
for manifest in "${package_paths[@]}"; do
  tag_version="$(git --git-dir "$BARE_REPOSITORY" show "${commit_sha}:${manifest}" | \
    sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
  [ "$tag_version" = "$VERSION" ] || fail "${TAG} 与 ${manifest} 版本不一致。"
done

image_tag="${VERSION}-${commit_sha:0:12}"
release_path="${DEPLOY_ROOT}/releases/${image_tag}"
if [ ! -d "$release_path" ]; then
  git --git-dir "$BARE_REPOSITORY" worktree add --force --detach "$release_path" "$commit_sha"
fi

if [ ! -f "$PRODUCTION_ENV" ]; then
  postgres_password="$(openssl rand -hex 24)"
  cat >"$PRODUCTION_ENV" <<EOF
POSTGRES_USER=lexloop
POSTGRES_PASSWORD=${postgres_password}
POSTGRES_DB=lexloop
MINIO_ACCESS_KEY=lexloop
MINIO_SECRET_KEY=$(openssl rand -hex 24)
JWT_ACCESS_SECRET=$(openssl rand -hex 48)
JWT_REFRESH_SECRET=$(openssl rand -hex 48)
AI_CONFIG_ENCRYPTION_KEY=$(openssl rand -hex 32)
AI_API_KEY=
AI_BASE_URL=https://api.deepseek.com
AI_MODEL=deepseek-v4-flash
WEB_ORIGIN=http://localhost
COOKIE_SECURE=false
HTTP_PORT=80
NODE_IMAGE=${NODE_IMAGE:-node:22.14.0-bookworm-slim}
DOCKER_CLI_IMAGE=${DOCKER_CLI_IMAGE:-docker:27.5.1-cli}
POSTGRES_IMAGE=${POSTGRES_IMAGE:-pgvector/pgvector:0.8.0-pg16}
REDIS_IMAGE=${REDIS_IMAGE:-redis:7.4.2-alpine}
CADDY_IMAGE=${CADDY_IMAGE:-caddy:2.9.1-alpine}
MINIO_IMAGE=${MINIO_IMAGE:-minio/minio:RELEASE.2025-02-07T23-21-09Z}
EOF
fi
chmod 0600 "$PRODUCTION_ENV"

set_env() {
  local key="$1"
  local value="$2"
  if grep -q "^${key}=" "$PRODUCTION_ENV"; then
    sed -i "s|^${key}=.*|${key}=${value}|" "$PRODUCTION_ENV"
  else
    printf '%s=%s\n' "$key" "$value" >>"$PRODUCTION_ENV"
  fi
}

set_env APP_VERSION "$VERSION"
set_env APP_COMMIT_SHA "$commit_sha"
set_env APP_BUILD_TIME "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
set_env LEXLOOP_IMAGE_TAG "$image_tag"
set_env CURRENT_RELEASE_PATH "$release_path"

set -a
# shellcheck disable=SC1090
source "$PRODUCTION_ENV"
set +a

docker network inspect lexloop_internal >/dev/null 2>&1 || docker network create lexloop_internal >/dev/null
compose=(docker compose --project-name lexloop --env-file "$PRODUCTION_ENV" \
  --file "$release_path/deploy/compose.prod.yml")

echo "正在构建 Lexloop ${TAG}…"
"${compose[@]}" config --quiet
"${compose[@]}" build web api worker migrate
"${compose[@]}" up -d postgres redis
"${compose[@]}" run --rm migrate
"${compose[@]}" up -d --no-build postgres redis web api worker gateway

if [ ! -f "${DEPLOY_ROOT}/data/updater/update-state.json" ]; then
  cat >"${DEPLOY_ROOT}/data/updater/update-state.json" <<EOF
{
  "deployment": {
    "version": "${VERSION}",
    "sha": "${commit_sha}",
    "imageTag": "${image_tag}",
    "releasePath": "${release_path}"
  },
  "latest": null,
  "checkedAt": null,
  "checkError": null,
  "job": null,
  "history": []
}
EOF
  chmod 0600 "${DEPLOY_ROOT}/data/updater/update-state.json"
fi

docker compose --project-name lexloop-ops --env-file "$PRODUCTION_ENV" \
  --file "$release_path/deploy/compose.ops.yml" up -d --build updater

ready=0
for _ in $(seq 1 90); do
  if health="$(curl --fail --silent --max-time 3 "http://127.0.0.1:${HTTP_PORT}/api/v1/health" 2>/dev/null)" && \
    grep -q "\"commitSha\":\"${commit_sha}\"" <<<"$health"; then
    ready=1
    break
  fi
  sleep 1
done
[ "$ready" -eq 1 ] || fail "服务未在 90 秒内通过健康检查，请运行 docker compose logs 检查。"

install -m 0755 "$release_path/deploy/backup.sh" "${DEPLOY_ROOT}/backup.sh"
cat >/etc/cron.d/lexloop-backup <<EOF
17 3 * * * root ${DEPLOY_ROOT}/backup.sh >>${DEPLOY_ROOT}/backups/backup.log 2>&1
EOF
chmod 0644 /etc/cron.d/lexloop-backup

echo
echo "Lexloop ${TAG} 已部署完成。"
echo "访问地址：http://<服务器IP>:${HTTP_PORT}"
echo "请立即注册第一个账号；空数据库中的首个账号会成为唯一管理员。"
echo "生产配置：${PRODUCTION_ENV}"
echo "手动备份：${DEPLOY_ROOT}/backup.sh"
