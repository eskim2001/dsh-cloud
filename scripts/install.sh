#!/usr/bin/env bash
#
# dsh-cloud 一键安装 / 升级 / 卸载。**在宿主机上以 root 跑**，不是在容器里。
#
#   curl -fsSL https://raw.githubusercontent.com/eskim2001/dsh-cloud/v0.1.0/scripts/install.sh \
#     | sudo bash -s -- --version 0.1.0
#
# 子命令：install（默认）/ update / uninstall
#
# 它做四件事，顺序不能换：
#   ① 预检（环境 / 端口 / **存储能力**）
#   ② 在**宿主上**预置存储池并写持久化 —— 容器里建池宿主看不见（见 D35）
#   ③ 从镜像里取部署资产到 /opt/dsh-cloud，渲染 Traefik 配置
#   ④ 起 Postgres → 迁移 → 建管理员 → 起控制面与入口
#
# **幂等**：/opt/dsh-cloud/.env 存在时 install 等价于 update，且**绝不重新生成 secret**
#     —— 换了 PLATFORM_SECRET，所有实例的门 token 立刻全废（桥 403）。
#
# 设计取舍见 docs/DECISIONS.md 的 D32–D35；前置条件见 PLAN.md 的 M1.5。
set -euo pipefail

STATE_DIR=/opt/dsh-cloud
IMAGE_REPO=ghcr.io/eskim2001/dsh-cloud
DEFAULT_POOL_ROOT=/var/lib/dsh
POSTGRES_PORT_DEFAULT=55432
CONSOLE_LABEL=console

# ── 参数默认值 ──────────────────────────────────────────────────────────
CMD=install
VERSION=${DSH_CLOUD_VERSION:-}
DOMAIN=${DSH_DOMAIN:-}
ACME_EMAIL=${DSH_ACME_EMAIL:-}
ADMIN_EMAIL=${DSH_ADMIN_EMAIL:-}
POOL_SIZE_MB=${DSH_POOL_SIZE_MB:-}
POOL_ROOT=$DEFAULT_POOL_ROOT
ACME=1
ACME_SET=0
NONINTERACTIVE=0
PURGE=0
FORCE_SECRETS=0

# 由 seed_admin 填，最后打印时用
ADMIN_CREATED=0
ADMIN_PASSWORD=
# 由 fetch_assets 填：拉到的镜像 digest（写进 .installed-version，标签漂移时靠它认版本）
IMAGE_DIGEST=

STEP='初始化'
trap 'on_fail' ERR

log() { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m警告：\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m错误：\033[0m %s\n' "$*" >&2; exit 1; }

on_fail() {
  printf '\n\033[31m✗ 安装失败于：%s\033[0m\n' "$STEP" >&2
  printf '  状态目录 %s 已写入的内容**保留**（幂等，排障后重跑本脚本即可）。\n' "$STATE_DIR" >&2
  printf '  看日志：docker compose -f %s/prod.yml logs --tail=50\n' "$STATE_DIR" >&2
}

usage() {
  # $0 在 `curl | bash` 下是 "bash"，不是文件 —— 那时只打印下面这段，不读文件头
  if [ -f "$0" ]; then sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; fi
  cat <<'EOF'

用法：install.sh [子命令] [选项]

子命令
  install            安装（默认）；已装过则等价于 update
  update             拉新镜像、重渲染配置、重启服务（保留数据与 secret）
  uninstall          停服务并删容器（**保留** Postgres 卷与存储池）

选项
  --version <tag>    平台镜像 tag，如 0.1.0。省略 = 用 latest（**会漂移**；装到的 digest 会记下来）
  --domain <域名>    父域，如 example.com（实例子域是 <slug>.example.com）。
                     **可以不给**：不给就是「引导态」—— 装完只开一个 token 门保护的 setup 页，
                     操作者在浏览器里填域名。在已有安装上再跑一次并带上它，可以**补配或改配**域名
                     （那时以 env 为准；面板里存的那份 DB 记录不跟着变）。
  --email <邮箱>     ACME 账户邮箱，会收到证书过期提醒。**可选**：不给就没有提醒（证书照签）
  --admin-email <邮箱>  首个管理员的登录邮箱
  --pool-root <路径> 存储池根，默认 /var/lib/dsh
  --pool-size-mb <MB> 需要自动建 loopback 池时用；省略取该文件系统的 80%
  --acme             配 ACME 自动签证书（默认）。重跑时可用来覆盖上次的 --no-acme
  --no-acme          不配 ACME，证书由你自己放进 file provider
  --non-interactive  不提问，全部走参数 / 环境变量
  --purge            （uninstall）连 Postgres 卷、存储池、状态目录一起删 —— **不可恢复**
  -h, --help         显示这段
EOF
}

# ── 参数解析 ────────────────────────────────────────────────────────────
if [ $# -gt 0 ]; then
  case "$1" in
    install | update | uninstall) CMD=$1; shift ;;
  esac
fi

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION=${2:?--version 后面要给 tag}; shift 2 ;;
    --domain) DOMAIN=${2:?--domain 后面要给域名}; shift 2 ;;
    --email) ACME_EMAIL=${2:?--email 后面要给邮箱}; shift 2 ;;
    --admin-email) ADMIN_EMAIL=${2:?--admin-email 后面要给邮箱}; shift 2 ;;
    --pool-root) POOL_ROOT=${2:?--pool-root 后面要给路径}; shift 2 ;;
    --pool-size-mb) POOL_SIZE_MB=${2:?--pool-size-mb 后面要给数字}; shift 2 ;;
    --acme) ACME=1; ACME_SET=1; shift ;;
    --no-acme) ACME=0; ACME_SET=1; shift ;;
    --non-interactive) NONINTERACTIVE=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die "认不出的参数：$1（-h 看用法）" ;;
  esac
