#!/usr/bin/env bash
#
# 构建平台镜像（本地 / 手动发布用）。版本唯一源是旁边的 VERSION 文件 ——
# 平台是**自己的版本线**（普通 semver），与实例镜像的 `<dsh版本>_<修订号>` 无关。
#
# **构建上下文是仓库根**（pnpm workspace 要整个仓库），脚本会自己 cd 过去。
#
#   ./docker/platform/build.sh                      # 打宿主架构的本地 tag，不推
#   PLATFORM=linux/amd64 ./docker/platform/build.sh # 指定架构（单架构）
#   PUSH=1 ./docker/platform/build.sh               # 额外推 GHCR（tag 已存在会拒绝，FORCE=1 覆盖）
#   REPO=ghcr.io/<you>/dsh-cloud ./docker/platform/build.sh
#
# 正式发布走 .github/workflows/platform-image.yml（手动 dispatch，原生 runner 同时出
# linux/amd64 + linux/arm64 并合成一个 tag）。
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
HERE=$PWD
cd ../.. # 仓库根 = 构建上下文

VERSION=$(tr -d '[:space:]' < "$HERE/VERSION")
REPO=${REPO:-ghcr.io/eskim2001/dsh-cloud}
PLATFORM=${PLATFORM:-}
PUSH=${PUSH:-0}

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "VERSION 格式不对：期望普通 semver（如 0.1.0 或 0.1.0-rc.1），实际 '$VERSION'" >&2
  exit 1
fi

GIT_SHA=$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

args=(
  -f docker/platform/Dockerfile
  -t "$REPO:$VERSION"
  --build-arg "GIT_SHA=$GIT_SHA"
  --build-arg "BUILD_TIME=$BUILD_TIME"
)
if [ -n "$PLATFORM" ]; then
  args+=(--platform "$PLATFORM")
fi

docker build "${args[@]}" .

HOST_ARCH=$(docker version --format '{{.Server.Arch}}' 2>/dev/null || echo unknown)
if [ -z "$PLATFORM" ] && [ "$HOST_ARCH" != "amd64" ]; then
  echo "注意：本地 tag 只有 $HOST_ARCH 一份；CI 发布的同名 tag 是 linux/amd64 + linux/arm64。" >&2
fi

if [ "$PUSH" = "1" ]; then
  if docker manifest inspect "$REPO:$VERSION" >/dev/null 2>&1 && [ "${FORCE:-0}" != "1" ]; then
    echo "tag $REPO:$VERSION 已经存在——改 VERSION，或 FORCE=1 强制覆盖。" >&2
    exit 1
  fi
  docker push "$REPO:$VERSION"
fi

echo "built $REPO:$VERSION（sha $GIT_SHA，${PLATFORM:-宿主架构}）"
