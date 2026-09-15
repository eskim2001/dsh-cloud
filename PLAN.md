# 开发计划

> 目标：把 `dsh` 做成一个开源自托管、装完就能用的多用户运行平台。
> 架构见 [ARCHITECTURE.md](docs/ARCHITECTURE.md)；决策见 [DECISIONS.md](docs/DECISIONS.md)；待验证见 [OPEN-QUESTIONS.md](docs/OPEN-QUESTIONS.md)。

## 总纲

**先做一条垂直闭环，别水平铺开。** 平台核心价值 = 「建实例 → 给一个带配额 / 卷 / 路由的隔离 dsh → **只有平台认证过的人能打开** → 升级 dsh 不丢内容」。这条通了，平台就成立。

## MVP 边界

| 不做 | 什么时候做 |
|---|---|
| 可观测性（Prometheus / Loki / Grafana） | M2 |
| 备份 / 镜像扫描 / 对象存储 | M2 |
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
| ④ | **三道门编排** | 每实例一个网络 + 发布到回环 + forward-auth + header 门 |
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

### M1.5 能装 —— **真机已验通装机这条路**（2026-09-14）

让不读源码的人把平台装到自己的服务器上。

**装机已经跑通**：一行命令、零提问，装完打印一行引导地址；在那一页里建管理员、填域名，
控制面收回对外端口、Traefik 重投影，Let's Encrypt 为控制台**签下真证书**。
**还没通的是装完之后** —— 开工作空间那条链路（见下面的清单）。

**已实现**（[D32](docs/DECISIONS.md)–[D35](docs/DECISIONS.md)）：

- **平台镜像** `ghcr.io/eskim2001/dshcloud`：一个容器跑控制面、**同源**提供管理台；CI 手动 dispatch
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

**真 Linux 主机上的清单**（2026-09-14 核对过一次，✅ = 已验 / ❌ = 还没）：

1. ❌ **host 网络端到端**：登录控制台 → 开一个实例 → 访问。**前半段已通**（`console.<父域>`
   拿到 LE 真证书、HTTPS 200、`:80` 301），**开实例那段没验** —— 要先把实例镜像发布并预热到本机。
2. ❌ 容器内 `cap_add: SYS_ADMIN` 下对 bind mount 的 XFS 跑 `xfs_quota`：探针与设限额都成功、
   `report` 读到真数字。（宿主上的池子与 `prjquota` 已验，**容器内**这一段要建出实例才走得到。）
3. ❌ loopback 池**重启后仍在**；挂载丢了时新护栏（`DSH_CONTAINERIZED=1`）正确拒绝启动。
4. ❌ 实例容器 bind `${HOST_STORAGE_ROOT}/<key>` 时，daemon 解析到的是池而不是空目录。
5. ❌ **逐主机 ACME**：**控制台那张已真签下来**（LE、外部校验通过、`:80` 301 到 `:443`），
   **实例那张没验**；`acme.json` 权限 600、重启不风暴重签也还没看。
6. ❌ `install.sh` 的三条存储路径：**建 loopback 这条真机跑通**（含 `uninstall --purge` 清干净）；
   「已经是 XFS + `pquota`」与「两条都不行」没验。
7. ✅ **CI 的 amd64 构建**：每次发版都同时出 amd64 + arm64，多架构 manifest 每次校验 digest。

**引导态那条链路**（引导页 → 建号 + 填域名 → 摘掉入口 → 控制台落位）**已在真机验完整**，
开发机上也能端到端跑（见 D36）—— 它是整套里唯一两种环境都能验的。

发布工序早就位了：README 那行安装命令指向 `main`（**不钉版本**，读者拿到的是当前分支那份），
发版另打一个 `vX.Y.Z` tag。注意**推 tag 不会触发镜像构建** —— `platform-image.yml` 只认手动
`gh workflow run`。

**installer 契约**（脚本照此实现）：

一行安装，脚本按序做：预检（环境 / 端口 / **存储能力**）→ 生成随机的 secret →
**在宿主上预置存储池并写持久化**（D35）→ 起 Postgres → 跑迁移 → 起控制面与入口 →
**打印一行引导地址**。账号和域名都在那一页里配 —— 安装这一步**一个问题都不问**（D36）。

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