done

# ── 小工具 ──────────────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }

rand_hex() { # 32 字节十六进制。十六进制是**有意的**：它会进 DATABASE_URL，不用再转义
  if have openssl; then
    openssl rand -hex 32
  else
    od -An -tx1 -N32 /dev/urandom | tr -d ' \n'
  fi
}

env_get() { # 从 .env 里读一个键（不 source：值可能带奇怪字符）
  [ -f "$STATE_DIR/.env" ] || return 0
  sed -n "s/^$1=//p" "$STATE_DIR/.env" | head -1
}

compose() { docker compose -f "$STATE_DIR/prod.yml" --project-directory "$STATE_DIR" "$@"; }

# 有没有**可交互**的终端。`curl | bash` 时 stdin 是管道，但 /dev/tty 通常可用；
# ssh 非交互、cron、CI 里没有 —— 那时直接 read 会往 stderr 甩 "No such device or address"。
# 所以先探测：探不到就当非交互处理，缺什么参数由 preflight / 摘要说清楚。
can_prompt() { { true </dev/tty; } 2>/dev/null; }

ask() { # ask <提示> <默认值>
  local prompt=$1 def=${2:-} reply
  if [ "$NONINTERACTIVE" = 1 ] || ! can_prompt; then
    [ -n "$def" ] || die "缺 $prompt（此刻没有可交互的终端，请用命令行参数给出来）"
    printf '%s' "$def"
    return
  fi
  if [ -n "$def" ]; then read -r -p "$prompt [$def]: " reply </dev/tty || reply=; else read -r -p "$prompt: " reply </dev/tty || reply=; fi
  printf '%s' "${reply:-$def}"
}

