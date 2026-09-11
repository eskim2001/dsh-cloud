# syntax=docker/dockerfile:1.7
#
# 实例容器基础镜像。
#
# 设计要点（见 docs/DECISIONS.md / docs/ARCHITECTURE.md §五）：
#   · 用户内容（含 workspace）全部落 /data 卷 —— 容器重建不丢
#   · rootfs 可写：dsh 是编码 agent，装依赖 / 装 CLI 是日常（D12）
#   · 全局包前缀指向 /data，升级也不丢
#   · 装 bubblewrap：dsh 的进程沙箱在 Linux 上先试它，缺了就拒绝执行任何命令
#   · tini 作 PID 1，回收 agent 派生的僵尸进程
#   · Caddy 用官方静态二进制，不走 apt（版本可控、构建快）

ARG NODE_IMAGE=node:24-trixie-slim
ARG CADDY_IMAGE=caddy:2.10-alpine
# DSH_VERSION / REVISION 没有默认值：唯一版本源是 docker/instance-image/VERSION，
# 由 build.sh 或 CI 传进来（tag = <DSH_VERSION>_<REVISION>，见 D22）。
ARG DSH_VERSION
ARG REVISION
ARG PNPM_VERSION=10.15.1
ARG INSTALL_TOOLCHAIN=1
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown

# ---- Caddy：官方静态二进制 ------------------------------------------------
FROM ${CADDY_IMAGE} AS caddy

# 剥掉官方二进制自带的 cap_net_bind_service：我们只绑 :8080（非特权端口），
# 不需要它；而容器跑 `CapDrop: ALL` 时 bounding set 里没有这个 cap，
# execve 会直接 EPERM（"caddy: Operation not permitted"），桥就起不来。
# `cp` 默认不保留扩展属性，复制一次即可，省掉装 libcap2-bin。
RUN cp /usr/bin/caddy /caddy

# ---- 安装阶段：带工具链，编译原生依赖 --------------------------------------
FROM ${NODE_IMAGE} AS installer

ARG DSH_VERSION
ARG REVISION
ARG PNPM_VERSION

