# 待验证 / 待定

> 这些不是「难点」，是**信息缺口**。验完就把结论搬进 [DECISIONS.md](DECISIONS.md)，条目从这里删掉。
> 已解决的条目压缩在 §三（存档），保留证据、不保留过程。

## 一、未决（影响架构）

| # | 问题 | 怎么验 | 不验会怎样 |
|---|---|---|---|
| 6 | **DNS provider** 选型（Cloudflare / 阿里云 / Route53） | 定下来 + 实测通配证书签发 | 通配证书走 DNS-01，决定 Traefik 配置与实例子域解析 |
| 13 | **门改 host-only cookie + 控制台签发短时 token**（解同注册域的 Set-Cookie 投毒 / 浏览器状态继承） | 设计 token 交换链路 + 真实浏览器双租户复现 | 同注册域下浏览器状态仍是跨租户通道（D24 代价⑤） |

### #6

只是选型，不影响已实现的隔离模型。

### #13

控制台和实例共享注册域，所以实例响应能给浏览器种一枚 `Domain=<BASE_DOMAIN>` 的 cookie；
Traefik 的 `headers` 中间件只能整条删 `Set-Cookie`，做不到按 `Domain` 过滤（会连 dsh 自己的会话
cookie 一起删）。结构解是**把门改成 host-only cookie**：forward-auth 不再读浏览器直发的会话
cookie，而是由控制台签一枚**短时、单实例、绑定 owner** 的 token，经一次性交换落到实例子域。
它会动认证链路（会话、CSRF、WebSocket 握手都要重新过一遍），所以另开一轮，不夹在 D24 里做。

## 二、已知但故意推迟的

| 项 | 推迟到 |
|---|---|
| 可观测性（Prometheus / Loki / Grafana） | M2 |
| 备份 / 镜像扫描 / 对象存储 | M2 |
| 插件信任边界（恶意插件） | M2 |
| 出网控制（agent 任意出网） | M2 |
| 商品化（注册 / 计费 / 用量判定） | M3 |

## 三、已解决（存档）

### #8 部署环境：microVM → **已改回 Docker**（D31 作废）

运行时一度从 Podman/Docker 换成 smolvm microVM（D31），后来又**改回 Docker** —— 见 D31 顶部的作废说明与
[ARCHITECTURE §四](ARCHITECTURE.md)。

D31 里那条「这条结论**依附于运行时**，换运行时必须重验」因此**再次生效，且尚未重跑**：

- microVM 时代实测的「跨实例网关 / 对端 IP / 机器名 / 宿主回环**全部不通**」**不能继承**到 Docker
- **macOS / Docker Desktop 上已实测到相反结果**：容器可经 `host.docker.internal` 够到宿主回环上的**任何**监听 ——
  别人的实例桥端口、控制面 API、Postgres 都在其中。跨实例现在靠**每实例门 token** 拦住（拿自己的 token 打别人 → 403）
- **待办**：在生产宿主形态（Linux）上重跑同一组探针，看这条暴露面是否成立

代价与残余风险（egress 无解、卷无配额等）写在 [ARCHITECTURE §四](ARCHITECTURE.md)。

### #3 / #12 WebSocket 握手与跨源写操作

真实 Traefik 集成测试验证了未登录握手返回 302、非所有者返回 403、所有者返回 101，且平台 cookie 不传给实例后端。控制面写请求现在要求精确受信 `Origin`，实例子域、缺失来源和 `null` 来源均被拒绝。回归命令及迁移注意事项见[安全修复与迁移](SECURITY-HARDENING.md)。这不代表已验证所有浏览器行为或长连接建立后的实时撤权。

### #1 / #2 客户端 `isLoopback` 与 `--trusted-host` → **D15**

`--trusted-host` 只放宽服务端 `/api` 的 Host/Origin 围栏（它自己的 help 写明 "not an auth layer"），**解不开客户端**门：`isLoopback` 由浏览器里的 `location.hostname` 算，代理改不了。远程域名下它的后果是**终态**而非降级——设置面 `persistence = 'memory'`、`settings-mirror` 永不发起读取，模型提供方页面直接报 `settings are unavailable in this browser`，**连 API key 都填不了**。