# ── ① 预检 ──────────────────────────────────────────────────────────────
preflight() {
  STEP='预检'

  [ "$(id -u)" = 0 ] || die "要 root（要建挂载点、写 fstab、装存储池）。用 sudo 跑。"

  [ "$(uname -s)" = Linux ] || die "只支持 Linux。macOS / Docker Desktop 请用仓库里的本地开发栈（见 docker/compose/README.md）。"

  if [ -f /.dockerenv ] || grep -qa 'docker\|containerd' /proc/1/cgroup 2>/dev/null; then
    die "看起来在**容器里**跑。本脚本要在宿主机上执行：它要建挂载、写 fstab、并让 Docker 用宿主路径挂卷。"
  fi

  have docker || die "没装 Docker。"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 不可用（需要 \`docker compose\` 子命令，不是老的 docker-compose）。"
  docker info >/dev/null 2>&1 || die "连不上 Docker daemon（docker info 失败）。"

  # 80/443：**只有首装才要求它们空闲**。更新时占着这两个端口的正是我们自己的入口，
  # 要求空闲会让 `update` 永远跑不起来（实测 2026-09-14：在跑着的部署上重跑，直接卡在这）。
  # 真被别人占了的话，`compose up` 会当场报出来 —— 报在真正出事的那一步。
  if [ ! -f "$STATE_DIR/.env" ]; then
    # 用 if 而不是 `cmd && die`：端口**空闲**时那条链的左半边是失败的，读起来像「空闲就报错」。
    local p
    for p in 80 443; do
      if have ss; then
        if ss -ltnH "sport = :$p" 2>/dev/null | grep -q .; then
          die "端口 $p 已被占用。先腾出来（入口要绑它）。"
        fi
      elif have lsof; then
        if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then
          die "端口 $p 已被占用。"
        fi
      fi
    done
  fi

  resolve_version
}

resolve_version() {
  if [ -z "$VERSION" ] && [ -f "$(dirname "$0")/../docker/platform/VERSION" ]; then
    # 直接从仓库里跑（开发 / 排障）时顺手读一下，省得每次带 --version
    VERSION=$(tr -d '[:space:]' <"$(dirname "$0")/../docker/platform/VERSION")
  fi
  if [ -z "$VERSION" ]; then
    VERSION=latest
    warn "没给 --version：用 latest —— 它**会漂移**，同一个命令今天和下周装出来的不是同一版。要可复现就钉一个 tag（--version 0.1.0）。实际装到的 digest 会记进 $STATE_DIR/.installed-version。"
  fi
  printf '%s' "$VERSION" | grep -qE '^([0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?|latest)$' ||
    die "版本形状不对（期望普通 semver 如 0.1.0，或 latest）：$VERSION"
}

# 装的是哪个镜像的**哪一份**。版本标签可能漂移（latest），digest 不会 ——
# 「我到底装的哪版」靠它回答，别只记标签。
image_digest() {
  docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$1" 2>/dev/null | head -1
}

# ── ② 存储池：在**宿主**上预置并持久化（见 D35）──────────────────────────
# 判定与平台启动时的探针**同源**：路径所在文件系统是 XFS 且挂了 pquota → 直接用。
# 否则建一块 loopback XFS 镜像。容器里建池宿主看不见，所以这件事必须在宿主上做完。
pool_is_ready() {
  have findmnt || return 1
  local fstype opts
  fstype=$(findmnt -n -o FSTYPE --target "$POOL_ROOT" 2>/dev/null) || return 1
  [ "$fstype" = xfs ] || return 1
  opts=$(findmnt -n -o OPTIONS --target "$POOL_ROOT" 2>/dev/null)
  case "$opts" in
    *pquota* | *prjquota*) return 0 ;;
    *) return 1 ;;
  esac
}

provision_pool() {
  STEP="预置存储池（$POOL_ROOT）"

  mkdir -p "$POOL_ROOT"

  if pool_is_ready; then
    log "存储池已就绪：$POOL_ROOT 是挂了 pquota 的 XFS"
    return
  fi

  if findmnt -n -o FSTYPE --target "$POOL_ROOT" >/dev/null 2>&1 &&
    [ "$(findmnt -n -o FSTYPE --target "$POOL_ROOT")" = xfs ]; then
    # 已经是 XFS，只是没挂 pquota —— 当场 remount 是**不安全**的（改挂载选项要 umount，
    # 而 umount 会失败：池子可能正被实例用着）。交给操作者。
    die "$POOL_ROOT 已经是 XFS，但没以 pquota 挂载。加 pquota 要 umount 重挂，脚本不替你做 —— 请改 /etc/fstab 里的挂载选项后重跑。"
  fi

  local img="$POOL_ROOT.img"
  local size_mb="$POOL_SIZE_MB"

  if [ -e "$img" ]; then
    log "池子镜像已存在：$img（不重建 —— 重建会抹掉现有数据）"
  else
    local avail_mb
    avail_mb=$(df -Pm "$(dirname "$POOL_ROOT")" | awk 'NR==2 {print $4}')
    [ -n "$avail_mb" ] || die "读不出 $(dirname "$POOL_ROOT") 的可用空间（df 输出没认出）。用 --pool-size-mb 显式给一个。"
    if [ -z "$size_mb" ]; then
      size_mb=$((avail_mb * 80 / 100))
      log "没给 --pool-size-mb，取所在文件系统可用空间的 80%：${size_mb} MiB"
    fi
    if [ "$size_mb" -gt "$avail_mb" ]; then
      die "池子要 ${size_mb} MiB，但 $(dirname "$POOL_ROOT") 只有 ${avail_mb} MiB 可用。"
    fi
    log "建 ${size_mb} MiB 稀疏镜像 $img 并 mkfs.xfs"
    truncate -s "${size_mb}M" "$img"
    have mkfs.xfs || die "缺 mkfs.xfs。装一下：apt-get install -y xfsprogs（或 yum/dnf install xfsprogs）"
    mkfs.xfs -q -f "$img"
  fi

  # 用 fstab 的 `loop` 选项挂：不钉 /dev/loopN（重启后编号会变）。
  # nofail 是有意的 —— 池子挂了不该让宿主机进 emergency；平台启动时会自己拒绝启动，
  # 那是**看得见**的失败，比开不了机强。
  STEP="写 fstab 并挂载 $POOL_ROOT"
  if ! grep -qE "^[^#]*[[:space:]]${POOL_ROOT}[[:space:]]" /etc/fstab; then
    log "写 /etc/fstab（重启后自动挂回）"
    printf '# dsh-cloud 实例数据池（D18/D35）\n%s %s xfs loop,pquota,nofail,defaults 0 0\n' \
      "$img" "$POOL_ROOT" >>/etc/fstab
  fi

  if mountpoint -q "$POOL_ROOT" 2>/dev/null; then
    die "$POOL_ROOT 已经挂着别的东西，且不是「XFS + pquota」。先 umount 并清掉旧挂载再重跑。"
  fi
  mount "$POOL_ROOT" || die "挂 $POOL_ROOT 失败。检查 /etc/fstab 里那一行，或看 dmesg。"

  pool_is_ready || die "$POOL_ROOT 挂上了但不是「XFS + pquota」。配额强制不了，平台会拒绝启动。"
  log "存储池就绪：$POOL_ROOT（loopback XFS + pquota，已写进 fstab）"
}

# ── ③ 部署资产与配置渲染 ────────────────────────────────────────────────
fetch_assets() {
  STEP='取部署资产'
  log "拉平台镜像 $IMAGE_REPO:$VERSION"
  docker pull -q "$IMAGE_REPO:$VERSION" >/dev/null || die "拉不到 $IMAGE_REPO:$VERSION（检查 tag 和网络；GHCR 包需要是公开的）"
  IMAGE_DIGEST=$(image_digest "$IMAGE_REPO:$VERSION")
  # 标签可能是漂移的（latest），digest 不是 —— 把它记下来，「我到底装的哪版」才有答案
  log "digest：${IMAGE_DIGEST:-（拿不到，非 registry 拉来的镜像没有 RepoDigests）}"

  # 部署资产**随镜像走**：这样模板和镜像版本严格对齐，安装时也不用再连第二个域名。
  # docker cp 直接读镜像文件系统，不依赖镜像里有哪些命令。
  log "从镜像里取部署资产到 $STATE_DIR"
  local cid
  cid=$(docker create "$IMAGE_REPO:$VERSION")
  mkdir -p "$STATE_DIR"
  docker cp "$cid:/app/deploy/." "$STATE_DIR/" || {
    docker rm -f "$cid" >/dev/null
    die "镜像里没有 /app/deploy（镜像太旧？换新 tag）"
  }
  docker rm -f "$cid" >/dev/null

  mkdir -p "$STATE_DIR/traefik/dynamic" "$STATE_DIR/traefik/acme"
}

render_configs() {
  STEP='渲染 Traefik 配置'

  # 静态配置：ACME 那段是可选的，--no-acme 时按 marker 整段删掉。
  if [ "$ACME" = 1 ]; then
    if [ -n "$ACME_EMAIL" ]; then
      sed -e "s|__ACME_EMAIL__|${ACME_EMAIL}|g" \
        "$STATE_DIR/traefik/traefik.yml.tmpl" >"$STATE_DIR/traefik/traefik.yml"
    else
      # 没邮箱就**删掉那一行**：`email:` 留空在 YAML 里是 null，Traefik 未必收；
      # 而 email 本身是**可选**的（实测：不带 email 的 resolver 通过校验，ACME 照常工作）。
      sed -e '/^ *email: __ACME_EMAIL__$/d' \
        "$STATE_DIR/traefik/traefik.yml.tmpl" >"$STATE_DIR/traefik/traefik.yml"
    fi
  else
    sed -e '/# >>> acme/,/# <<< acme/d' \
      "$STATE_DIR/traefik/traefik.yml.tmpl" >"$STATE_DIR/traefik/traefik.yml"
    warn "--no-acme：没有 ACME。证书要你自己放进 $STATE_DIR/traefik/dynamic/（file provider 的静态证书，按 SNI 匹配），否则浏览器会看到 Traefik 的默认自签证书。"
  fi
  rm -f "$STATE_DIR/traefik/traefik.yml.tmpl"

  # 动态那份（控制台 router / :80 跳转 / 引导口）**不在这里渲染** —— 控制面是它的唯一写者，
  # 每次启动按当前状态（配没配域名）自己写、自己删。安装脚本插一脚只会两边打架。
}

write_env() {
  STEP='写 .env'

  if [ -f "$STATE_DIR/.env" ] && [ "$FORCE_SECRETS" != 1 ]; then
    log ".env 已存在，**保留现有 secret**（重新生成会让所有实例的门 token 立刻失效）"
    PLATFORM_SECRET=$(env_get PLATFORM_SECRET)
    BETTER_AUTH_SECRET=$(env_get BETTER_AUTH_SECRET)
    POSTGRES_PASSWORD=$(env_get POSTGRES_PASSWORD)
    # 引导态那枚一次性 token 也照旧 —— 重跑一次就换掉它，等于把刚打印给操作者的链接作废
    SETUP_TOKEN=$(env_get SETUP_TOKEN)
    [ -n "$PLATFORM_SECRET" ] || die ".env 在，但读不到 PLATFORM_SECRET。修好它，或删掉 $STATE_DIR/.env 重装（会换 secret）。"
    [ -n "$POSTGRES_PASSWORD" ] || die ".env 在，但读不到 POSTGRES_PASSWORD —— DATABASE_URL 会拼错。修好它。"
  else
    PLATFORM_SECRET=$(rand_hex)
    BETTER_AUTH_SECRET=$(rand_hex)
    POSTGRES_PASSWORD=$(rand_hex)
    SETUP_TOKEN=''
  fi

  # 引导态（这次没给域名）需要一枚一次性凭证；已经配好域名就清空它（那时代码根本不读它）
  if [ -n "$DOMAIN" ]; then
    SETUP_TOKEN=''
  elif [ -z "$SETUP_TOKEN" ]; then
    SETUP_TOKEN=$(rand_hex)
  fi

  local tmp="$STATE_DIR/.env.new"
  # 别写成 `X=$([ ... ] && printf le)`：--no-acme 时那条命令返回 1，会把 set -e 打炸
  local cert_resolver=''
  if [ "$ACME" = 1 ]; then cert_resolver=le; fi
  cat >"$tmp" <<EOF
# 由 scripts/install.sh 生成。手改要小心：secret 一换，实例的门 token 全废（桥 403）。
DATABASE_URL=postgres://dshcloud:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT}/dsh_cloud
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
POSTGRES_PORT=${POSTGRES_PORT}

BASE_DOMAIN=${DOMAIN}
CONSOLE_DOMAIN=${CONSOLE_DOMAIN}
PUBLIC_SCHEME=https

# 域名两项都空 = **引导态**：装完只暴露 setup 页，操作者带着下面这枚 token 在面板里填域名。
# 它是一次性凭证，配好域名后引导口被摘掉、它自然失效（见 control-plane 的 setup-routes）。
SETUP_TOKEN=${SETUP_TOKEN}

PLATFORM_SECRET=${PLATFORM_SECRET}
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}

# 平台镜像 tag（compose 用它选镜像）
DSH_CLOUD_IMAGE=${IMAGE_REPO}:${VERSION}

PORT=${CONTROL_PORT}
WEB_DIST_DIR=/app/web

HOST_STORAGE_ROOT=${POOL_ROOT}
TRAEFIK_ENTRYPOINT=websecure
TRAEFIK_CERT_RESOLVER=${cert_resolver}
INSTANCE_UPSTREAM_HOST=127.0.0.1
INSTANCE_IMAGE_REPO=ghcr.io/eskim2001/dsh-instance

# 安装脚本自己用（控制面不读）：重跑 / 升级时照这两项重新渲染 Traefik 配置
INSTALL_ACME=${ACME}
INSTALL_ACME_EMAIL=${ACME_EMAIL}

TRAEFIK_ROUTES_PATH=/etc/traefik/dynamic/routes.yml
FORWARD_AUTH_ADDRESS=http://127.0.0.1:${CONTROL_PORT}/auth/verify

MAX_INSTANCES_PER_USER=3
EOF
  install -m 600 "$tmp" "$STATE_DIR/.env"
  rm -f "$tmp"
}

domain_setup() {
  STEP='确定域名'

  # 域名**可以不给**：不给就是引导态 —— 装完只暴露 token 门保护的 setup 页，操作者在面板里填。
  # 所以这里不能用 ask()（它在 --non-interactive 下没有默认值就直接 die），要允许空。
  if [ -z "$DOMAIN" ] && [ "$NONINTERACTIVE" != 1 ] && can_prompt; then
    read -r -p "父域（留空 = 装完在面板里配，先只开一个引导页）: " DOMAIN </dev/tty || DOMAIN=
  fi

  CONSOLE_DOMAIN=''
  if [ -n "$DOMAIN" ]; then
    printf '%s' "$DOMAIN" | grep -qE '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$' ||
      die "域名形状不对（只允许小写字母 / 数字 / . / -）：$DOMAIN"
    case "$DOMAIN" in
      *.*) ;;
      *) die "域名至少要有一个点（如 example.com）—— 父域本身不当主机名用，控制台在 ${CONSOLE_LABEL}.<父域>。" ;;
    esac
    CONSOLE_DOMAIN="${CONSOLE_LABEL}.${DOMAIN}"
  fi

  CONTROL_PORT=3000
  POSTGRES_PORT=$POSTGRES_PORT_DEFAULT

  if [ -z "$ADMIN_EMAIL" ]; then
    ADMIN_EMAIL=$(ask "首个管理员的登录邮箱")
  fi
  [ -n "$ADMIN_EMAIL" ] || die "没给管理员邮箱。"

  # 邮箱是**可选**的（Traefik 的 ACME 块不带 email 也通过校验）：不给就收不到证书过期提醒。
  # 所以这里不走 ask() —— 它在 --non-interactive 下没有默认值就会直接 die。
  if [ "$ACME" = 1 ] && [ -z "$ACME_EMAIL" ] && [ "$NONINTERACTIVE" != 1 ] && can_prompt; then
    read -r -p "ACME 账户邮箱（可留空 —— 留空就收不到证书过期提醒）: " ACME_EMAIL </dev/tty || ACME_EMAIL=
  fi

  # 没给域名就没什么可查的（引导态那句提示留给最后的摘要）
  if [ -n "$DOMAIN" ]; then dns_check; fi
}

dns_check() {
  # 粗检，**只警告不拦**：解析可能是 CDN / 反代 / 泛解析之外的做法，脚本判不了。
  have getent || return 0
  local probe="dsh-check-$$.${DOMAIN}" resolved
  resolved=$(getent hosts "$probe" 2>/dev/null | awk 'NR==1 {print $1}')
  if [ -z "$resolved" ]; then
    warn "解析不到 $probe —— 泛解析（*.$DOMAIN）大概率没配好，ACME 会签不下来。"
  fi
  if have curl; then
    local pub
    pub=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
    if [ -n "$pub" ] && [ -n "$resolved" ] && [ "$pub" != "$resolved" ]; then
      warn "本机公网 IP 是 $pub，而 $probe 解析到 $resolved —— 对不上的话 ACME 必然失败（除非前面有反代）。"
    fi
  fi
  [ "$ACME" = 1 ] && warn "ACME 走 HTTP-01：宿主 80 端口要对公网可达，别被防火墙 / 云安全组挡了。"
  return 0
}

# ── ④ 起服务 ────────────────────────────────────────────────────────────
start_services() {
  STEP='起 Postgres'
  log "起 Postgres 并等它就绪"
  compose up -d postgres

  local tries=60
  until compose exec -T postgres pg_isready -U dshcloud -d dsh_cloud >/dev/null 2>&1; do
    tries=$((tries - 1))
    [ "$tries" -gt 0 ] || die "Postgres 60 秒内没就绪。看：docker compose -f $STATE_DIR/prod.yml logs postgres"
    sleep 1
  done

  STEP='跑数据库迁移'
  log "迁移"
  compose run --rm control-plane migrate

  STEP='建首个管理员'
  if [ -n "$ADMIN_EMAIL" ]; then
    seed_admin
  else
    log "没给 --admin-email，跳过 seed（已有管理员就不需要；要补建就带上这个参数）"
  fi

  STEP='起控制面与入口'
  compose up -d control-plane traefik

  STEP='等控制面就绪'
  wait_for_console

  printf '\n\033[32m✓ 装好了\033[0m\n\n'
  # 「配好没配好」看**控制面的投影**，不看 `$DOMAIN`：在一台已配置的机器上重跑时，`.env` 里的域名
  # 是空的（域名存在库里），照 `$DOMAIN` 判会把它当成引导态、打印一条已经作废的 setup 指引。
  local configured=0
  if [ -f "$STATE_DIR/traefik/dynamic/platform.yml" ]; then configured=1; fi
  if [ -n "$DOMAIN" ]; then
    printf '  控制台　　：https://%s\n' "$CONSOLE_DOMAIN"
    printf '  实例　　　：https://<子域名>.%s\n' "$DOMAIN"
  elif [ "$configured" = 1 ]; then
    printf '  域名　　　：已配置（存在平台的库里，控制台在 console.<你当初填的那个域名>）\n'
  else
    printf '  \033[1m下一步：用浏览器打开下面这条链接，把域名填进去。\033[0m\n\n'
    printf '    http://%s/setup?token=%s\n' "$(machine_address)" "$SETUP_TOKEN"
    printf '\n'
    printf '  现在是**引导态**：平台只开着这一个 setup 页，那枚 token 即是它的唯一凭证（一次性）。\n'
    printf '  填完域名它会立刻关掉这个入口并重启，控制台就落在 console.<你填的域名>。\n'
    printf '  填之前先把泛解析 *.<你填的域名> 指向这台机器 —— 否则证书签不下来。\n'
  fi
  printf '  管理员　　：%s\n' "$ADMIN_EMAIL"
  if [ "$ADMIN_CREATED" = 1 ]; then
    printf '  一次性密码：%s\n' "$ADMIN_PASSWORD"
    printf '\n'
    printf '  这个密码**只出现这一次**（库里存的是哈希，找不回来）。现在就登录改掉。\n'
  elif [ -n "$ADMIN_EMAIL" ]; then
    printf '\n'
    printf '  管理员已存在，**密码没动**（seed 只在零管理员时建号）。用原密码登录。\n'
  fi
  if [ "$ACME" = 1 ] && [ "$configured" = 1 ]; then
    printf '  首次访问时 ACME 可能还在签发证书（几秒到一分钟），报证书错就等一下再刷。\n'
  fi
  printf '\n'
  printf '  下一步：登录 → 管理台「镜像管理」把实例镜像设为默认 → 建实例。\n'
  printf '  安全边界（为什么控制面持有 docker.sock + CAP_SYS_ADMIN 是预期内的）：\n'
  printf '    https://github.com/eskim2001/dsh-cloud/blob/main/docs/ARCHITECTURE.md\n'
}

# 引导期要打印一个操作者**能直接打开**的地址：优先公网 IP（他浏览器能到的是那个），
# 拿不到就退到本机第一个非回环地址（内网部署够用）。
machine_address() {
  if have curl; then
    local pub
    pub=$(curl -fsS --max-time 5 https://api.ipify.org 2>/dev/null || true)
    if [ -n "$pub" ]; then
      printf '%s' "$pub"
      return 0
    fi
  fi
  hostname -I 2>/dev/null | awk '{print $1}'
}

seed_admin() {
  ADMIN_PASSWORD=$(rand_hex | cut -c1-24)
  local out
  log "管理员 $ADMIN_EMAIL"
  # 密码走 `-e` 传给一次性容器，**不落盘** —— 只在最后打印一次。
  # seed 只在「还没有管理员」时建号，已有就跳过；所以**不能**无条件打印密码（那是骗人的），
  # 靠 seed 自己的输出来判定到底建没建。
  if ! out=$(compose run --rm \
    -e "SEED_ADMIN_EMAIL=${ADMIN_EMAIL}" \
    -e "SEED_ADMIN_PASSWORD=${ADMIN_PASSWORD}" \
    -e "SEED_ADMIN_NAME=admin" \
    control-plane seed 2>&1); then
    printf '%s\n' "$out" >&2
    die "seed 失败（上面是它的输出）。"
  fi
  if printf '%s\n' "$out" | grep -q '已创建管理员'; then ADMIN_CREATED=1; fi
}

wait_for_console() {
  if ! have curl; then
    warn "宿主没有 curl，跳过就绪检查。自己确认：curl -fsS http://127.0.0.1:${CONTROL_PORT}/healthz"
    return
  fi
  local tries=45
  until curl -fsS --max-time 3 "http://127.0.0.1:${CONTROL_PORT}/healthz" >/dev/null 2>&1; do
    tries=$((tries - 1))
    if [ "$tries" -le 0 ]; then
      die "控制面 45 秒内 /healthz 不通。常见原因：存储池不满足（HOST_STORAGE_ROOT）—— 看 \`docker compose -f $STATE_DIR/prod.yml logs control-plane\`。"
    fi
    sleep 1
  done
  log "控制面就绪"
}

# ── 子命令 ──────────────────────────────────────────────────────────────
cmd_install() {
  local first_time=1

  if [ -f "$STATE_DIR/.env" ]; then
    # 已有安装：**先**把上次的值读进来，再预检 —— preflight 和渲染都依赖它们。
    first_time=0
    DOMAIN=$(env_get BASE_DOMAIN)
    POOL_ROOT=$(env_get HOST_STORAGE_ROOT)
    POSTGRES_PORT=$(env_get POSTGRES_PORT)
    CONSOLE_DOMAIN=$(env_get CONSOLE_DOMAIN)
    CONTROL_PORT=$(env_get PORT)
    # `BASE_DOMAIN` 可能是**空值**（引导态：域名还没配），那和「.env 坏了、没这个键」是两回事，
    # 所以判的是**键在不在**，不是值非空。
    grep -q '^BASE_DOMAIN=' "$STATE_DIR/.env" ||
      die "已有 .env 里没有 BASE_DOMAIN 这一行。修好它，或删掉 $STATE_DIR/.env 重装。"
    # 域名以**本次给的那个**为准：从父域重新推控制台主机名，不要沿用 .env 里的旧值 ——
    # 「引导态 → 补配域名」（.env 里两项都是空）和「换父域」都会走到这里，沿用旧值的后果是
    # 只有 BASE_DOMAIN 变了、CONSOLE_DOMAIN 没跟着变，而 env 校验会因此**拒绝启动**。
    if [ -n "$DOMAIN" ]; then CONSOLE_DOMAIN="${CONSOLE_LABEL}.${DOMAIN}"; fi
    # 证书这档上次怎么选的，这次照旧；显式给了 --acme / --no-acme 就听参数的
    if [ "$ACME_SET" = 0 ]; then
      ACME=$(env_get INSTALL_ACME)
      ACME=${ACME:-1}
    fi
    if [ -z "$ACME_EMAIL" ]; then ACME_EMAIL=$(env_get INSTALL_ACME_EMAIL); fi
  fi

  preflight

  if [ "$first_time" = 1 ]; then
    domain_setup
    provision_pool
  else
    log "检测到已有安装（$STATE_DIR/.env）—— 按 **update** 走：保留数据与 secret"
    provision_pool
  fi

  # 邮箱**不再是硬要求**：不给照样签证书，只是收不到过期提醒（那提醒是续签失败时唯一的预警）。
  # 此刻两条路的值都已就位（首装问过 / 升级从 .env 读出），所以这一处就够了。
  if [ "$ACME" = 1 ] && [ -z "$ACME_EMAIL" ]; then
    warn "没给 ACME 邮箱：证书照签，但**收不到证书过期提醒** —— 续签失败时那就是唯一的预警。想补：加 --email 重跑，或在 $STATE_DIR/.env 里设 INSTALL_ACME_EMAIL。"
  fi

  fetch_assets
  write_env
  render_configs
  start_services

  # 记**两份**：人能读的标签，和不会漂移的 digest
  printf 'version=%s\ndigest=%s\n' "$VERSION" "$IMAGE_DIGEST" >"$STATE_DIR/.installed-version"
}

cmd_update() {
  CMD=update
  cmd_install
}

cmd_uninstall() {
  STEP='卸载'
  [ -f "$STATE_DIR/prod.yml" ] || die "没找到 $STATE_DIR/prod.yml —— 这里没装过？"
  log "停服务并删容器"
  compose down --remove-orphans || true
  if [ "$PURGE" = 1 ]; then
    warn "--purge：连 Postgres 卷、存储池、状态目录一起删，**不可恢复**"
    compose down -v --remove-orphans || true
    if [ -f "$STATE_DIR/.env" ]; then
      local root img
      root=$(env_get HOST_STORAGE_ROOT)
      if [ -n "$root" ]; then
        img="${root}.img"
        # 先 umount：池子还挂着的时候删 .img，等于把挂着的东西从底下抽掉
        umount "$root" 2>/dev/null || true
        rm -rf "$root"
        rm -f "$img"
        sed -i "\|^[^#]*[[:space:]]${root}[[:space:]]|d" /etc/fstab 2>/dev/null || true
      fi
    fi
    rm -rf "$STATE_DIR"
    log "清干净了。"
  else
    log "容器删了；**Postgres 卷与存储池保留**（数据还在）。"
    printf '  连数据一起删：install.sh uninstall --purge\n'
  fi
}

case "$CMD" in
  install) cmd_install ;;
  update) cmd_update ;;
  uninstall) cmd_uninstall ;;
esac
