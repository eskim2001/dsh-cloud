#!/bin/sh
# 实例容器入口：先起 dsh 并抓它的入口 token，再起桥。
set -eu

DSH_PORT="${DSH_PORT:-3080}"
BRIDGE_PORT="${BRIDGE_PORT:-8080}"
DATA_ROOT="${DSH_HOME:-/data}"
HOME_DIR="${HOME:-$DATA_ROOT/home}"
DSH_LOG="${DSH_LOG:-/tmp/dsh-boot.log}"

# 卷可能是全新的，把可写目录补齐
mkdir -p \
  "$HOME_DIR" \
  "$HOME_DIR/workspace" \
  "${NPM_CONFIG_PREFIX:-$DATA_ROOT/.npm-global}/bin" \
  "${NPM_CONFIG_CACHE:-$DATA_ROOT/.npm}" \
  "${PNPM_HOME:-$DATA_ROOT/.pnpm}" \
  "${PNPM_STORE_DIR:-$DATA_ROOT/.pnpm-store}" \
  "${XDG_DATA_HOME:-$DATA_ROOT/.caddy/data}" \
  "${XDG_CONFIG_HOME:-$DATA_ROOT/.caddy/config}"

# dsh 的 /api 浏览器信任围栏只放行回环和 `--trusted-host` 声明的 authority。
# 经 Traefik 进来的 Host 是实例公开域名，不声明就被 403（页面能开、API 全挂）。
# 平台用 DSH_TRUSTED_HOSTS 传这个域名，这里翻译成 dsh 的 CLI 参数。
TRUSTED_HOST_ARGS=""
if [ -n "${DSH_TRUSTED_HOSTS:-}" ]; then
  OLD_IFS=$IFS
  IFS=,
  for trusted in $DSH_TRUSTED_HOSTS; do
    if [ -n "$trusted" ]; then
      TRUSTED_HOST_ARGS="$TRUSTED_HOST_ARGS --trusted-host $trusted"
    fi
  done
  IFS=$OLD_IFS
fi

# 1) dsh 本体，只绑回环。
#    `--expose-internals` 是必需的：dsh 的 web profile 会加载 hmr 插件，该插件
#    在构造时硬校验这个 flag；官方 `dsh` 启动器自己不加，必须我们显式带上。
#    （不带会 crash-loop：`--expose-internals is required for HMR service`。）
#    `--patch` 挂平台插件（D15）：把客户端 isLoopback 判真，否则设置面不可用。
#    **必须在 app 参数之前**——启动器只解析自己那一段，`--patch` 落在 `--host` 之后
#    会被当成 web app 的选项，直接 `error: unknown option '--patch'`（实例 crash-loop）。
#    文件缺了 dsh 也会直接退出（响亮失败，不是静默坏设置面）。
: > "$DSH_LOG"   # 先建文件，否则下面的 tail -f 会因文件不存在直接退出
node --expose-internals "$(command -v dsh)" --profile web \
  --patch /etc/platform/owns-host.yml \
  --host 127.0.0.1 --port "${DSH_PORT}" --no-open \
  $TRUSTED_HOST_ARGS "$@" > "$DSH_LOG" 2>&1 &
DSH_PID=$!

# dsh 的日志转进容器 stdout，否则 `docker logs` 看不到它
tail -n +1 -f "$DSH_LOG" &
TAIL_PID=$!

# 2) 抓入口 token：dsh 启动时打印 `.../?token=<token>`，桥用它做 /__open 注入
#    （docs/DECISIONS.md D14）。抓不到就继续起桥，但 /__open 会 401——要显眼。
DSH_LAUNCH_TOKEN=""
i=0
while [ "$i" -lt 240 ]; do
  DSH_LAUNCH_TOKEN=$(sed -n 's/.*[?&]token=\([A-Za-z0-9_-]\{1,\}\).*/\1/p' "$DSH_LOG" | head -n 1)
  [ -n "$DSH_LAUNCH_TOKEN" ] && break
  kill -0 "$DSH_PID" 2>/dev/null || break
  sleep 0.5
  i=$((i + 1))
done
export DSH_LAUNCH_TOKEN
if [ -z "$DSH_LAUNCH_TOKEN" ]; then
  echo "entrypoint: 没抓到 dsh 的入口 token，/__open 将不可用（dsh 是否改了启动输出格式？）" >&2
fi

# 3) 容器内转发器：0.0.0.0:$BRIDGE_PORT → 127.0.0.1:$DSH_PORT
#    dsh 拒绝绑非回环地址，所以这一层是架构必需（见 docs/DECISIONS.md D6）。
caddy run --config /etc/caddy/Caddyfile --adapter caddyfile &
CADDY_PID=$!

# dsh 退出即容器退出（tini 收尸；桥跟着一起停）
wait "$DSH_PID"
kill "$CADDY_PID" "$TAIL_PID" 2>/dev/null || true
