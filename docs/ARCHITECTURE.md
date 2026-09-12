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
               │ 控制面地址               │ 宿主回环端口
               │ （dev 经               │ 127.0.0.1:<hostPort>
               │ host.docker.internal）  │ （容器内 caddy :8080 发布）
               ▼                         ▼
    ┌────────────────────┐    ┌──────────────────────────────┐
    │ 控制面              │    │ 实例容器 dsh-instance-<slug>   │
    │  web (React 管理台) │    │   Docker 默认 bridge（可出网） │
    │  server (Fastify)   │    │   caddy :8080 ──► dsh         │
    │  Postgres           │    │            127.0.0.1:3080     │
    │  control_net        │    │   卷 /data（workspace+会话+   │
    └─────────▲──────────┘    │        插件+配置）            │
              │ dockerode      │   cpu/mem 有上限 · 磁盘有硬限  │
              └────────────────┴──────────────────────────────┘
```

**关键点**：实例容器把桥端口（`:8080`）**只发布到宿主回环** `127.0.0.1:<hostPort>`（端口由平台从 20000–31999 分配）；入口（Traefik 跑在容器里）经 `host.docker.internal:<hostPort>` 转发进来。**Linux 上这就是有效的网络隔离** —— 容器够不到宿主回环上的监听、也够不到**别的容器**发布的回环端口（2026-09-12 实测：全部 `ECONNREFUSED`，见 [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) #4）。

> ⚠️ **Docker Desktop（macOS/Windows）上不是**：它的 `host.docker.internal` 是**代理到宿主 localhost** 的别名，于是宿主回环上的**任何**监听（实例端口、控制面 API、Postgres）对所有容器开放。这是**开发机特有**，生产 Linux 不受影响。跨实例那条最后仍有**每实例门 token** 兜底 —— 但拦住它的是门，不是网络。

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

**⚠️ 内核是共享的**：实例跑在 **Docker 容器**里，与宿主共享内核。所以「逃逸即跨实例」这条**重新成立**，
而且比 microVM 时代更重 —— 容器逃逸直接就是**宿主失陷**，不只是串到别的实例。这是选 Docker 时接受的代价。

跨实例只有四条通道，逐条堵：

| 通道 | 堵法 |
|---|---|
| **网络** | 实例的桥端口只发布到**宿主回环** `127.0.0.1`，不对局域网暴露。⚠️ 但**回环不等于隔离**：同 daemon 的容器可以经 `host.docker.internal` 够到宿主的回环端口（macOS / Docker Desktop 实测如此；Linux 宿主待验）。所以**跨实例真正的闸门是每实例的门 token** —— `HMAC(secret, "dsh-cloud:gate:<slug>")`，见 `instance/gate-token.ts`：A 拿自己的 token 打 B 会被 403。拦住的**是门，不是网络不可达** |
| **文件** | 每实例一份**独立的数据目录** —— 池子里的 `<pool>/<key>`，带自己的 project quota（配额落不了地的宿主上退回命名卷，见下），按 `storage_key` 定位，不能靠复用 slug 接管。删容器不删数据 → 重建不丢数据 |
| **凭据** | 实例里零跨实例凭据：无 DB 凭据、无平台密钥、无 Docker socket、无全局共享 HMAC |
| **控制面** | 入口（Traefik）经**宿主回环端口**转发；日志 / 用量等观测全部来自平台侧 |

**残余风险**（换了运行时也继续认）：

- 实例**能出网**，且**没有 egress 限制**：Docker 不提供出网过滤，要做只能靠宿主侧（Linux 的 iptables / nftables）；
  macOS 的 Docker Desktop 上无解
- 健康判定**不能只信容器的自报状态**：容器 `running` 不等于工作负载在服务（启动窗口期，或 entrypoint 里
  dsh / caddy 已经崩了但容器还没退）。真正的死活走 `InstanceOrchestrator.probeHealthy`（**真连入口端口**）
- **磁盘配额：Linux 上是硬限，开发机只警告**：实例数据落在一块以 `pquota` 挂载的 XFS 池上，每实例一个
  project quota（**字节 + inode 双限**）—— 池子灌满时租户拿到 `ENOSPC`，写不穿到宿主盘。
  **开发机（macOS / Docker Desktop）做不到**：它的 linuxkit 内核把配额整块裁了
  （`CONFIG_XFS_QUOTA` 未设、`QFMT_V1`/`QFMT_V2` 未设），`mount -o pquota` / `-o usrquota` 一律 EINVAL
  → 那里退回命名卷、**不强制**，界面上的「配额」一律标成「无上限」。
  安全代价要说清：**池化把"物理隔离"换成了"逻辑隔离"** —— 全靠配额设对，而设配额是特权操作、失败是静默的，
  所以启动有一条自检，设不上就**拒绝启动**。见 [storage/README.md](storage/README.md)、D18、
  [RUNTIME-CONTAINER-EVAL](RUNTIME-CONTAINER-EVAL.md)
- **宿主回环上的「无门」服务对容器可见**（macOS / Docker Desktop 实测）：控制面 API 与 Postgres 都只听宿主
  回环、且没有门，开发机上一个租户容器能直连它们。生产宿主是 Linux 时这条是否成立**待验** —— Linux 上
  `host-gateway` 指向网桥网关，够不到绑 `127.0.0.1` 的 socket

**运行时接缝**：[`apps/server/src/runtime/driver.ts`](../apps/server/src/runtime/driver.ts) 是**唯一**
接触具体运行时的接口；业务层（`provisioner` / `boot` / `reconciler` / `routes-sync`）不认识任何具体运行时。
`packages/instance-spec` 只做**纯描述**（把规格渲染成中立的机器定义，零 I/O）。

## 五、实例加固清单

> 实例是 Docker 容器，加固靠 **Docker 参数 + 镜像本身**。下面是逐项现状 —— ⚠️ 标出来的几条是
> **该做而没做**（不是"无所谓"）。

| 项 | 现状 |
|---|---|
| 用户 | 工作负载跑 **root**（渲染器固定 `user: '0'`）—— 命名卷的根归 root，容器内没法降权 |
| rootfs | **可写**（D12：dsh 是编码 agent，装依赖是日常） |
| PID 1 | 镜像里的 **tini**（agent 大量 spawn 子进程，必须收僵尸） |
| 命名空间 / 内核 | **Docker 默认**：进程 / 挂载 / 网络命名空间独立，但**共享宿主内核**（逃逸即宿主失陷） |
| capabilities | ⚠️ **没有 drop** —— 用 Docker 默认能力集（含 CHOWN / DAC_OVERRIDE / SETUID 等，不含 SYS_ADMIN） |
| pids 限制 | `HostConfig.PidsLimit = spec.quota.pidsLimit`（默认 512）—— 2026-09-13 才真正接上：此前 schema 里有这个字段、界面上也能调，但驱动没往下带，**改了不生效** |
| 内存 / CPU | `HostConfig.Memory` / `NanoCpus`（上限而非预留） |
| `no-new-privileges` / seccomp | ⚠️ **没做**（Docker 默认 seccomp profile 生效，但没有额外收紧） |
| 网络 | 桥端口**只发布到宿主回环**；Linux 上容器够不到它（[OPEN-QUESTIONS #4](OPEN-QUESTIONS.md) 实测） |
| `--privileged` | **没用**，也不该用（那等于宿主 root） |

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

- **用量可见性**：实时 CPU / 内存用量和历史指标只对所有者开放。管理台看得到**配额与已用磁盘字节数** ——
  舰队页的价值就是"一眼看出谁快写满"，看不到字节数就无从告警；但看不到 CPU / 内存的实时值，
  更看不到 `/data` 里有什么（那是隔离边界，不是权限问题）。
- **日志不是私有存储**：容器输出可能含用户内容或密钥，管理员能看日志不代表日志干净。
- **宿主是另一层信任边界**：有宿主或 Docker 权限的人能访问底层存储，应用层限制不等于对宿主运营者加密 —— 这也是平台密钥 / 数据库凭据 / Docker socket 一律不进实例容器的原因（§四）。

**运行限制。** 以下是刻意选的边界，不是待补的漏：

- **磁盘有硬限（Linux 宿主）**：实例数据落在一块以 `pquota` 挂载的 XFS 池上，每实例一个 project quota
  （**字节 + inode 双限**），`diskMb` 就是那个硬限 —— 写满之后是**写不进去**（`ENOSPC`），不是"把宿主盘写满"。
  **开发机（macOS / Docker Desktop）没有等价的内核支持**：那里退回命名卷、不强制配额，界面上的「配额」
  一律标成「无上限」（见 [storage/README.md](storage/README.md) 与 D18）。容器可写层、日志、升级快照
  仍**不在 `diskMb` 里**（升级快照拿的是独立 project ID，吃宿主真实空间），它们的容量要另行规划。
- **镜像切换需要停机。** 回滚会同时恢复旧镜像和升级前的数据快照，**丢弃快照之后的数据变化**；每实例只保留一份升级前快照，不能替代独立备份。
- **删除实例而不清数据**会保留数据及其归属记录；复用子域名创建的是独立文件系统，恢复旧数据要运营人员核验，不会按名称自动接回（§四 文件）。
- **当前未包含**：计费、独立备份、完整可观测性栈、多节点运行时。状态对账与用量采样不能替代它们，推迟计划见 [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md) §二。

## 九、待验证

见 [OPEN-QUESTIONS.md](OPEN-QUESTIONS.md)。WebSocket 握手授权与 cookie 过滤已通过真实 Traefik 集成测试，控制面跨源写请求拒绝已有回归测试。目标宿主网络隔离、DNS/TLS 配置、完整浏览器链路和长连接撤权仍需部署环境验证。