# 缺参数就停：静默装一个过期 dsh（比 tag 说的版本旧）比构建失败糟得多。
RUN if [ -z "${DSH_VERSION}" ] || [ -z "${REVISION}" ]; then \
      echo "DSH_VERSION 和 REVISION 必须显式传入。" >&2; \
      echo "用 docker/instance-image/build.sh 构建，或传 --build-arg DSH_VERSION=<dsh版本> --build-arg REVISION=<修订号>。" >&2; \
      exit 1; \
    fi

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential \
      ca-certificates \
      python3 \
 && rm -rf /var/lib/apt/lists/* \
 && npm install --global --omit=dev --no-audit --no-fund \
      --allow-scripts=@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs \
      "@deepseek-ai/dsh@${DSH_VERSION}" \
      "pnpm@${PNPM_VERSION}" \
 && test "$(dsh --version)" = "${DSH_VERSION}" \
 && test "$(pnpm --version)" = "${PNPM_VERSION}" \
 && npm cache clean --force

# ---- 运行阶段 --------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime

ARG INSTALL_TOOLCHAIN
ARG DSH_VERSION
ARG REVISION
ARG GIT_SHA
ARG BUILD_TIME

# tag 给人看（<dsh版本>_<修订号>），label 给机器读：`docker inspect` 就能回答「这版里是哪个 dsh」。
LABEL org.opencontainers.image.title="dsh-instance" \
      org.opencontainers.image.description="DeepSeek Harness instance image: Node 24 + dsh + Caddy + tini" \
      org.opencontainers.image.version="${DSH_VERSION}_${REVISION}" \
      org.opencontainers.image.source="https://github.com/eskim2001/dsh-cloud" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.opencontainers.image.licenses="MIT" \
      io.dsh-cloud.dsh.version="${DSH_VERSION}" \
      io.dsh-cloud.image.revision="${REVISION}"

# git / curl 是 agent 的日常工具；ca-certificates 供 HTTPS。
# 编译器默认保留（INSTALL_TOOLCHAIN=1）—— 去掉它会让 npm 装原生依赖时
# 报出难以定位的错，省下的体积不值这个代价。要精简就传 --build-arg
# INSTALL_TOOLCHAIN=0。
#
# bubblewrap 是 dsh 在 Linux 上的首档进程沙箱：它的候选链是
# `bwrap → Landlock → fail closed`，两档全灭时 dsh 会拒绝执行**任何**命令。
# Docker Desktop 的内核没编 Landlock（`# CONFIG_SECURITY_LANDLOCK is not set`），
# 所以不装 bwrap 就等于每个实例都不能跑 bash。平台侧 `CapDrop: ALL` 下
# 非特权 user namespace 实测可用，bwrap 不需要提权；而 `no-new-privileges`
# 会忽略 setuid 位，留着只是多余攻击面 —— 剥掉（同 Caddy 那次）。
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bubblewrap \
      ca-certificates \
      curl \
      git \
      tini \
 && if [ "${INSTALL_TOOLCHAIN}" = "1" ]; then \
      apt-get install -y --no-install-recommends build-essential python3; \
    fi \
 && chmod u-s /usr/bin/bwrap \
 && rm -rf /var/lib/apt/lists/*

# 运行用户改名 node → dsh：base 镜像自带 uid/gid 1000 的 node，但实例里跑的是
# dsh，叫 node 会误导。**必须保留 uid/gid 1000** —— 宿主的实例卷和
# host-storage 的 DATA_UID 都按 1000 归属，改了号等于所有已有数据失主。
RUN usermod -l dsh -d /home/dsh -m node \
 && groupmod -n dsh node

COPY --from=caddy /caddy /usr/local/bin/caddy
# 同一 base image，整目录覆盖是安全的，且能带上 dsh / pnpm 的符号链接
COPY --from=installer /usr/local/lib/node_modules/ /usr/local/lib/node_modules/
COPY --from=installer /usr/local/bin/ /usr/local/bin/

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
COPY Caddyfile /etc/caddy/Caddyfile
# 平台侧 dsh 插件 + 它的 patch 覆盖层（D15，entrypoint 用 --patch 挂上）
COPY owns-host.mjs owns-host.yml /etc/platform/
RUN chmod 0755 /usr/local/bin/entrypoint.sh

ENV DSH_HOME=/data \
    HOME=/data/home \
    DSH_PORT=3080 \
    BRIDGE_PORT=8080 \
    NPM_CONFIG_PREFIX=/data/.npm-global \
    NPM_CONFIG_CACHE=/data/.npm \
    PNPM_HOME=/data/.pnpm \
    PNPM_STORE_DIR=/data/.pnpm-store \
    COREPACK_HOME=/data/.corepack \
    XDG_DATA_HOME=/data/.caddy/data \
    XDG_CONFIG_HOME=/data/.caddy/config \
    PATH=/data/.npm-global/bin:/data/.pnpm:/usr/local/bin:/usr/bin:/bin \
    NODE_ENV=production

# 这只管**镜像层**里的 /data。运行时 /data 是一整块数据卷（ext4）盖在上面，
# 所以这里的属主结果看不到 —— 真正生效的是 entrypoint 里那句 `mkdir -p`
# （它是以 root 跑的，见下面的 USER）。
RUN mkdir -p /data/home/workspace && chown -R dsh:dsh /data

VOLUME ["/data"]
# ⚠️ **必须是 `/data`，不能是 `/data/home/workspace`。**
# 运行时执行 ENTRYPOINT 时会 chdir 到镜像的 WORKDIR，而一块**全新的数据卷**里还没有
# 那层骨架 —— chdir 失败，ENTRYPOINT 一个进程都起不来（表现：实例状态 running，
# 但 guest 里连 tini 都没有，入口 502）。
# 旧模型下宿主目录里由平台预建了骨架，所以这个坑一直没露头。
# 骨架由 entrypoint 建出来，建完它自己 `cd` 进 workspace（见 entrypoint.sh）。
WORKDIR /data
# 平台侧由驱动 `.user('0')` 覆盖成 **root**：数据卷的根目录归 root，而 `.owner()`
# 这类声明式属主映射对磁盘卷无效，所以工作负载必须是 root 才写得进 /data。
# 保留 `dsh` 是为了直接 `docker run` 这个镜像时仍然是非特权的。
USER dsh

# tini 作 PID 1：agent 会大量 spawn 子进程，必须有东西回收僵尸
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
