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

**前提假设：实例 = 不可信代码执行环境。** dsh 的 agent 会 spawn 进程、跑 shell、写文件——这是它的本职工作。所有设计从"一个被攻陷或被滥用的实例"出发。

**内核缺口已闭合**（D31）：实例跑在 **microVM** 里（每实例一台，独立内核），不再是共享宿主内核的容器。所以「逃逸即跨实例」那条不再成立——逃逸要先破 hypervisor。

跨实例只有四条通道，逐条堵：

| 通道 | 堵法 |
|---|---|
| **网络** | 每台 VM 自带独立 NAT，guest IP 彼此相同（互指自己）；实例只把端口发布到**宿主回环** `127.0.0.1`。实测跨实例的网关转发 / 对端 IP / 机器名 / 宿主回环**全部不通**（对照：自己的端口通）。⚠️ 这条**依附于运行时**，换运行时必须重验，不能继承（D31） |
| **文件** | 每实例独立数据目录，按 `storage_key` 定位，不能靠复用 slug 接管。`:staged` 复制进 VM，回传靠周期 sync / 优雅停机。删除时保留归属，详见[安全迁移](SECURITY-HARDENING.md) |
| **凭据** | 实例里零跨实例凭据：无 DB 凭据、无平台密钥、无运行时 socket、无全局共享 HMAC |
| **控制面** | 跨实例够不到。入口（Traefik）经**宿主回环端口**转发；日志 / 用量等观测全部来自平台侧 |

**残余风险**（换了运行时也继续认）：

- 实例**能出网**，且 **macOS 上拿不到 egress 限制**（smolvm 源码级拒绝，只有 Linux + firecracker 才有）
  ——「限制实例能访问什么」这条在 macOS 上无解
- `:staged` 的写入有**不落盘窗口**：异常掉电会丢最近一段（四层兜底见 D31）
- 健康判定**不能只信运行时的自报状态**：实测运行时会用空转容器顶替崩溃的工作负载，而状态照样报
  running。真正的死活走 `InstanceOrchestrator.probeHealthy`（真连入口端口）
- 宿主上的数据目录**没有磁盘配额**——配额由 VM 的可写数据盘（`--storage`）承载；
  宿主目录本身只受宿主盘限制

**运行时接缝**：[`apps/server/src/runtime/driver.ts`](../apps/server/src/runtime/driver.ts) 是**唯一**
接触具体运行时的接口；业务层（`provisioner` / `boot` / `reconciler` / `routes-sync`）不认识任何具体运行时。
`packages/instance-spec` 只做**纯描述**（把规格渲染成中立的机器定义，零 I/O）。

## 五、实例加固清单

> **换运行时后这张表变了大半**（D31）：容器时代靠 Docker 参数换来的加固，现在大部分由
> **hypervisor + 独立内核**直接给出，不再需要配置。左列是旧清单，右列是现在由谁负责。

| 项 | 现在由谁负责 |
|---|---|
| 用户 | **仍要**：工作负载以**数据目录的属主**运行（不是 root）。镜像里那个 uid 1000 的用户还在，但运行 uid 由平台按数据目录属主传（D31） |
| 权限 / capabilities | **hypervisor**：不再共享宿主内核，`CapDrop:ALL` 这类参数无处可施、也不再必要 |
| 路径屏蔽 | **hypervisor**：独立内核 + 独立 rootfs，看不到宿主 `/proc`、`/sys`。D30 那套是为绕开 Docker 默认屏蔽而加的，随之退场 |
| rootfs | **仍要可写**（D12：dsh 是编码 agent，装依赖是日常）——对应 VM 的 `--overlay` 层 |
| PID 1 | **仍要**：镜像里的 tini（agent 大量 spawn 子进程，必须收僵尸） |
| 命名空间 | **hypervisor**：整台 VM 就是边界 |
| pids 限制 | **无处落地** —— smolvm 没有对应参数（D31 代价⑤）。这是相对容器时代的**净退步** |
| 配额 | 内存 `--mem`、CPU `--cpus`（都是**上限而非预留**）；磁盘 `--storage` 是硬上限，超了 guest 拿 ENOSPC、**宿主不受影响** |
| 网络 | 每台 VM 独立 NAT；只发布到**宿主回环** |
| `--privileged` / host 网络 | 概念不存在：没有容器守护进程可以提权到 |

**不随运行时变的**：

- 镜像里 **dsh 自己的进程沙箱**（bubblewrap）照旧 —— 它管的是**实例内部**的进程隔离，
  与跨实例边界是两件事（D28 的立场不变：平台不替用户选沙箱模式）
- **入口的门**照旧：forward-auth（D8）+ 实例内 Caddy 的 header 校验（纵深防御第二层）
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

## 八、权限边界与运行限制

**角色边界。** 实例所有者和平台管理员是两条线：

| 角色 | 能碰 | 碰不到 |
|---|---|---|
| **实例所有者** | 自己的 dsh、workspace、用量指标、日志 | 他人的实例 —— 登录了平台不等于能开别人的实例 |
| **平台管理员** | 用户 / 配额 / 镜像版本，实例状态与容器日志 | 平台**没有**读取或浏览用户 `/data` 内容的界面，实例入口也**没有**绕过所有者校验的通道 |

- **用量可见性**：实时 CPU / 内存 / 磁盘用量和历史指标只对所有者开放；管理台展示的是**配额**，不是他人的实时用量 —— 两者不能混为一谈。
- **日志不是私有存储**：容器输出可能含用户内容或密钥，管理员能看日志不代表日志干净。
- **宿主是另一层信任边界**：有宿主或 Docker 权限的人能访问底层存储，应用层限制不等于对宿主运营者加密 —— 这也是平台密钥 / 数据库凭据 / Docker socket 一律不进实例容器的原因（§四）。

**运行限制。** 以下是刻意选的边界，不是待补的漏：

- **磁盘配额限的是 `/data` 文件系统**（§五），不是宿主全部存储；容器可写层、日志、升级快照要另行规划宿主容量。
- **镜像切换需要停机。** 回滚会同时恢复旧镜像和升级前的数据快照，**丢弃快照之后的数据变化**；每实例只保留一份升级前快照，不能替代独立备份。
- **删除实例而不清数据**会保留数据及其归属记录；复用子域名创建的是独立文件系统，恢复旧数据要运营人员核验，不会按名称自动接回（§四 文件）。
- **当前未包含**：计费、独立备份、完整可观测性栈、多节点运行时。状态对账与用量采样不能替代它们，推迟计划见 [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) §二。

## 九、待验证

见 [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)。WebSocket 握手授权与 cookie 过滤已通过真实 Traefik 集成测试，控制面跨源写请求拒绝已有回归测试。目标宿主网络隔离、DNS/TLS 配置、完整浏览器链路和长连接撤权仍需部署环境验证。
