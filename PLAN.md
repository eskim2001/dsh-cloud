# 开发计划

> 目标：把 `dsh` 做成可运营的多租户 SaaS 平台。
> 架构见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)；决策见 [DECISIONS.md](docs/DECISIONS.md)；待验证见 [OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)。

## 总纲

**先做一条垂直闭环，别水平铺开。** 平台核心价值 = 「建实例 → 给一个带配额 / 卷 / 路由的隔离 dsh → **只有平台认证过的人能打开** → 升级 dsh 不丢内容」。这条通了，平台就成立。

## MVP 边界

| 不做 | 什么时候做 |
|---|---|
| 可观测性（Prometheus / Loki / Grafana） | M2 |
| 备份 / 镜像扫描 / 对象存储 | M2 |
| 计费 / 支付 / 充值 / 钱包 | M3 |
| K8s / microVM / 多机 | M4 |
| 外壳 / iframe 包裹（dsh 占满整页即可） | 按需，晚于 MVP |
| dsh 内部机制（密钥存储、模型端点） | 交给 dsh |

## 技术选型

**基础设施**：Docker · Traefik · Postgres
**后端**：Fastify · Drizzle · better-auth · dockerode
**前端**：Vite + React · shadcn/ui + Tailwind · TanStack Query
**实例容器**：dsh（pin 版本）· Caddy · tini · 自研两段式 Dockerfile
**MVP 不上**：Redis / 队列 · Prometheus 全家桶 · 备份 · 镜像扫描

## 组件清单（build vs buy）

**直接用开源**：Docker · Traefik · Postgres · better-auth · dockerode · Fastify · Drizzle · shadcn/Tailwind · TanStack Query · tini · Caddy

**必须自研（平台价值所在，就这 6 样）**

| # | 自研件 | 说明 |
|---|---|---|
| ① | **实例规格 + renderer** | `instance-spec` → Docker 资源；换 K8s / microVM 只换这层 |
| ② | **升级 / 回滚 + 回归验证** | 换镜像 tag + 黄金路径测试集 |
| ③ | **配额执行 + 用量统计** | 采集 → 落库 → 判定 |
| ④ | **三道门编排** | 独立网络 + forward-auth + header 门 |
| ⑤ | **管理台** | 实例列表 / 详情 / 打开 / 升级 / 配额 |
| ⑥ | **插件目录规范 + 校验** | 只收标准 client 包 |

## 里程碑

### M1 能跑 —— ✅ 已完成

- [x] 脚手架：pnpm workspace + `apps/server` + `apps/web` + `packages/instance-spec`
- [x] 实例镜像：两段式 Dockerfile + tini + `DSH_HOME=/data` + **WORKDIR 落 `/data`**
- [x] 编排闭环：dockerode 起实例容器（桥端口发布到宿主回环 + `/data` 落存储池里的独立目录，带 XFS project quota；配额落不了地的宿主退回 Docker 命名卷）
- [x] 三道门：forward-auth + 每实例 gate token + 路由生成
- [x] 页面：登录 + 实例列表 / 详情 / 打开
- [x] 升级 / 回滚（D19）、配额管理（D17）、状态现算（D16）
- [x] **磁盘硬配额（D18）**：一个 XFS 池 + 每实例一个 project ID（字节 + inode 双限），
      池子不可用时退回命名卷 + 一行警告。宿主不是 XFS 时平台自己建一块 loopback XFS 池。
      选型与实测见 [docs/storage/README.md](docs/storage/README.md)。

### M1.5 能装 —— 代码已就绪，等真机验证

让不读源码的人把平台装到自己的服务器上。

**已实现**（[D32](docs/DECISIONS.md)–[D35](docs/DECISIONS.md)）：

- **平台镜像** `ghcr.io/eskim2001/dsh-cloud`：一个容器跑控制面、**同源**提供管理台；CI 手动 dispatch
  出 amd64 + arm64（`.github/workflows/platform-image.yml`）
- **生产栈** `docker/compose/prod.yml`：入口与控制面走 **host 网络**，Postgres 只发布到宿主回环（D33）
- **TLS** 默认**逐主机 ACME HTTP-01**（控制台一张、每个实例子域一张），不需要 DNS provider ——
  于是原 #6 从「阻塞」降级为「推迟」（D34、[OPEN-QUESTIONS](docs/OPEN-QUESTIONS.md) §二）
- **存储池**由安装脚本在**宿主上**预置并写持久化；控制面只做探针与设配额、拿 `CAP_SYS_ADMIN`，
  **不在容器里建池**（D35）
- **`scripts/install.sh`**：install / update / uninstall，幂等，**绝不重发 secret**；
  部署资产（prod.yml + Traefik 模板）随镜像走、用 `docker cp` 取出，模板与镜像版本严格对齐
- **不填域名也能装**（[D36](docs/DECISIONS.md)）：装机不配域名、也不建账号 —— 控制面以**引导态**
  起来，直接对外开一个专用端口（安装脚本打印那一行地址），口子上只有引导页 + setup 端点，
  操作者在那一页里建管理员、填域名，填完暴露当场关闭、端口收回回环。
  跳转也从静态配置搬进了动态 router（静态那份会把 :80 全 301 掉，实测见 D36）
- README「快速开始」已换成部署路径；只对本地成立的链路（`lvh.me`、自签红锁）收进
  [AGENTS.md](AGENTS.md) §四 与 [docker/compose/README.md](docker/compose/README.md)

**必须在真 Linux 主机上验**（下面每一条在本机都验不了）：

