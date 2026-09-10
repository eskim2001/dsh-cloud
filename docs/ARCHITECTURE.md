# 架构与安全模型

> 定稿：2026-09-08。本文是 `dsh-cloud` 的架构基准，改了要同步 [DECISIONS.md](DECISIONS.md)。

## 一、目标形态

```
                          互联网
                            │ 443
                            ▼
        ┌────────────────────────────────────────────┐
        │ Traefik （host 网络 · TLS *.app.example.com）│
        │  ① console.app.example.com → 平台管理面      │
        │  ② <slug>.app.example.com  → 实例 dsh        │
        │      ↳ forward-auth 中间件                   │
        │      ↳ 注入 X-Platform-Token                 │
        └──────┬─────────────────────────┬────────────┘
               │ 控制面地址               │ 被接进每个实例网络，
               │ （dev 经               │ 按容器名直连
               │ host.docker.internal）  │ http://dsh-instance-<slug>:8080
               ▼                         ▼
    ┌────────────────────┐    ┌──────────────────────────────┐
    │ 控制面              │    │ 实例容器 instance-<slug>        │
    │  web (React 管理台) │    │   独立 bridge 网络（可出网）  │
    │  server (Fastify)   │    │   caddy :8080 ──► dsh         │
    │  Postgres           │    │            127.0.0.1:3080     │
    │  control_net        │    │   卷 /data（workspace+会话+   │
    └─────────▲──────────┘    │        插件+配置）            │
              │ dockerode      │   配额 cpu/mem · 不发布端口  │
              └────────────────┴──────────────────────────────┘
```

**关键点**：实例容器**只**挂在自己的网络上，**不发布任何宿主端口**；入口（Traefik）被接进每个实例网络，按容器名直连桥。实例容器之间、实例容器到控制面，**网络层互不可达**。

> **为什么不是"只发布到宿主回环"**：Docker Desktop（macOS/Windows）会把宿主回环上发布的端口经魔法网关暴露给**所有**容器，跨实例因此可互达（见 [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) #4，已实测）。改法 A1 是干脆不发布；Linux 上绑 `127.0.0.1` 的发布 socket 只接受回环接口连接，所以那条路本来也通，但 Mac 上不通。**部署到 Linux 后仍要实测一次**（#8）。

## 二、四个角色

| 角色 | 职责 |
|---|---|
| **Traefik** | TLS 终结、按 Host 路由、**前置认证**（页面/API/WS 全覆盖）、注入签名 header |
| **控制面** | 认证（better-auth）、实例 CRUD、dockerode 编排、状态落 Postgres（**DB 记意图，对外状态查询时从 Docker 现算**，见 D16） |
| **实例容器** | caddy 桥（验 header）+ dsh 本体；用户内容全在 `/data` 卷 |
| **Postgres** | 用户 / 实例 / 归属关系 / 实例状态（意图，不是事实） |

## 三、两条请求链路

**管理面**：浏览器 → `console.app.example.com` → Traefik → 控制面 web / `/api`。普通会话认证。

**数据面（打开 dsh）**：

1. 浏览器 → `<slug>.app.example.com`
2. Traefik forward-auth → 调控制面 `/auth/verify`
   - 未登录 → 302 到登录页；登录者不是该实例的 owner → 403
   - 通过 → 注入 `X-Platform-Instance: <slug>` + `X-Platform-Token: HMAC(PLATFORM_SECRET, "dsh-cloud:gate:<slug>")`
3. Traefik 用 forward-auth 返回的 `Cookie` 替换原请求 cookie，过滤平台会话后转发到实例容器 `:8080`
4. caddy 校验签名：缺 / 错 → **403**；正确 → `127.0.0.1:3080`
5. WebSocket / SSE 同链路（forward-auth 对升级请求同样生效；需关缓冲、拉长超时）

## 四、隔离模型：跨实例不可达

**前提假设：实例容器 = 不可信代码执行环境。** dsh 的 agent 会 spawn 进程、跑 shell、写文件——这是它的本职工作。所有设计从"一个被攻陷或被滥用的实例"出发。

跨实例只有四条通道，逐条堵：

| 通道 | 堵法 |
|---|---|
| **网络** | 每实例一个独立 bridge 网络（Docker 默认互不可达，且都能出网）；容器**不发布任何宿主端口**；入口被接进每个实例网络，按容器名接入 |
| **文件** | 每实例独立文件系统（宿主稀疏文件 + loop + ext4）；按数据库中的 `storage_key` 定位，不能通过复用 slug 接管。删除时保留数据归属，详见[安全迁移](SECURITY-HARDENING.md) |
| **凭据** | 实例容器里零跨实例凭据：无 DB 凭据、无平台密钥、无 Docker socket、无全局共享 HMAC |
| **控制面** | 跨实例够不到；但注意 **Docker Desktop 上实例能经魔法网关摸到控制面 / Postgres 的宿主发布端口**（OPEN-QUESTIONS #4）——那一层靠各自的认证兜底，Linux 上预期摸不到 |