社区做法是「服务端 + 客户端两处一起解锁」（改 bundle 或打补丁）。我们的做法见 [D15](DECISIONS.md)：走官方 `--patch` 扩展点注入 `__DSH_TRANSPORT__ = { ownsHost: true }`，**不改官方文件**。服务端侧实测只需 `--trusted-host`（2026-09-09，0.1.2-rc.1：`settings/describe`、`settings/mutate`、`credentials/set → describe → unset` 全部到达 handler 并成功）。

### #4 宿主回环对容器可见 → **D3**

Docker Desktop（macOS/Windows）会把宿主回环上发布的端口经魔法网关暴露给**所有**容器（`host.docker.internal` 直连 IP，改 hosts 挡不住）。本机实测：**不成立**。

改法 A1：实例容器**不发布任何宿主端口**，入口被接进每个实例网络、按容器名直连。改后实测（从实例容器内发起）跨实例全部路径——容器名 / 容器 IP / 网关旧端口 / `192.168.65.x`——**全部阻断**。

A1 不解决、但也不是跨实例问题的：经 `host.docker.internal` 仍能摸到宿主回环上**平台自己**的服务（控制面、Traefik、Postgres）。Linux 上绑 `127.0.0.1` 的发布 socket 只接受回环接口连接 → 预期摸不到，**部署到 Linux 后第一件事实测**（#8）。

### #5 workspace 根 → **铁律 1**

`dsh` 的 workspace 由 `HOME` / `WORKDIR` 决定。实例镜像里 `HOME=/data/home`、`WORKDIR=/data/home/workspace`，都在 `/data` 卷下，容器重建不丢。

### #7 磁盘配额 → **D18**

Linux 上做磁盘配额只有四条路：文件系统级三条 + 块设备级一条。编排器（Docker / Nomad / k3s）都只是**转手**，换编排器不解决这个问题（K8s 的 `ephemeral-storage` 限额本身就是用 XFS/ext4 project quota 实现的）。

| 路径 | 硬限 | 开发机可测 | 生产要求 |
|---|---|---|---|
| XFS project quota | ✓ | ✗ | 部署前定 XFS + `pquota` |
| ext4 project quota | ✓（可被 `CAP_SYS_RESOURCE` 绕过） | ✗ | ext4 + `prjquota` |
| btrfs qgroup / squota | ✓ | ✓ 实测通过 | 一块 btrfs 盘 + 每实例一个子卷；内核 ≥ 6.7 |
| 独立块设备（loop / LVM / 云盘） | ✓ | ✓ | 每实例一块盘 / 一个 LV，密度高时运维成本爆 |

开发机实测（macOS + Docker Desktop，LinuxKit 6.10.14）：XFS + `prjquota` → `quota support not available in this kernel`；ext4 + `prjquota` → 内核没编 `CONFIG_QUOTA`；btrfs squota → ✓（`mkfs.btrfs -O squota` → `qgroup limit 10M` → dd 停在 9.89 MiB）。即 **Docker Desktop 内核没编 quota 子系统**。

被排除的思路：Docker `--storage-opt size=`（只限容器可写层，管不到 volume，且本机被静默忽略）；`--ulimit fsize=`（只限单文件）；JuiceFS / CephFS 目录配额（最终一致，要引元数据服务）；软配额（会超，是计费手段不是隔离）。

**最终选第五种形态**：每实例一个宿主稀疏文件 + loop + ext4，**文件系统大小即配额**，宿主级操作走特权助手容器。只依赖宿主自带工具，开发机端到端可验。见 [D18](DECISIONS.md)。

### #9 / #10 / #11 数据模型 / 实例标识 / runtime 抽象 → **已实现**

用户 ↔ 实例 ↔ 角色落在 `apps/server/src/db/schema.ts`；slug 到容器名 / 网络名 / 存储路径的映射由平台按白名单正则生成；runtime 抽象收口在 `packages/instance-spec`（换 K8s / microVM 只换这一层）。

### dsh 入口一次性 token → **D14**

`dsh web` 每次启动 `randomBytes` 生成入口 token，没有 flag / 配置能固定或关闭。做法：桥在**无 cookie 的 `GET /`** 上注入 token 再转发（从前是 `/__open` 这条精确路径），**token 不进浏览器 URL / 历史 / Referer**，用户直接输裸域名即可。见 [D14](DECISIONS.md)。