1. **脚本 URL** —— 指向 `raw.githubusercontent.com/<repo>/main/scripts/install.sh`，**不钉版本、
   不校验 checksum**：读者拿到的是当前分支那份，不会随发版过期。代价是不再有「内容不会变、
   可两边核对 SHA-256」这条性质（2026-09-15 改的，原先定的是 pin tag）。
2. **管理员凭据** —— 安装时随机生成、打印一次。本地那对 `admin@lvh.me` / `dsh-cloud-dev` 绝不沿用。
3. **域名怎么给** —— 引导页里填（装机不问，见 [D36](docs/DECISIONS.md)）。

### M2 能管

实例列表 / 详情 / 建 / 升级 / 回滚 UI 完善；插件目录规范；workspace 独立卷；对账循环；审计日志；可观测性与备份。

### M3 好用

把日常使用的毛刺磨掉：装机到开出第一个工作空间之间不留断层；邀请与升级流程顺手；界面文案与文档一致。
**实测单容器资源占用**，据此定默认配额档位。

### M4 演进

K8s renderer；microVM / gVisor renderer；更多形态（headless / acp / sdk）。

## 验收表（缺一条不算过）

每次改隔离边界、认证链路或升级流程，都要重跑这张表。

| # | 动作 | 期望 |
|---|---|---|
| 1 | 未登录访问 `<slug>.app.example.com` | 弹回登录页，**打不开** |
| 2 | 登录他人账号访问该实例 | 拒绝 |
| 3 | 登录 owner 账号 | 正常打开 dsh，能对话 |
| 4 | 无签名直连容器 `:8080` | **403** |
| 5 | 从实例 A 容器内按 IP 扫段找实例 B、连宿主的服务 | **不通**（跑法见下） |
| 6 | 换新镜像 tag 重启 | workspace / 会话 / 插件 / 配置**全在** |
| 7 | 容器内 `/data` 写入大文件 | 落进数据文件系统，重建容器后还在 |
| 8 | 打开设置 → 模型提供方，填 key 保存 | 提供方目录正常加载、key 存得进（**D15**；每次升 dsh 必跑） |
| 9 | 在宿主 `docker stop` 实例容器 / 让它 crash-loop | 10 秒内列表与详情显示「已停止」/「重启中」，不是「运行中」（**D16**） |
| 10 | 加 `--harden-host` 之后 | 入口 / 实例出网 / 控制台都不受影响；宿主 INPUT 链按注释可识别；`uninstall` 干净回退 |

**第 5 条的跑法**（真机。2026-09-15 起每实例一个自己的网络，见 D37）：

```bash
docker inspect dsh-instance-<b> --format '{{json .NetworkSettings.Networks}}'  # 只有一个键 dsh-net-<b>
A_IP=$(docker inspect dsh-instance-<a> --format '{{(index .NetworkSettings.Networks "dsh-net-<a>").IPAddress}}')
GW=$(docker network inspect dsh-net-<b> --format '{{(index .IPAM.Config 0).Gateway}}')
docker exec dsh-instance-<b> sh -c "nc -z -w 2 $A_IP 8080; echo exit=$?"      # 非零
docker exec dsh-instance-<b> ip neigh                                        # 没有 <a> 的表项（不同广播域）
docker exec dsh-instance-<b> sh -c "nc -z -w 2 $GW 22; echo exit=$?"         # 默认可达；加 --harden-host 后非零
docker exec dsh-instance-<b> sh -c "getent hosts registry.npmjs.org"         # 出网仍然通
```

⚠️ **存量实例**：升级上来的容器还在默认 bridge 上 —— 要**在控制台把实例重启一次**（重启 = 删容器重建）
才会落到自己的网络上；不重启，第 5 条仍然通。

自动化部分见 `apps/server/src/**/*.test.ts`。**池子（`apps/server/src/instance/pool.ts`）是例外：
它没有自动化用例**，目前只有一台真机上的手动核对（步骤与实测数字见
[storage/README.md](docs/storage/README.md)）—— 而它恰好是"失败时静默无配额"的那一块，
补用例值得优先做。

## 守则

见 [AGENTS.md](AGENTS.md) §二（铁律）。重点：用户内容必须落 `/data`、插件只收标准包、升级 = 换镜像、验证四级收尾、不钻 dsh 内部、访问控制三道门。
