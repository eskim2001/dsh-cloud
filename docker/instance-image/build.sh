#!/usr/bin/env bash
#
# 构建实例镜像（本地 / 手动发布用）。版本唯一源是旁边的 VERSION 文件。
#
#   ./docker/instance-image/build.sh                      # 打宿主架构的本地 tag，不推
#   PLATFORM=linux/amd64 ./docker/instance-image/build.sh # 和 CI 一样的架构
#   PUSH=1 ./docker/instance-image/build.sh               # 额外推 GHCR（tag 已存在会拒绝，FORCE=1 覆盖）
#   REPO=ghcr.io/<you>/dsh-instance ./docker/instance-image/build.sh
#
# 正式发布走 .github/workflows/instance-image.yml（手动 dispatch，linux/amd64）。
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

VERSION=$(tr -d '[:space:]' < VERSION)
DSH_VERSION=${VERSION%_*}
REVISION=${VERSION##*_}
REPO=${REPO:-ghcr.io/eskim2001/dsh-instance}
PLATFORM=${PLATFORM:-}
PUSH=${PUSH:-0}

if [ -z "$DSH_VERSION" ] || [ "$DSH_VERSION" = "$VERSION" ] || ! [[ "$REVISION" =~ ^[1-9][0-9]*$ ]]; then
  echo "VERSION 格式不对：期望 <dsh版本>_<修订号>（如 0.1.2-rc.1_1），实际 '$VERSION'" >&2
  exit 1
fi

GIT_SHA=$(git rev-parse --short=12 HEAD 2>/dev/null || echo unknown)
BUILD_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)

args=(
  -f Dockerfile
  -t "$REPO:$VERSION"
  --build-arg "DSH_VERSION=$DSH_VERSION"
  --build-arg "REVISION=$REVISION"
  --build-arg "GIT_SHA=$GIT_SHA"
  --build-arg "BUILD_TIME=$BUILD_TIME"
)
if [ -n "$PLATFORM" ]; then
  args+=(--platform "$PLATFORM")
fi

docker build "${args[@]}" .

HOST_ARCH=$(docker version --format '{{.Server.Arch}}' 2>/dev/null || echo unknown)
if [ -z "$PLATFORM" ] && [ "$HOST_ARCH" != "amd64" ]; then
  echo "注意：宿主是 $HOST_ARCH，这不是 CI 发布的那份（linux/amd64）。要一致就 PLATFORM=linux/amd64。" >&2
fi

if [ "$PUSH" = "1" ]; then
  if docker manifest inspect "$REPO:$VERSION" >/dev/null 2>&1 && [ "${FORCE:-0}" != "1" ]; then
    echo "tag $REPO:$VERSION 已经存在——改 VERSION 里的修订号，或 FORCE=1 强制覆盖。" >&2
    exit 1
  fi
  docker push "$REPO:$VERSION"
fi

echo "built $REPO:$VERSION（dsh $DSH_VERSION，修订 $REVISION，sha $GIT_SHA，${PLATFORM:-宿主架构}）"
echo "本地开发请在 apps/server/.env.local 里设置 INSTANCE_IMAGE_REPO=$REPO"