1. **host 网络端到端**：登录控制台 → 开一个实例 → 访问。这是 #4 推出来的承重假设；不通就得回头实现 D3。
2. 容器内 `cap_add: SYS_ADMIN` 下对 bind mount 的 XFS 跑 `xfs_quota`：探针与设限额都成功、`report` 读到真数字。
3. loopback 池**重启后仍在**；挂载丢了时新护栏（`DSH_CONTAINERIZED=1`）正确拒绝启动。
4. 实例容器 bind `${HOST_STORAGE_ROOT}/<key>` 时，daemon 解析到的是池而不是空目录。
5. 逐主机 ACME：控制台与某个实例都真签下来；`acme.json` 权限 600、重启不风暴重签。
6. `install.sh` 的三条存储路径（已是 XFS+`pquota` / 建 loopback / 都不行）在干净 VM 上各跑一遍。
7. CI 的 amd64 构建（本地只验过 arm64）。

**这套里唯一能在开发机上验完整的是引导态那条链路**（引导页 → 填域名 → 摘掉入口 → 控制台落位）：
它不依赖 host 网络，本地起一个 Traefik + 控制面即可端到端跑（见 D36）。

**还差一道发布工序**：仓库目前**没有任何 git tag**，而 README 那行安装命令钉的是
`raw.githubusercontent.com/<repo>/v<版本>/...` —— 首次发布要先给 tag 起名并打上去。

**installer 契约**（脚本照此实现）：

一行安装，脚本按序做：预检（环境 / 端口 / **存储能力**）→ 生成两个随机 secret →
**在宿主上预置存储池并写持久化**（D35）→ 起 Postgres → 跑迁移 → 建第一个管理员 →
起控制面与入口 → **打印控制台地址与管理员一次性密码**。

**部署前置条件**（和本地开发完全不重叠，别复用）：

- Linux 主机，装了 Docker 与 Compose v2
- **一块能给硬配额的文件系统**：`HOST_STORAGE_ROOT` 落在一块 **XFS 且以 `pquota` 挂载**的盘上；
  不是 XFS 时**安装脚本会在宿主上**建**一块** loopback XFS 镜像当池子（整机一个 loop，不是每实例一个），
  那一步要宿主允许 loop 设备、脚本以 root 跑（建镜像 / `mkfs.xfs` / 挂载 / 写持久化），
  之后控制面靠 `CAP_SYS_ADMIN` 设配额（[D35](docs/DECISIONS.md)）。**两条都做不到就拒绝安装**；
  装完池子若失效，平台也会拒绝启动 —— 池化之后"看起来有配额"比没有更糟
  （见 [D18](docs/DECISIONS.md)、[storage/README.md](docs/storage/README.md)）
- 端口 `80` / `443` 空闲（ACME 的 HTTP-01 校验需要 `80`）
- **域名**：装机不配 —— 控制面以**引导态**起来，操作者在引导页里填（连同首个管理员账号）。
  要求**泛解析 `*.<父域>` 指向这台机器**，否则证书签不下来（引导页会检查并警告，不拦）
- 宿主能访问 GHCR（拉实例镜像）

**三项已定**：

1. **脚本 URL** —— 挂 `raw.githubusercontent.com/<repo>/<tag>/scripts/install.sh`，**pin tag + 校验 checksum**，
   不从移动分支管道进 shell。
2. **管理员凭据** —— 安装时随机生成、打印一次。本地那对 `admin@lvh.me` / `dsh-cloud-dev` 绝不沿用。
3. **域名怎么给** —— 引导页里填（装机不问，见 [D36](docs/DECISIONS.md)）。

### M2 能管

实例列表 / 详情 / 建 / 升级 / 回滚 UI 完善；插件目录规范；workspace 独立卷；对账循环；审计日志；可观测性与备份。

### M3 能卖

注册 / 充值 / 钱包 / 计费 / 套餐 / 配额判定；**实测单容器资源占用**（定配额档位与底价）。

### M4 演进

K8s renderer；microVM / gVisor renderer；token 计费；更多形态（headless / acp / sdk）。

## 验收表（缺一条不算过）

每次改隔离边界、认证链路或升级流程，都要重跑这张表。

| # | 动作 | 期望 |
|---|---|---|
| 1 | 未登录访问 `<slug>.app.example.com` | 弹回登录页，**打不开** |
| 2 | 登录他人账号访问该实例 | 拒绝 |
| 3 | 登录 owner 账号 | 正常打开 dsh，能对话 |
| 4 | 无签名直连容器 `:8080` | **403** |
| 5 | 从实例 A 容器内扫实例 B / 连 Postgres | **不通** |
| 6 | 换新镜像 tag 重启 | workspace / 会话 / 插件 / 配置**全在** |
| 7 | 容器内 `/data` 写入大文件 | 落进数据文件系统，重建容器后还在 |
| 8 | 打开设置 → 模型提供方，填 key 保存 | 提供方目录正常加载、key 存得进（**D15**；每次升 dsh 必跑） |
| 9 | 在宿主 `docker stop` 实例容器 / 让它 crash-loop | 10 秒内列表与详情显示「已停止」/「重启中」，不是「运行中」（**D16**） |

自动化部分见 `apps/server/src/**/*.test.ts`。**池子（`apps/server/src/instance/pool.ts`）是例外：
它没有自动化用例**，目前只有一台真机上的手动核对（步骤与实测数字见
[storage/README.md](docs/storage/README.md)）—— 而它恰好是"失败时静默无配额"的那一块，
补用例值得优先做。

## 守则

见 [AGENTS.md](AGENTS.md) §二（铁律）。重点：用户内容必须落 `/data`、插件只收标准包、升级 = 换镜像、验证四级收尾、不钻 dsh 内部、访问控制三道门。
