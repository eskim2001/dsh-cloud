# 本地验证栈

起 Traefik + 一个本地 DNS，用来跑通 M1 验收表里「经真实入口访问」的那几条（①–⑤）。

```bash
docker compose -f docker/compose/local.yml up -d
```

## 拓扑

```
浏览器 ── :443 ──> Traefik ──┬── Host(`app.dsh.test`)            → host.docker.internal:5173 (Vite 管理台)
                             └── Host(`<slug>.app.dsh.test`)     → forward-auth → http://dsh-instance-<slug>:8080 (实例桥)
```

TLS 也按生产那套走：`websecure`（:443）上挂 mkcert 签的本地证书，
`PUBLIC_SCHEME=https`、会话 cookie 带 `Secure`——和线上同构。

控制面在**宿主**上，实例容器在 Docker 里。Traefik 跑在容器里，所以摸宿主回环要经
`host.docker.internal`——**只有 forward-auth 那一跳**用得到它。实例后端走 Docker 网络：
控制面把 Traefik 接进每个实例网络（`TRAEFIK_CONTAINER=dsh-ingress`），按容器名直连，
实例容器因此**不发布任何宿主端口**（D3）。

## 一次性配置（要 sudo，只做一次）

让 macOS 把 `*.dsh.test` 的查询交给 compose 里的 DNS 容器：

```bash
sudo mkdir -p /etc/resolver && sudo sh -c 'printf "nameserver 127.0.0.1\n" > /etc/resolver/dsh.test'
```

验证：

```bash
dscacheutil -flushcache; ping -c1 app.dsh.test
```

应解析到 `127.0.0.1`。

再签一张本地 HTTPS 证书（`*.app.dsh.test`）：

```bash
brew install mkcert && mkcert -install
```

```bash
mkcert -cert-file docker/traefik/certs/dsh.test.pem -key-file docker/traefik/certs/dsh.test-key.pem "*.app.dsh.test" "app.dsh.test"
```

`mkcert -install` 要 sudo（写系统钥匙串），跑完浏览器才认这张证书；
没装 CA 的话证书链是断的，页面还是红锁。证书目录在 `.gitignore` 里，私钥不进仓库。

## 前提

1. 控制面在跑，且用 `apps/server/.env.local` 里的配置：

   ```bash
   pnpm --dir apps/server dev:local
   ```

   关键几项：`BASE_DOMAIN=app.dsh.test`、`PUBLIC_SCHEME=https`、
   `TRAEFIK_ENTRYPOINT=websecure`、`TRAEFIK_CERT_RESOLVER=`（空——本地用静态证书，
   线上才填 ACME resolver 名）、`TRAEFIK_CONTAINER=dsh-ingress`、
   `FORWARD_AUTH_ADDRESS=http://host.docker.internal:3000/auth/verify`。

2. 管理台在跑（浏览器访问 `https://app.dsh.test/`，不要用 `localhost:5173`——
   主机名不对，会话 cookie 落不到实例子域上）：

   ```bash
   pnpm --dir apps/web dev
   ```

3. 实例镜像已构建（`dsh-instance:0.1.0`）。

4. **改了 `BASE_DOMAIN` 之后要重建实例容器**：`DSH_TRUSTED_HOSTS` 是建容器时
   写进环境的，旧容器还认旧域名。走 `POST /api/instances/:id/restart` 或管理台的
   「重建」，卷不受影响。

5. **改了 `docker/traefik/dynamic-dev/` 下的文件要 `docker compose -f
   docker/compose/local.yml restart traefik`**：`platform.yml` / `tls.yml` 都是单文件
   bind mount，Docker Desktop 在容器创建时就把文件内容快照进 VM，之后宿主上的改动不会
   同步进去（表现为平台域名 404、容器里看到的是旧内容甚至被截断；`tls.yml` 改了没重启
   则是证书不生效）。实例路由不受影响——`routes.yml` 在目录挂载里，`watch: true` 会实时加载。

6. **入口容器被重建（`up -d` / `down` 后重起）要重启控制面**：Traefik 被接进每个
   实例网络（D3），重建后这些附着就没了，实例会 502。控制面启动对账时会把它们接回去
   （`attachIngress`），所以重启控制面即可。`restart traefik` 不重建容器，不受影响。

## 为什么是 `.dsh.test`

- **不能用 `.localhost`**：Chrome 把 `Domain=.localhost` 的会话 cookie 存成
  host-only（Cookie Store API 里 `domain: null`），不会发给 `u1t.localhost`，
  于是「在基域登录 → 打开实例」在浏览器里必然被打回登录页。服务端链路是好的，
  坏的只是浏览器存 cookie 的域。
- **不能用 `localtest.me` / `nip.io` 这类公共通配 DNS**：会被 Clash 的 fake-IP
  劫持到 `198.18.x.x`，浏览器根本到不了本地。
- `.dsh.test` 是 Chrome 认的可注册域，`Domain=.app.dsh.test` 的 cookie 作用域
  与线上的 `Domain=.app.example.com` 同构，且 `.test` 是保留 TLD，不会撞真实域名。

## 停

```bash
docker compose -f docker/compose/local.yml down
```
