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
| `/usr/local/bin/entrypoint.sh` | 子命令分发：`migrate` / `seed` / `domain` / `serve`（默认） |

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
docker run --rm --env-file /opt/dsh-cloud/.env ghcr.io/eskim2001/dshcloud:0.1.0 migrate
```

`serve` 起不来的常见原因不是镜像，是存储池：容器里**不建池**，`HOST_STORAGE_ROOT`
必须是宿主上已经挂好的 XFS + `pquota`（见下）。

## 改域名

域名存在平台的库里（`platform_setting` 那一行），装机**不写**环境变量。所以只有一个入口：

```bash
docker compose -f /opt/dsh-cloud/prod.yml run --rm control-plane domain example.com
```

它写库 → 重启控制面自己。新域名是**启动期**配置（会话 cookie 的 `Domain`、better-auth 的
baseURL 都在启动时按域名定死），所以必须重启；重启之后**旧域名上的会话会失效**，要在新域名下
重新登录。命令会先探一次泛解析，解不到只**警告**，不拦。

父域填错会怎样：控制面带着错的域名重启，那个域名解析不到 —— **界面进不去了**。但你能从 SSH 修：
把对的域名再跑一次这条命令。**这就是为什么改域名现在只开这个入口、没放进控制台** —— 界面上改，
写错的代价是把自己关在门外，而那时界面已经没了。

## 装机之后（引导态）

装机**不配域名、也不建账号**，所以控制面起来时是**引导态**：

1. 控制面**直接绑 `0.0.0.0`**，开在安装脚本挑的那个端口上（默认从 `3000` 起试 3000-3003），
   脚本最后打印的就是 `http://<机器>:<端口>/setup?token=…`。它另外还往 `dynamic/` 里写一条
   **catch-all router** 挂在 `:80` 上、指向自己 —— 那条留着，是给"防火墙只放行 80/443"的机器
   留第二条路。**没有** HTTP→HTTPS 跳转：跳转是配好域名之后才写出来的（静态那份写不了，
   见 [D36](../../docs/DECISIONS.md)）。
2. 那个口子上只有引导页、`/api/setup`（写）、`/api/setup/state`（读）与健康检查，凭证是安装
   脚本打印的**一次性 token**。其余接口**一条都不挂** —— 这份极小的注册面有测试盯着
   （`apps/server/src/http/route-surface.test.ts` 的引导态白名单）。
3. 填完**账号和域名**：**先建号**（走平台的建号入口，与邀请兑换同一条路）→ 再写库 →
   **删掉那条 catch-all（暴露当场关闭）** → 重启自己换身份，同时把那个端口收回成只听回环。
   cookie 域与 better-auth 的 baseURL 都是**启动期**配置，只能靠重启生效。

边界（都是有意的）：

- 引导期是**明文 HTTP、直接对公网**。为几分钟的窗口上 IP 证书不划算（LE 的 IP 证书 6 天有效，
  且 Traefik 对 IP 标识符的支持还不完整），所以用一次性 token 换掉那层风险。
- **也正因为是明文，引导页上填的管理员密码是明文过网的。** 装机的人就是用它的人，窗口只有
  几分钟，且页面只能从安装脚本打印的那条带 token 的链接进来 —— 这是明确接受的代价。
- **建号在落域名之前**：邮箱被占时回 409、什么都没写，换个邮箱重来即可。反过来会留下
  「域名配好了、却一个账号都没有」的死局，那个状态连界面都进不去。
- 配域名会让控制面**重启一次**（秒级；实例不受影响），此刻已登录的会话会因 cookie 域变化失效。
- 泛解析仍然要你自己配 —— 平台不碰 DNS API，引导页只检查一次并**警告**（不拦）。
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
