# 平台镜像

控制面 + 管理台打成一个镜像：**一个容器**跑控制面，并由它**同源**提供管理台静态文件。
见 [D32](../../docs/DECISIONS.md)。

本地开发**不用**它（那边控制面是 `tsx` 直跑、管理台是 Vite dev server）。它只在安装场景出现：
安装脚本把它写进 `/opt/dsh-cloud/`，配 [prod.yml](../compose/prod.yml) 拉起。

## 构建

```bash
./docker/platform/build.sh
```

版本唯一源是旁边的 `VERSION`（平台**自己的**版本线，普通 semver，和实例镜像的
`<dsh版本>_<修订号>` 无关）。正式发布走 `.github/workflows/platform-image.yml`：
手动 dispatch，原生 runner 出 `linux/amd64` + `linux/arm64`，合成一个 tag。

**构建上下文是仓库根**（pnpm workspace 要整个仓库），脚本自己 `cd` 过去；`-f` 指向本目录的
Dockerfile。根目录的 `.dockerignore` 排掉了 `node_modules` / `**/dist` / `.git`，以及
**`apps/server/.env.local`** —— 那是 `pnpm dev` 生成的本地 secret，绝不能烙进镜像层。

## 镜像里有什么

| 路径 | 内容 |
|---|---|
| `/app/server` | 控制面：`dist/`（编译产物）、`drizzle/`（迁移）、`node_modules`（`pnpm deploy --prod`） |
| `/app/web` | 管理台静态文件（`WEB_DIST_DIR`，控制面自己 serve） |
| `/usr/local/bin/entrypoint.sh` | 子命令分发：`migrate` / `seed` / `serve`（默认） |

`apt` 装了 `xfsprogs` 与 `util-linux` 与 `tini`：`instance/pool.ts` 直接 shell 出
`xfs_quota` / `mkfs.xfs` / `losetup` / `findmnt` / `mount`，缺一个配额就设不上，而那是
**静默失败**。所以这不是"顺手装的工具"，是依赖。

实测体积（2026-09-13，本地 arm64 构建）：**734 MB**。拆开是基础层
`node:24-trixie-slim` 364 MB、`/app/server` 190 MB、apt 91 MB、管理台 9 MB。
其中 `/app/server` 偏大有个具体原因：pnpm v10 的 `deploy` 对非 injected workspace 只认
`--legacy`，而 legacy 实现会把**整个 workspace 的虚拟库**搬过来（180 MB，含 vitest、
drizzle-kit、web 的 native 依赖）。功能上无害（顶层链接是干净的，运行时用不到那些），
想瘦下来得改 `inject-workspace-packages`，那会动整个仓库的安装布局，另开一轮再说。

## 手工跑（排障用）

正常不用手工跑。要单独试镜像：

```bash
docker run --rm --env-file /opt/dsh-cloud/.env ghcr.io/eskim2001/dsh-cloud:0.1.0 migrate
```

`serve` 起不来的常见原因不是镜像，是存储池：容器里**不建池**，`HOST_STORAGE_ROOT`
必须是宿主上已经挂好的 XFS + `pquota`（见下）。

## 装的时候不给域名（引导态）

`install.sh` 的 `--domain` 是**可选**的。不给就是引导态：

1. 控制面照旧只听 `127.0.0.1:3000`（绑定一行没改）；它往 `dynamic/` 里写一条 **catch-all
   router** 挂在 `:80` 上、指向自己。**没有** HTTP→HTTPS 跳转 —— 跳转也是控制面在配好之后
   才写出来的（静态那份写不了，见 [D36](../../docs/DECISIONS.md)）。
2. 那个端口上只有 `/api/setup`（写）与 `/api/setup/state`（读）两条路，凭证是安装脚本打印的
   **一次性 token**。其余接口**一条都不挂** —— 这份极小的注册面有测试盯着
   （`apps/server/src/http/route-surface.test.ts` 的引导态白名单）。
3. 填完域名：写库 → **删掉那条 catch-all（暴露当场关闭）** → 重启自己换身份。cookie 域与
   better-auth 的 baseURL 都是**启动期**配置，只能靠重启生效。

边界（都是有意的）：

- 引导期是**明文 HTTP、直接对公网**。为几分钟的窗口上 IP 证书不划算（LE 的 IP 证书 6 天有效，
  且 Traefik 对 IP 标识符的支持还不完整），所以用一次性 token 换掉那层风险。
- 配域名会让控制面**重启一次**（秒级；实例不受影响），此刻已登录的会话会因 cookie 域变化失效。
- 泛解析仍然要你自己配 —— 平台不碰 DNS API，只在 setup 时检查一次并**警告**（不拦）。
- 那条 catch-all 只该在引导期存在。三个动态文件**每次启动按数据库状态幂等对齐**，所以即使
  上一轮半途挂了，也不会把明文入口留在 `:80` 上。

## 实例镜像要和平台同期

实例镜像里的 Caddy 负责把 dsh 的入口 token 注进去（在**无 cookie 的 `GET /`** 上，见 D14），
这条约定**平台与镜像是一起改的**。镜像落后时症状极具误导性：

> 登录 → 打开实例 → **401**，正文 `dsh web authentication required; reopen the URL printed by dsh web.`

看起来像平台坏了，其实只是那台机器上的实例镜像旧了。实测（2026-09-14）：一个 **2026-09-11**
构建的镜像（Caddyfile 还是旧的 `@open` 精确路径）配上 2026-09-12 之后的平台，正好是这个症状 ——
平台侧的门（403）、forward-auth 的 cookie 过滤、dsh 的 token 全都没问题，**唯一错的是镜像**。

升级时**平台和实例镜像一起升**；实例打不开先看它的版本：

```bash
docker image inspect ghcr.io/eskim2001/dsh-instance:<tag> \
  --format '{{index .Config.Labels "org.opencontainers.image.version"}}'
```

平台与镜像之间的完整契约（入口 token、cookie 名、门 header）在
[docker/instance-image/AGENTS.md](../instance-image/AGENTS.md) 顶部那张表。

## 两条要说明白的边界

1. **`cap_add: [SYS_ADMIN]` 叠加 `docker.sock` 等于宿主 root。** 这**不新增**信任面 ——
   `docker.sock` 本身就是那个权限。但别让"控制面跑在容器里"听起来像隔离：
   [ARCHITECTURE §五](../../docs/ARCHITECTURE.md) 那条禁令说的是**实例**，不是控制面。
   见 [D35](../../docs/DECISIONS.md)。

2. **池子由安装脚本在宿主上建，容器里不建。** 容器命名空间里 `mount` 出来的块设备，
   宿主和 Docker daemon 都看不见 —— 实例 bind 时会解析到空目录，而容器里的探针**还是成功的**。
   所以 `instance/pool.ts` 在 `DSH_CONTAINERIZED=1` 时，只要 `HOST_STORAGE_ROOT` 不是
   XFS + `pquota` 就**直接拒绝启动**，不尝试建池。
