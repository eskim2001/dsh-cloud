# 本地入口栈

用来跑通「经真实入口访问」：登录 → 打开实例。两个栈，入口能力不同：

| 文件 | 入口 | 用途 |
| --- | --- | --- |
| [quickstart.yml](quickstart.yml) | `:80`，明文 | clone 下来最快跑通，README「快速开始」用的就是这个 |
| [local.yml](local.yml) | `:443`，自签 TLS | 和服务端同构（`Secure` cookie、TLS 终结在入口），**验认证链路用这个** |

两者对控制面环境的要求只差 `PUBLIC_SCHEME` / `TRAEFIK_ENTRYPOINT`，下面各给一组。

## quickstart.yml（明文）

```bash
docker compose -f docker/compose/quickstart.yml up -d
```

控制面 `apps/server/.env.local`：

```dotenv
BASE_DOMAIN=lvh.me
CONSOLE_DOMAIN=console.lvh.me
PUBLIC_SCHEME=http
TRAEFIK_ENTRYPOINT=web
FORWARD_AUTH_ADDRESS=http://host.docker.internal:3000/auth/verify
TRAEFIK_ROUTES_PATH=./traefik-dynamic/routes.yml
```

浏览器访问 `http://console.lvh.me/`，不需要签任何证书。

## local.yml（自签 TLS）

```bash
docker compose -f docker/compose/local.yml up -d
```

## 拓扑

两个栈的主机规则相同，只有入口不同；下图以 local.yml 为例（quickstart 把 `:443` 换成 `:80`）：

```
浏览器 ── :443 ──> Traefik ──┬── Host(`console.lvh.me`)     → host.docker.internal:5173 (Vite 管理台)
                             └── Host(`<slug>.lvh.me`)      → forward-auth → http://dsh-instance-<slug>:8080 (实例桥)
```

local.yml 走生产那套：`websecure`（:443）挂静态证书，`PUBLIC_SCHEME=https`、会话 cookie 带
`Secure`——和线上同构。quickstart 走 `web`（:80）明文，cookie 不带 `Secure`，只适合本地。

控制面在**宿主**上，实例容器在 Docker 里。Traefik 跑在容器里，所以摸宿主回环要经
`host.docker.internal`——**只有 forward-auth 那一跳**用得到它。实例后端走 Docker 网络：
控制面把 Traefik 接进每个实例网络（`TRAEFIK_CONTAINER=dsh-ingress`），按容器名直连，
实例容器因此**不发布任何宿主端口**（D3）。

## 为什么是 `lvh.me`

`*.lvh.me` 是公共通配 DNS，全网解析到 `127.0.0.1`。于是：

- **不需要本地 DNS 容器**，也不用改 `/etc/resolver`；
- 不会和 Clash 之类占用 :53 的程序撞车（早先用 CoreDNS 容器 + `/etc/resolver` 的方案已删掉）。

控制台放在 `console.lvh.me`（`CONSOLE_DOMAIN`），实例是 `<slug>.lvh.me`（`BASE_DOMAIN=lvh.me`）。
**控制台必须是实例拿不到的 label**：两边同属一个注册域，如果控制台占用根域
（`lvh.me` 自己），实例命名空间就会把它包进去，租户能抢到同一个主机名。
见 [docs/DECISIONS.md](../../docs/DECISIONS.md) 的域名拆分 ADR。

不能用 `.localhost`：Chrome 把 `Domain=.localhost` 的会话 cookie 存成 host-only
（Cookie Store API 里 `domain: null`），不会发给 `u1t.localhost`，于是「在控制台登录 → 打开
实例」在浏览器里必然被打回登录页。服务端链路是好的，坏的只是浏览器存 cookie 的域。

## local.yml 一次性配置（quickstart 不需要）

### 1. 签一张自签证书

`docker/traefik/certs/` 在 `.gitignore` 里（私钥不进仓库），所以**新 clone 的机器上要先自己签**：

