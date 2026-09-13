# syntax=docker/dockerfile:1.7
#
# 平台镜像：控制面 + 管理台（**同源**，见 D32）。构建上下文是**仓库根**，
# 不是本目录 —— pnpm workspace 要整个仓库才装得起来。
#
#   builder：完整工具链，把 instance-spec / server / web 依次构建出来
#   runtime：只带运行时，另有 xfsprogs 与 util-linux —— 配额那条路要 shell 出它们
#
# 本地构建用 ./build.sh；正式发布走 .github/workflows/platform-image.yml。

# ── builder ────────────────────────────────────────────────────────────
FROM node:24-trixie AS builder

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable pnpm

WORKDIR /repo

# 先只拷 manifest 与 lockfile：改源码不该让依赖安装整个重来。
# workspace 成员的 package.json 缺一个，--frozen-lockfile 就会解析失败。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/instance-spec/package.json packages/instance-spec/
RUN pnpm install --frozen-lockfile

COPY . .

# 顺序是**依赖顺序**，不能并行：server 的运行时 import `@dsh-cloud/instance-spec`，
# 而那个包只有 dist 里有东西（main 指向 dist/index.js）；web 构建里有 tsc --noEmit。
RUN pnpm --filter @dsh-cloud/instance-spec build \
 && pnpm --filter @dsh-cloud/server build \
 && pnpm --filter @dsh-cloud/web build

# 自包含的运行时目录。--legacy 是必须的：pnpm v10 起，非 injected workspace
# 默认拒绝 deploy（ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE）。
# 这一步会把 node_modules/@dsh-cloud/instance-spec 换成**构建过的**那份（带 dist）。
RUN pnpm --filter @dsh-cloud/server deploy --prod --legacy /app/server

# ── runtime ────────────────────────────────────────────────────────────
FROM node:24-trixie-slim AS runtime

# xfsprogs：mkfs.xfs / xfs_quota　　util-linux：findmnt / losetup / mount
# —— instance/pool.ts 直接 shell 出这六个，缺一个配额就设不上（那是静默失败）。
# tini：控制面会 exec 子进程，得有 PID 1 收尸。
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini xfsprogs util-linux \
 && rm -rf /var/lib/apt/lists/*

# 控制面按**相对路径**读 ./drizzle（迁移目录）和 ./traefik-dynamic，工作目录必须钉死。
WORKDIR /app/server

COPY --from=builder /app/server /app/server
COPY --from=builder /repo/apps/web/dist /app/web
COPY --chmod=0755 docker/platform/entrypoint.sh /usr/local/bin/entrypoint.sh

# 部署资产随镜像走，安装脚本用 `docker cp` 把它们取到 /opt/dsh-cloud。
# **为什么放镜像里**而不是让安装脚本从 raw.githubusercontent 拉：
# ① 只有一份来源（仓库里这几个文件就是），不会和镜像版本错位；
# ② 安装时只需要连 GHCR，不需要再连第二个域名；
# ③ `docker cp` 直接从镜像文件系统读，不依赖镜像里有哪些命令。
COPY docker/compose/prod.yml /app/deploy/prod.yml
COPY docker/traefik/traefik.prod.yml.tmpl /app/deploy/traefik/traefik.yml.tmpl
# 动态那份（控制台 router / :80 跳转 / 引导口）**不随镜像走**：控制面是它的唯一写者，
# 每次启动按「配没配域名」自己写、自己删。见 src/instance/platform-routes.ts。

# WEB_DIST_DIR：控制面自己 serve 管理台。留空的话它会静默地什么都不 serve。
ENV NODE_ENV=production \
    WEB_DIST_DIR=/app/web

EXPOSE 3000

# ARG + LABEL 故意放最后，理由同实例镜像：GIT_SHA / BUILD_TIME 每次都变，
# 放前面会让它们之后的每一层缓存全部失效。
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
LABEL org.opencontainers.image.title="dsh-cloud" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_TIME}" \
      org.opencontainers.image.source="https://github.com/eskim2001/dsh-cloud"

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["serve"]
