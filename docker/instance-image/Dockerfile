# syntax=docker/dockerfile:1.7
ARG DSH_VERSION
ARG REVISION

FROM node:24-trixie

ARG DSH_VERSION
ARG REVISION

RUN : "${DSH_VERSION:?必须传 DSH_VERSION}" \
 && : "${REVISION:?必须传 REVISION}"

RUN apt-get update \
 && apt-get install -y --no-install-recommends bubblewrap tini \
 && chmod u-s /usr/bin/bwrap \
 && rm -rf /var/lib/apt/lists/*

RUN npm install --global --omit=dev --no-audit --no-fund \
      --ignore-scripts=false \
      "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force

RUN test "$(dsh --version)" = "${DSH_VERSION}" \
 && cd "$(npm root -g)/@deepseek-ai/dsh" \
 && node -e 'require("node-pty")' \
 && echo "自检通过"

RUN corepack enable pnpm

COPY --from=caddy:2.10-alpine /usr/bin/caddy /usr/local/bin/caddy

COPY --chmod=0755 entrypoint.sh /usr/local/bin/entrypoint.sh
COPY Caddyfile /etc/caddy/Caddyfile
COPY owns-host.mjs owns-host.yml /etc/platform/

# ARG + LABEL 故意放在这里，不要往上挪。
# BUILD_TIME / GIT_SHA 每次构建都不同，而 build arg 会作废缓存、且失效点之后的
# 指令全部重跑 —— 放文件开头的话，它们的 apt / npm install / 自检每一轮都要重来。
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.title="dsh-instance" \
      org.opencontainers.image.version="${DSH_VERSION}_${REVISION}" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.opencontainers.image.source="https://github.com/eskim2001/dsh-cloud"

ENV DSH_HOME=/data \
    HOME=/data/home \
    DSH_PORT=3080 \
    BRIDGE_PORT=8080 \
    NPM_CONFIG_PREFIX=/data/.npm-global \
    NPM_CONFIG_CACHE=/data/.npm \
    PNPM_HOME=/data/.pnpm \
    PNPM_STORE_DIR=/data/.pnpm-store \
    COREPACK_HOME=/data/.corepack \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    XDG_DATA_HOME=/data/.caddy/data \
    XDG_CONFIG_HOME=/data/.caddy/config \
    PATH=/data/.npm-global/bin:/data/.pnpm:/usr/local/bin:/usr/bin:/bin

VOLUME ["/data"]
WORKDIR /data
USER root
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