```bash
mkdir -p docker/traefik/certs
```

```bash
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 825 -keyout docker/traefik/certs/lvh.me-key.pem -out docker/traefik/certs/lvh.me.pem -subj "/CN=lvh.me" -addext "subjectAltName=DNS:lvh.me,DNS:*.lvh.me"
```

没有公共 CA 会给 `*.lvh.me` 签证书（域名不是我们的），所以只能自签——浏览器会红锁，
点「继续访问」即可。想消掉红锁就把这张自签证书（或它的 CA）装进系统信任库。

**重签后必须 `docker restart dsh-ingress`**：Traefik 不监听证书文件，只在启动 / 重载时读。

### 2. 控制面配置要和入口栈对齐

`apps/server/.env.local` 里这几项：

```dotenv
BASE_DOMAIN=lvh.me                                 # 父域：实例是 <slug>.lvh.me
CONSOLE_DOMAIN=console.lvh.me                      # 控制台自己的主机名
PUBLIC_SCHEME=https
TRAEFIK_ENTRYPOINT=websecure
TRAEFIK_CERT_RESOLVER=                              # 空——证书走 file provider 的静态证书
TRAEFIK_CONTAINER=dsh-ingress
FORWARD_AUTH_ADDRESS=http://host.docker.internal:3000/auth/verify
TRAEFIK_ROUTES_PATH=./traefik-dynamic/routes.yml    # 仓库内，compose 挂到 /etc/traefik/dynamic
```

## 起

三个终端，都在仓库根目录：

```bash
pnpm --dir apps/server dev:local
```

```bash
pnpm dev:web
```

```bash
docker compose -f docker/compose/quickstart.yml up -d   # 或 local.yml
```

浏览器访问 `http://console.lvh.me/`（local.yml 换成 `https://`；**不要用 `localhost:5173`**——主机名不对，会话 cookie
落不到实例子域上）。

实例镜像不用本地构建：管理台「镜像管理」页点「同步」→ 对某个版本「下载」→「发布」→「设为默认」，
新建实例时会自动拉取。只有改了 `docker/instance-image/` 才需要
`./docker/instance-image/build.sh`。

## 会踩的坑

1. **Clash 的 PAC 会拦 `lvh.me`**：`curl` 通、浏览器打不开就是它。Verge → 订阅页 → 卡片 → 编辑规则，
   加 `DOMAIN-SUFFIX,lvh.me,DIRECT`（全局 `profiles/Merge.yaml` 的 `prepend-rules` 自 v1.7.x 起
   不生效）。

2. **改了入口静态配置要重启入口容器**（local.yml 的 `docker/traefik/dynamic-dev/`、quickstart 的
   `docker/traefik/dynamic-quickstart/`）：`platform.yml` / `tls.yml` 都是
   单文件 bind mount，Docker Desktop 在容器创建时就把内容快照进 VM，之后宿主上的改动不会同步进去
   （表现为平台域名 404、容器里看到旧内容甚至被截断；`tls.yml` 改了没重启则是证书不生效）。

   ```bash
   docker restart dsh-ingress
   ```

   实例路由不受影响——`routes.yml` 在目录挂载里，`watch: true` 会实时加载。

3. **入口容器被重建（`up -d` / `down` 后重起）要重启控制面**：Traefik 被接进每个实例网络（D3），
   重建后这些附着就没了，实例会 502。控制面启动对账时会把它们接回去（`attachIngress`），
   所以重启控制面即可。`restart traefik` 不重建容器，不受影响。

4. **改了 `BASE_DOMAIN` 之后要重建实例容器**：`DSH_TRUSTED_HOSTS` 是建容器时写进环境的，
   旧容器还认旧域名。走 `POST /api/instances/:id/restart` 或管理台的「重建」，卷不受影响。

## 停

```bash
docker compose -f docker/compose/quickstart.yml down   # 或 local.yml
```