### 剩下的唯一缺口：内核

容器共享宿主内核，**逃逸即跨实例**。加固能把它从"配错就能逃"降到"需要内核 / runc 0day"，但消不掉。

- 加固清单见 §五
- 要消掉只有两条路：**microVM**（Kata / Firecracker）或 **gVisor**，或每实例独立节点
- 因此对客户能承诺的是：**「除内核漏洞外，跨实例不可达」**

**runtime 必须可插拔**：`packages/instance-spec` 的 renderer 是唯一接触 runtime 的地方，将来换 K8s / microVM 只换这一层。

## 五、容器加固清单

| 项 | 值 |
|---|---|
| 用户 | 非 root（`node`） |
| 权限 | `no-new-privileges`；drop 全部 capabilities |
| rootfs | **可写**（D12：dsh 是编码 agent，装依赖是日常）；只读是可选加固 |
| PID 1 | 镜像里的 tini（agent 会大量 spawn 子进程，必须回收僵尸） |
| 命名空间 | 不共享 PID / IPC / UTS |
| pids | `--pids-limit`（防 fork bomb） |
| 配额 | `--memory` / `--cpus`；**磁盘 = 数据文件系统大小**（D18，内核硬限） |
| 网络 | 独立 bridge；**绝不用** `--privileged` / `--network host` |
| 入口 | **不发布任何宿主端口**；入口容器被接进实例网络，按容器名接入 |

**镜像不变量**：容器跑 `CapDrop: ALL`，因此镜像里**任何带 file capabilities 的二进制都会 execve 失败**（bounding set 里没有那个 cap → `Operation not permitted`）。caddy 自带的 `cap_net_bind_service` 已在构建时用 `cp` 复制一次剥掉（`cp` 不保留扩展属性；我们只绑 :8080）。以后往镜像里加二进制（`ping`、带 `setcap` 的包）要留意同一件事。

**唯一例外的特权面：宿主存储助手容器**（D18）。实例的数据文件系统要在**宿主**上创建 / 挂载 / 扩容，控制面因此会起一个短命的 `docker run --rm --privileged --pid=host <固定镜像> nsenter -t 1 -m …` 来执行这几条命令。约束：① 镜像固定（不是实例镜像，不含用户内容）；② 脚本是平台侧写死的白名单，**零用户输入拼接**；③ 只在控制面进程内调用，实例容器够不到；④ 命令只碰 `<HOST_STORAGE_ROOT>/<slug>`，slug 已按白名单正则校验。**实例容器本身仍然不特权、不挂 Docker socket。**

## 六、非运行时的跨实例通道（最容易被漏）

真正的跨实例事故往往不出在运行时，而出在这些地方——每一处都必须带实例维度：

- **备份 / 迁移 / 快照恢复脚本**按实例 ID 拼路径
- **控制面的查询**漏 `WHERE instance_id = ?`
- **日志 / 指标聚合**把多租户数据混在一个面板
- **升级脚本**用通配符扫卷

## 七、Web 侧的一个陷阱：会话 cookie 作用域

控制台在 `console.app.example.com`（`CONSOLE_DOMAIN`），数据面在 `<slug>.app.example.com`（`BASE_DOMAIN=app.example.com`）。forward-auth 要读 cookie 才能认证子域请求 → cookie 必须覆盖父域（`Domain=.<BASE_DOMAIN>`）→ **但实例子域上跑的是 agent 生成的页面**，它天然能对控制面 API 发带凭据的请求。

**已实现**（[`apps/server/src/auth.ts`](../apps/server/src/auth.ts)）：cookie 属性 `HttpOnly` + `Secure`（https 时）+ `SameSite=Lax`，`Domain=.<BASE_DOMAIN>`（**父域**，同时覆盖控制台和实例）；better-auth 校验 `trustedOrigins`（只信 `CONSOLE_DOMAIN` 的 origin，实例子域不在其中）。

`SameSite=Lax` 不阻止实例子域发出的同站跨源请求。控制面现在统一检查写请求的 `Origin`：只允许平台自身来源和显式配置的精确受信来源，缺失或不匹配一律 403。该检查覆盖认证接口及无请求体的生命周期操作，不依赖 CORS 阻止响应读取。

`HttpOnly` 也不能阻止实例后端读取请求 cookie。因此可信入口在认证后过滤平台 cookie，实例只收到自己的 cookie。原生账号管理接口关闭、默认管理员不再具有账号接管权限，平台拒绝既存冒充会话。实现与验证见[安全修复与迁移](SECURITY-HARDENING.md)。

## 八、待验证

见 [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)。WebSocket 握手授权与 cookie 过滤已通过真实 Traefik 集成测试，控制面跨源写请求拒绝已有回归测试。目标宿主网络隔离、DNS/TLS 配置、完整浏览器链路和长连接撤权仍需部署环境验证。
