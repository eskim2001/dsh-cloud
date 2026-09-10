# 决策记录（ADR）

> 每条：**决策 / 理由 / 备选 / 何时重审**。改了这里要同步 [ARCHITECTURE.md](ARCHITECTURE.md)。

## D1 · 每实例一个容器，不是子进程

- **决策**：一实例一容器，独立网络 + 独立卷。
- **理由**：子进程 + setuid/iptables 是软隔离（社区项目 [dsh-server-login](https://github.com/pointer-a/dsh-server-login) 模式 A 的做法），跨实例边界不硬。容器能给出网络、文件、凭据三条硬边界。
- **备选**：同机子进程（否）；每实例一 VM（M4 再说）。
- **重审**：客户要求内核级隔离时 → D2。

## D2 · MVP 用 Docker，不上 microVM

- **决策**：runtime 用 Docker；`instance-spec` 的 renderer 保持可插拔。
- **理由**：跨实例的威胁已被网络隔离堵死；microVM 的三笔代价（密度、小文件 I/O、`/dev/kvm` 可用性）现在付，是为一个还没有客户的问题付账。dsh 的 `npm install` / 编译负载正好打中 microVM 的 virtiofs 弱项。
- **备选**：Kata Containers / Firecracker（要 `/dev/kvm`，多数云主机不支持嵌套虚拟化）；gVisor（一行切换，但 pty / syscall 兼容性风险不对称）。
- **升级路径**：K8s + Kata（containerd runtimeClass），**不要**裸 Firecracker。
- **重审**：客户合规要求内核隔离 / 允许装不可信第三方插件 / 规模上去了要密度。

## D3 · 每实例独立 bridge 网络 + 入口接入，不发布宿主端口

- **决策**：每实例一个独立 bridge 网络（可出网、互不可达）；容器**不发布任何宿主端口**；控制面把入口（Traefik）接进每个实例网络，入口按容器名直连桥 `http://dsh-instance-<slug>:8080`。
- **理由**：跨实例网络层**完全不通**，且在 Docker Desktop 上也成立——发布到宿主回环的端口会经它注入的魔法网关对**所有**容器可见（OPEN-QUESTIONS #4 实测）。不发布就没有这个面。
- **备选**：发布到宿主回环、Traefik 走 `host.docker.internal`（原方案，否——macOS/Windows 上跨实例可互达）；共享 `edge_net` + header 门（否——实例能扫到彼此的端口）。
- **代价**：入口要动态接进 N 个实例网络（`docker network connect`，幂等）；入口容器被重建后要重接（放在启动对账里）。原方案的宿主端口分配/冲突重试逻辑整体消失。
- **重审**：单容器可接入网络数有上限，规模上去了考虑每实例一个入口实例或 K8s。

## D4 · 子域，不是子路径

- **决策**：实例 dsh 在 `<slug>.app.example.com`。
- **理由**：dsh 的 SPA 用绝对路径，子路径载不动静态资源（[dsh-server-login](https://github.com/pointer-a/dsh-server-login) 的 README 里验证过）。
- **代价**：通配证书 → DNS-01 challenge → **依赖 DNS provider**。

## D5 · MVP 不做 iframe 外壳

- **决策**：dsh 占满整页，不做外层包裹。
- **理由**：同源 iframe 无安全边界（agent 代码与外壳同源）；跨域 iframe 受 `SameSite=Lax` 限制，要子域同站才行。且外壳与访问控制正交，晚于闭环。
- **重审**：需要平台统一导航 / 统一文件视图时。

## D6 · 容器内转发器用 Caddy

- **决策**：容器内 Caddy 监听 `:8080` → 转发 `127.0.0.1:3080`，并校验 header 门。
- **理由**：dsh **拒绝绑 `0.0.0.0`**，容器内转发器是架构必需，不是可选。Caddy 一个 Caddyfile 就够，别在闭环没通之前优化基础设施。
- **备选**：自写 ~80 行 Go 代理（更轻、和 K8s 阶段 sidecar 同一二进制）；nginx（省内存、配置丑）；socat（最轻但纯 TCP，看不懂 header）。
- **重审**：上规模后换成自写 Go 代理（`dsh-bridge`）。

## D7 · 用官方 `--trusted-host`，不做 Host/Origin 伪装

- **决策**：优先用官方 flag，去掉 [dsh-deploy](https://github.com/mervyn-teo/dsh-deploy) 那种 sed 补丁和 [dsh-gateway](https://github.com/clarknu/dsh-gateway) 那种 loopback 伪装。
- **理由**：少一层 hack，升级 dsh 不会因补丁失效而静默坏掉。
- **风险**：要确认它的语义是"跳过 Host 检查"还是"赋予 loopback 特权"（后者 + 可伪造 Host = 提权）。见 OPEN-QUESTIONS #2。

## D8 · 访问控制三道门

- **决策**：① 私有网络（跨实例不可达）② Traefik 前置认证覆盖页面/API/WS，且做**授权**（登录者 == owner）③ 桥的 header 门（HMAC，每实例独立密钥）。
- **理由**：③ 是**纵深防御**，不是唯一拦阻——跨实例已由 ① 的「不发布宿主端口 + 入口接入」守住（OPEN-QUESTIONS #4 改后实测：容器名 / 容器 IP / 网关旧端口全部阻断）。但实例仍能经 Docker Desktop 的魔法网关摸到**平台自己**发布的端口（控制面 / Traefik / Postgres），那一层 ③ 是最后一道；且 Linux 上的表现未实测 → ③ 必须保留，不能被当成"可省的冗余"。
- **注意：漏挂认证不会报错，只有洞**。门② 的认证是**逐条 router 显式挂上去**的（`buildTraefikConfig` 里的 `middlewares: [authName]`，见 `apps/server/src/instance/traefik.ts`），**不是"默认拒绝"**。漏挂的 router 在 Traefik 里是**合法配置**：照常路由、照常 200，没有告警、没有日志、没有测试会失败。
  - **对实例路由，门③ 把它兜成了 fail-closed**：gate token 只在认证 + 授权通过后才由 forward-auth 返回（`apps/server/src/http/forward-auth.ts`），经 `authResponseHeaders` 注入上游，容器内 Caddy 缺 header 即 403（`docker/instance-image/Caddyfile`）。所以漏挂表现为 **403，不是裸奔**。
  - **代价是这个错误变得不可见**：未认证用户拿到 403，和门② 正常工作时长得一模一样——你不会知道门② 其实没生效。门③ 只把它从"洞"变成了"沉默的配置错误"。
  - **真正会变成洞的场景**：① 新增路由指向**非实例后端**（平台 API、预览 / metrics / 新 sidecar）——那些后端没有 Caddy 门；② 为了让路由通而塞一个静态 header 中间件伪造 `X-Platform-Token`，架空门③；③ 客户端自带 `X-Platform-Token`（Traefik 默认**透传客户端 header**，只在 forward-auth 成功时覆盖）——token 泄露即失效；④ 门③ 的 token 由平台级 `PLATFORM_SECRET` 派生，该密钥泄露 → 所有实例的门一起倒。
  - **规则**：所有实例路由必须由 `buildTraefikConfig` 生成（唯一挂认证的地方）；新增任何非实例路由必须显式回答"谁来认证"；必须有自动化攻击测试（见 PLAN 验收表）——因为漏挂的唯一症状是"没有症状"。

## D9 · 只做平台层，不碰 dsh 内部

- **决策**：密钥存储、模型端点、凭据子系统是 dsh 自己的功能，平台不设计、不深挖。
- **理由**：这是刻意的产品边界——平台只负责「把 dsh 安全地租出去」，不替 dsh 做产品决策。
- **唯一保留的平台级判断**：隔离边界本身——不要把共享 key 塞进多租户容器。

## D10 · 插件只收标准 client 包

- **决策**：只接受标准 `@deepseek-ai/dsh-client-*` 包（`export inject` + `ctx.slots.inject`），**禁手写** `window.__ModuleLoader__.load`。
- **理由**：手写 loader 会**静默不渲染**（实测结论：手写 loader 静默不渲染）。"只收标准包"解决的是兼容性，**不是**安全性——插件安全是 M2 的独立课题。

## D11 · dsh 版本 pin 死，升级前跑回归

- **决策**：dsh 版本当**被验证的依赖**，不自动跟进。
- **理由**：dsh 还在 0.x，插件契约与 `/data` 布局可能变，而我们的"升级不丢"承诺正建立在其上。

## D12 · rootfs 可写，不做只读根

- **决策**：容器 rootfs **可写**；npm / pnpm 的全局前缀指向 `/data`，agent 装的东西随升级保留。只读 rootfs 降级为**可选加固**。
- **理由**：dsh 是**编码 agent**，装依赖 / 装 CLI 工具是日常。只读 rootfs 会把它捆住，而**跨实例安全并不依赖它**——边界是网络 / 文件 / 凭据（D3/D4）。收益也小：攻击者已有代码执行，二进制从 `/data` 照样能跑，而 `/data` 本来就要持久化。
- **备选**：只读 rootfs + 全部可写路径指到 `/data`（否——agent 装不了系统包）。
- **附带**：tini 装在镜像里作 PID 1（agent 会大量 spawn 子进程，必须有东西回收僵尸），不依赖 Docker 的 `Init`。
- **重审**：客户合规要求只读根时。

## D13 · 容器内预装 pnpm，且全局前缀落卷

- **决策**：镜像里预装 pnpm（与 npm 并存）；`NPM_CONFIG_PREFIX` / `PNPM_HOME` / `PNPM_STORE_DIR` 全部指向 `/data`。
- **理由**：agent 会在用户项目里用 pnpm；预装省得它自己装。全局前缀落卷是为了**升级不丢**——否则重建容器后 agent 装过的工具全没了。

## D14 · 入口 token 由桥注入，不进浏览器 URL

- **决策**：平台把「打开 dsh」指向 `https://<slug>.<base>/__open`；容器内桥在这条路径上补 dsh 的入口 token 再转发。entrypoint 从 dsh 启动输出里抓 token，`export DSH_LAUNCH_TOKEN` 后起 Caddy（Caddyfile 用 `{env.DSH_LAUNCH_TOKEN}`）。
- **理由**：dsh 每次启动随机生成入口 token，首次访问必须带在 query 上才能换 cookie，且没有 flag / 配置能固定或关闭（`ConnectionConfig` 只有 `recovery` / `cookieMaxAgeDays`）。桥注入让 token **不进浏览器 URL / 历史 / Referer**，判据是精确路径而非猜 cookie。
- **备选**：平台直接给带 token 的链接（token 进浏览器历史）；forward-auth 按"有没有 Cookie"302（启发式）；关掉 dsh 的 browser-auth（动 dsh 安全功能，且 `connection` 插件兼做 RPC 传输，多半关不掉）。
- **代价**：entrypoint 解析 dsh 的启动输出 —— 格式耦合，靠 D11 的版本 pin + 升级前回归兜住；抓不到时 `/__open` 会 401，entrypoint 打警告。
- **重审**：dsh 提供固定或可配置的入口 token 时。

## D15 · 用平台插件解锁客户端 `isLoopback`，不补丁官方 bundle

- **决策**：实例镜像带一个 8 行宿主插件 [`docker/instance-image/owns-host.mjs`](../docker/instance-image/owns-host.mjs)，
  经官方 `--patch` 覆盖层（`owns-host.yml`）插进 web profile，往 index 注入
  `globalThis.__DSH_TRANSPORT__ = { ownsHost: true }`，把客户端 `isLoopback` 判真。
- **理由**：`isLoopback` 在浏览器里由 `location.hostname` 算
  （[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) `packages/client/connection/src/client/index.ts:227`），**代理改不了**；
  不判真则 `persistence='memory'`，设置面终态不可用（用户连 API key 都填不了，阻断验收表 #3）。
  走 dsh 公开扩展点（`webServer` 的 `webserver/index-inject` 行 + 官方 `--patch`），**不改官方文件**——
  对标项目的 sed 补丁（dsh-deploy、deepseek-harness-fnos）升级即失效，我们不跟。
- **服务端不需要动**（2026-09-09 实测，0.1.2-rc.1，容器内直连 3080、Host=实例域名）：
  `/api` 只有两道闸——Host/Origin 围栏（官方 `--trusted-host` 已放行）+ 浏览器 cookie。
  `settings/describe` → `ok:true`；`settings/mutate`、`credentials/set → describe → unset`
  全部到达 handler 并成功。**没有"特权 RPC 钉死回环"这回事**（修正早先引自社区项目
  [dsh-deploy](https://github.com/mervyn-teo/dsh-deploy) 注释的判断）。
- **代价**：主动放弃"客户端回环"这层兜底——若 dsh 以后给 `isLoopback` 加新消费者（本机专属能力），
  等于也对我们用户开放。拦阻靠服务端三道门（D8），**门不能漏挂**。
- **风险**：`__DSH_TRANSPORT__` / `ownsHost` 是 dsh 内部约定，升级后可能改名 → 设置面**静默**变坏。
  兜底：插件文件缺失或解析失败时 dsh 直接退出（响亮失败，已实测）；升级前必跑验收表
  「升级后设置页仍可用」。
- **坑**：`--patch` 是**启动器**选项，必须写在 web app 自己的参数（`--host/--port/--no-open`）**之前**，
  否则被当成 app 选项 → `error: unknown option '--patch'` → 实例 crash-loop（已踩）。
- **重审**：dsh 给出官方开关（`--trusted-host` 的客户端对等物）时换回官方。

## D16 · 实例状态查询时从 Docker 现算，DB 只记意图

- **决策**：列表 / 详情 / 管理面的 `status` 在**请求时**用一次 `docker ps -a` 现算
  （[`apps/server/src/instance/runtime-status.ts`](../apps/server/src/instance/runtime-status.ts)）；
  DB 的 `instances.status` 降级为**意图**（编排动作、对账器仍读它；路由投影见 D25，
  已经改成读容器事实、只在取不到时退回它）。
  状态词汇加 `restarting` / `paused`，并把 Docker 原文（`Restarting (3) 20 seconds ago`）
  透成 `statusText`。前端不再把 `running` 当落定态：编排中 3 秒轮询，其余 10 秒兜底。
- **理由**：D15 验收时 `--patch` 参数顺序错导致 crash-loop，**列表和详情都显示「运行中」**。
  根因两层：① 语义——对账器把 `restarting` 折进 `LIVE_CONTAINER`（这是对的，容器会自己回来），
  所以采样再快也不会显示「重启中」；② 传输——DB 快照被当事实返回，前端又把 `running` 当落定态
  直接停止轮询，两个错误叠成「永远显示运行中」。
  Dokploy 看起来「实时」，实测也只是**按需 `docker ps -a` + 5–10 秒轮询**
  （[dokploy](https://github.com/dokploy/dokploy) `packages/server/src/services/docker.ts`），没有事件流 / WS / 采样器——
  我们缺的是「查询时取事实」，不是「实时」。
- **备选**：① 调小对账周期（治不了：折进 running 是语义问题）；② 订阅 Docker events 流
  （准，但要长连接 + 断线重放 + 多控制面实例协调，MVP 不值）；③ 每实例一次 `inspect`
  （N 次往返，不如一次 `docker ps -a`）。
- **代价**：每次列表/详情多一次 `docker ps -a`——**按 `dsh-instance-` 前缀过滤**后约 35ms
  （不过滤要扫宿主上全部容器，开发机 63 个约 400ms）；前端常驻 10 秒轮询，
  稳定态也轮——这是准确性的价钱。**取不到 Docker 时回退 DB 快照并告警**：
  宁可显示旧值，也不谎报「全部已停止」。
- **重审**：实例上百、`docker ps -a` 成瓶颈时（改事件流 + 内存快照）；或 dsh 侧给出
  平台可直接问的状态接口。

## D17 · 配额创建时由用户定，之后只有管理员能改

- **决策**：CPU / 内存 / pids 在**创建实例时**由用户配置（`POST /api/instances`，默认 1 核 /
  2048MB）；**创建后用户不可改**，只有管理员能改。磁盘配额等 #7 选型定了再补，权限规则同上。
- **理由**：资源配额直接对应成本，用户自助改 = 自助扩容，要配套计费 / 风控 / 下限，MVP 不值。
  管理员改覆盖真实场景：欠费降配、投诉调大。
- **实现**（改动很小）：`restart` 已经是**从 DB 行重建容器**——`provisioner.ts` 的
  `applyRuntime` → `specOf(row)` 直接读 `row.cpus / memoryMb / pidsLimit`，与升级换镜像同一条路。
  所以「改 DB 配额 → 触发 restart」即可生效，**不需要新写 Docker 逻辑**。
  （备选，未采用：`docker update`（dockerode `container.update()`）可对**运行中**容器改 Memory /
  NanoCpus / PidsLimit，不重建；但内存下调不能低于当前用量、`MemorySwap` 要一起改，
  而且和「换镜像」变成两条路径。重建几秒就够，不值。）
- **已实现（2026-09-09）**：`PATCH /api/admin/instances/:id/quota` + 管理台实例行的「改配额」对话框。
  `provisioner.setQuota` 的顺序：先落库 → 删旧容器（Docker 的 Memory / NanoCpus / PidsLimit
  **只在建容器时生效**）→ 原本在跑的按新规格重建（中断几秒），原本停着的**保持停止**、
  只删容器并清 `containerId`——否则 `start` 会复用旧容器、带着旧配额起来。
  校验上限取 `instance-spec` 的 64 核 / 256GB，**比用户自助创建的 8 核 / 16GB 宽**
  （管理员可按合同给更高规格）。实测：1 核 / 512MB / 128 pids → 2 核 / 1024MB / 256，
  容器重建、`/data` 里的文件还在；停止态改配额后仍为 stopped。
- **待补**：磁盘配额的可改性见 D18（扩容在线、缩容停机，已实现）。
- **重审**：要开放用户自助扩容（配计费）时。

## D18 · 磁盘配额：每实例一个 loop 文件 + ext4，文件系统大小即配额

- **决策**：`/data` 不再挂 Docker named volume，改成宿主上一个稀疏文件
  `<HOST_STORAGE_ROOT>/<slug>.img`（大小 = 配额），`mkfs.ext4 -m 0` 后经 loop 设备挂到
  `<HOST_STORAGE_ROOT>/<slug>`，容器 `Binds` 这个宿主目录。**配额 = 文件系统大小**，
  是内核级硬限。宿主级操作全部走一个**特权助手容器**：
  `docker run --rm --privileged --pid=host <image> nsenter -t 1 -m -u -n -i sh -c <脚本>`，
  开发机与生产同一条代码路径（见 [`apps/server/src/instance/host-storage.ts`](../apps/server/src/instance/host-storage.ts)）。
- **理由**：① 磁盘配额不是 Docker 能给的——实测 `--storage-opt size=10m` 在本机 Docker Desktop
  **被静默忽略**（写 30MB 不拦），而且它本来就只限容器可写层，管不到 `/data`；
  ② 池化 + XFS project quota 更优雅，但设限额要 `xfsprogs`，Docker Desktop 的宿主根是
  LinuxKit（只有 busybox + e2fsprogs），且 `nsenter -t 1 -m` 之后容器里的工具**不可见**
  → 开发机根本验不了，用户明确不接受；③ loop + ext4 只依赖宿主自带工具
  （`truncate / losetup / mkfs.ext4 / mount / chown / resize2fs / e2fsck`），开发机实测全通。
- **开发机实测（2026-09-09，macOS + Docker Desktop，LinuxKit 6.10.14）**：

  | 项 | 结果 |
  |---|---|
  | 配额硬限 | ✓ 64MB 卷，容器内非 root 写到 53.4MB 即 ENOSPC |
  | 数据安全 | ✓ 卸载 + 重新挂载后内容完好（模拟宿主重启） |
  | 用量读数 | ✓ 普通非特权容器 `df -B1` 读挂载点（56040448 / 57381888） |
  | 在线扩容 | ✓ 55M→115M，`truncate` + `losetup -c` + `resize2fs`，不停机 |
  | 缩容保护 | ✓ 满盘时被正确拒绝（`New size smaller than minimum`） |
  | loop 数量 | ✓ 不受 `max_loop=8` 限制，loop-control 动态分配到 loop13 |

- **重启策略改 `on-failure:5`**（原 `unless-stopped`）：挂载是内核态，宿主 / Docker daemon
  重启后**全部消失**。`unless-stopped` 会让容器在 daemon 起来时**自动拉起**，而那时挂载还没
  恢复 → bind 到一个空目录 → 用户看到「数据没了」，且容器照常运行、UI 照常绿。
  `on-failure` 在 daemon 重启时**不拉起**（官方文档明说 "It doesn't restart the container if
  the daemon restarts"），崩溃时照常重试 5 次。实测确认：手动 `docker stop` 后
  `exited / restarting=false / restarts=0`；`exit 1` 后自动重启到 `restarts=3`。
  于是「挂载就绪」天然先于「容器启动」，竞态消失，且「停止」按钮不被自动拉起抵消。
- **启动顺序**：① 恢复所有实例的挂载 → ② 把 DB 里 `status=running` 的实例按序拉起 →
  ③ 常规对账。② 是必须的：`on-failure` 不会在宿主重启后自己回来，缺了它 DB 的 running 意图
  会被对账器抹成 stopped（「重启后实例全停」）。
- **对账 fail-loud**：`applyRuntime`（所有建容器的唯一收口点）第一步就是存储就位检查，
  失败直接抛错、实例标 `error`、**不启动容器**。判定用 `mountpoint -q` 而不是「目录存在」——
  `docker create -v <宿主目录>:/data` 在目录不存在时会**自动建一个空目录**，容器正常跑、
  用户看到空 `/data`，这比报错更糟：它看起来一切正常。
  更进一步，**`ensure` 永远不新建**：数据文件不见了、或文件系统认不出来，一律报错；
  新建只走单独的 `create`，且只有建实例那条路会调它。否则「文件被删」会静默变成
  「一个空实例」——用户以为数据丢了，我们却当成功。
- **代价**：① 每实例一个 loop + 一个 ext4（创建成本、元数据、挂载数），上百实例时换成
  「一块盘 + XFS pquota」——那时生产宿主装 xfsprogs 即可，**本模块的接口不变**；
  ② 特权助手容器是新的强特权面（镜像固定、脚本白名单、零用户输入拼接、只在控制面可达）；
  ③ 数据落在 `<HOST_STORAGE_ROOT>/` 而非 Docker 卷 → 备份 / 清理 / 监控要自写，
  `docker volume` 那套不适用；④ loop 层有 I/O 开销（顺序写实测 ~300MB/s），生产建议直接挂盘 / LV；
  ⑤ **超额承诺**：稀疏文件只吃实际写入量，所以「各实例配额之和」可以远超宿主容量。
  MVP 不做总容量闸门，但要在宿主剩余空间告急时告警（否则写满宿主会连累所有实例）。
- **宿主容量的坑（2026-09-09 实测）**：容器内 `df` 报 `/dev/vda1` 1007G / 可用 895G，
  那是 Docker Desktop 虚拟盘的**名义上限**——`Docker.raw` 是稀疏文件（标称 1.0T，实占 62G），
  真实地板是 macOS 数据卷的 **187Gi 可用**。**宿主 `df` 在稀疏盘上会高估可用空间**，
  容量规划要按物理盘算，别信宿主 `df`。
- **改配额（磁盘，2026-09-09 已实现）**：`setQuota` 里磁盘走单独一条路。扩容**在线**——
  `truncate` + `losetup -c` + `resize2fs`，**不重建容器**（实测 `StartedAt` 不变、容器内 `df`
  立刻变大）；缩容**必须停机**——删容器 → `shrink` 自己 `umount` → `resize2fs` → `truncate` →
  按新规格重建。缩容前**先预检**：`ensure` + `usage`，已用 > 目标直接抛 `ShrinkBelowUsageError`
  （HTTP 400，文案「该实例已用 X MB，不能缩到 Y MB」），此时**什么都还没动**；`resize2fs`
  真失败时**回滚**配额到原值并按原规格重启（`ShrinkFailedError`），不留「容器已删、库记小配额、
  文件系统还是大的」半截状态。回滚是必要的：删容器与改库都发生在缩容之前，不回滚就没有退路。
- **`resize2fs -P` 在挂载态不可信（2026-09-09 实测）**：往文件系统写 100MB 后，挂载态下
  `resize2fs -P` 仍报最小 6366 blocks（26MB，脏页没落盘），卸载后才报 32041 blocks（128MB）。
  所以**不能靠它精确预判**缩容下限——预检用 `df` 的实际用量，真撞到下限就靠回滚兜底。
  缩到低于最小值时 `resize2fs` 报 `New size smaller than minimum (32041)` 并以非零码退出，
  **文件系统不被破坏**（实测随后重挂、数据完好），这也是「回滚」能安全收尾的前提。
- **存量迁移**：早期实例用一次性脚本
  [`apps/server/scripts/migrate-to-img.ts`](../apps/server/scripts/migrate-to-img.ts) 从 named volume 搬进 img
  文件系统（停容器 → `create` → `cp -a` + `chown 1000:1000` → 条目数校验 → 删旧容器，
  **旧卷保留**）。脚本完成使命后应删除，不是长期资产。
- **重审**：实例上百 / 宿主换 XFS / Docker 给出原生的每卷配额时。

## D19 · 升级 / 回滚：换镜像前给 `/data` 打快照

- **决策**：升级 = 换镜像（铁律 3），用户内容靠数据文件系统保留。为了「升级失败不丢数据」，
  `instance` 表新增 `previous_image`（**非空 = 有一份升级前的数据快照可回滚**）。快照本体在宿主上
  `<HOST_STORAGE_ROOT>/<slug>.img.prev`，**不进库、不算实例配额**；每实例只保留最近一份，
  下次升级覆盖。
- **权限**：**用户面**只能选平台**已发布**的版本（`image_release` 表，见 D21）∩ 宿主上已有；
  **管理面**可任选宿主上任意本地 tag（`setImage(id, image, { allowAny: true })`），仍限平台自己的镜像仓库。
- **准入四道**（`assertImageAllowed`）：引用合法（`ImageRefSchema`）→ 是平台自己的仓库
  （`imageRepo(image) === imageRepo(默认版本)`，挡住「换成别人的镜像」）→ 已发布列表
  （用户面，见 D21）/ 跳过（管理面 `allowAny`）→ **宿主上真的有**（`listImageTags()`）。
  最后一道必须过：否则 Docker 会去 registry 拉，控制面在私有网络里未必连得上，
  失败信息用户看不懂（会以为平台坏了）。
- **顺序与退路**（`provisioner.setImage`）：校验（什么都没碰）→ 停容器 → 快照 →
  落库（`image` = 新版、`previous_image` = 旧版、`containerId: null`）→ 重建。
  - 快照失败（多半宿主空间不够）：**不落库**，按原规格把实例恢复起来，抛 `ImageRejectedError`
    （「升级前打快照失败，实例未改动：…」）。数据一个字节没动。
  - 新镜像起不来：**自动回滚**——`restoreSnapshot` + 旧镜像重建，抛 `ImageUpgradeFailedError`；
    回滚也失败则标 `error` 并响亮报错。
  - 原本停着的实例只落库，新镜像等用户下次 `start` 生效。
  - 三种预期内失败统一走 `isImageFailure` → HTTP 400（实例面与管理面同一套语义）。
- **快照实现**：特权助手容器里 `cp --sparse=always`（宿主 GNU coreutils **9.1**，实测 4MB 零块
  → 目标 alloc=0）。所以快照实占 ≈ **已用字节**，不是配额大小；回滚用 `mv` 同目录 rename，
  **耗时与数据量无关**。停机时间 = 停容器 + 复制已用数据 + 启动（100MB 秒级，10GB 一两分钟）
  ——UI 上写清楚。
- **自动回滚的坑（自查发现）**：不能复用 `rollbackImage`——失败的 `restart` 已把 `status` 写成
  `error`，照当前行判断 `wasRunning` 就会**不重建**，实例留在「没容器」状态。改为私有
  `rollbackTo(id, previousImage, rebuild)`，由 `setImage` 传**升级前**的 `wasRunning`。
- **实测（2026-09-09，`pnpm check:storage` 21 项全通过）**：快照实占 9MB（配额 256MB，
  稀疏复制不按配额算）→ 改数据 → 回滚后内容回到快照那一刻 → 快照被消费（不能回滚第二次）
  → `mv` 后数据文件仍在。单测：`provisioner.test.ts` 19 例覆盖准入四道、升级落库与快照顺序、
  快照失败不落库、新镜像起不来自动回滚、停着只落库、回滚消费快照。
- **代价 / 待补**：① 快照吃宿主**真实**空间（≈ 已用字节）——D18 的「宿主容量告警」要把它算进去；
  ② 只有一层快照，再升级会覆盖上一份；③ 停机时间随数据量增长，用户面必须给预期（已写）；
  ④ `migrate-to-img.ts` 那类一次性脚本不属于长期资产，用一次就该删。
- **重审**：要支持多层快照、或宿主换成 LVM / btrfs 能做在线快照时。

## D20 · 首个管理员：seed 引导 + 管理台授予，ADMIN_EMAILS 退役

- **决策**：第一个管理员由一次性命令 `pnpm --filter @dsh-cloud/server db:seed` 建出——邮箱 / 密码来自
  `.env.local` 的 `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`，**只在「一个管理员都没有」时生效**，
  已有管理员就直接跳过。`ADMIN_EMAILS`（启动时按环境变量提权）整个删除。之后授予 / 撤销走管理台的
  `PATCH /api/admin/users/:id/role`，且**最后一名管理员不可降级**。
- **理由**：`ADMIN_EMAILS` 有三个毛病：① 只对**已存在**的账号提权，而「先配 env 再注册」是最自然的
  顺序 → 那次启动静默地什么都不做，无日志无报错；② 零管理员时自锁——`/admin` 全 403，唯一出路是
  手改 env 再重启进程；③ 只升不降，配置文件推断不出真实权限。seed 把「引导」和「管理」分开：
  引导是一次性的、显式的、幂等的（重跑无副作用，也是管理员被删光后的恢复路径），管理则长期留在
  管理台里——不必再造第二个管理入口（带参 CLI 的 create / promote / 重置密码会和界面重复，
  密码还会进 shell 历史与进程列表）。
- **备选**：setup 页面（首次访问引导，否——多一套「未初始化」状态机及它的绕过风险）；
  带参 CLI（否——与管理台重复）；保留 `ADMIN_EMAILS`（否——见上）。
- **代价**：① `user.role` 仍是唯一真相，但「谁是管理员」不再能从配置文件看出来，部署后要问数据库
  或管理台；② seed 不重置已存在账号的密码（那要 better-auth 内部 API），所以「只有一个管理员且
  忘了密码」目前无解，需要时再补重置流程；③ 最后一名管理员不可降级是个**不变量**，由 `app.ts` 里
  「查目标 → 数管理员 → 写」三步实现，两步之间有个极窄的并发窗口（两个管理员同时自降），
  单运营者场景不值得上事务。
- **重审**：出现多运营者并发操作、或需要「管理员自助重置密码」时。

## D21 · 镜像版本进库：`image_release` 表 + 管理台「镜像管理」页，运行时不再读镜像 env

- **决策**：「平台用哪个镜像」不再由 env 决定，改成 `image_release` 表是**唯一真相**：
  `ref`（完整镜像引用，唯一）/ `is_default` / `published_at`。
  - **运行时从库里取**：新建实例记「默认版本」那一行（`provisioner.create` → `findDefaultImageRelease`）；
    用户面能自助升到的版本 = 已发布 ∩ 宿主上真有；管理面仍可任选宿主上的平台仓库镜像（D19 不变）。
  - **管理台新增「镜像管理」页**：发布 / 下架 / 设为默认，对应 `/api/admin/images` 四条路由
    （ref 走 body——tag 里的 `:` 和 registry 里的 `/` 进 path 会被编码坑）。
  - **`db:seed` 只引导第一版**：版本表为空时用 `SEED_IMAGE`（缺省 `dsh-instance:0.1.0`）建一行并设为默认；
    非空就跳过。`SEED_IMAGE` 只被 seed 读，**不进 `src/env.ts`**（和 `SEED_ADMIN_*` 同档）。
    → **已被 D22 取消**：`SEED_IMAGE` 删除，
    `db:seed` 只管管理员；第一版的引导入口是管理台「镜像管理」页。
  - `INSTANCE_IMAGE` / `INSTANCE_STABLE_IMAGES` 两个 env 变量**删除**。
- **理由**：和 `ADMIN_EMAILS`（D20）是同一类毛病——**会变、且运行时被查询的状态，塞在启动时读一次的 env 里**。
  具体症状：① 换一版要改 env + 重启控制面；② `INSTANCE_STABLE_IMAGES` 默认空，实例建起来后用户面
  「换版本」下拉是空的，得有人想起来去填；③「哪个是默认版本」在 env 里只是个约定，数据库、管理台、
  实例行三处看不出关系。
- **「至多一个默认」由数据库兜住**：部分唯一索引 `unique index on (is_default) where is_default`
  （与 `instance_slug_unique` 同款写法），不靠应用层自觉。换默认走事务：先把旧的置 false，
  再把目标置 true——**顺序不能反**，否则撞索引。
- **默认版本不可下架**（400「默认版本不能下架，先把别的版本设为默认」）：否则表里可能一个默认都没有，
  新建实例就断了。一旦 seed 过，表里永远至少有一行、永远有默认。
- **发布的前置**：引用合法 → 与当前默认版本**同仓库**（仓库名从默认版本推）→ 宿主上真的有。
  表为空时不允许发布（400「先跑 db:seed」）——seed 是唯一引导入口，否则「哪个仓库是我们的」无从判断。
  → **已被 D22 修正**：仓库名改由配置 `INSTANCE_IMAGE_REPO` 给出，发布不再依赖表里已有行，
  空表可以直接发第一版。
- **运行时没有默认版本 → 响亮失败**：`create` 抛 `ImageRejectedError`（「平台还没有默认镜像版本：
  先跑 db:seed，或在「镜像管理」里指定」），`POST /api/instances` 映射成 400。**不**回退到某个 env
  默认值——静默用过期镜像比报错更糟。（文案里的 `db:seed` 已按 D22 改成「在「镜像管理」里发布一版
  并设为默认」；行为不变。）
- **备选**：继续用 env（否，见上）；拿 `instance` 表里最新一版当默认（否——「最新」和「平台认可」是两回事，
  灰度 / 回退需要一个显式指针）；已发布列表存成 JSON 一行（否——发布 / 下架 / 设默认都要读改写整行，
  并发下会丢更新）。
- **代价**：① 换镜像仓库（比如上新 registry）没有路径——得清空表重跑 seed；→ **已被 D22 解掉**
  （仓库是配置项，改 `INSTANCE_IMAGE_REPO` 即可）；② 下架不影响已在用该版本的
  实例（它保留自己的 `image`，只是不再出现在用户面列表里）；③「可发布候选」是库 ∩ 宿主两个来源，
  镜像在不在宿主上仍要问 Docker。→ **已被 D23 补上第三个来源**（注册表快照 `image_catalog`），
  三态在接口层派生。
- **重审**：要支持多 registry / 镜像 digest pin / 批量滚动升级时（tag 命名与 CI 已在 D22 定下；
  多 registry 仍待定）。

## D22 · 实例镜像：单版本源 + OCI label + CI 推公开 GHCR

- **决策**：镜像的来源做出来——可重复构建、可追溯、可分发。
  - **tag = `<dsh版本>_<修订号>`**，如 `0.1.2-rc.1_1`。`_` 是唯一无歧义的分隔符：上游 dsh 全是
    prerelease（实测 `0.1.0-rc.8` / `0.1.2-rc.1` / `0.1.5-alpha.2`，都含 `-` 和 `.`），而 `_` SemVer
    不允许、Docker tag 允许。修订号是**单调递增整数**，从 1 开始，不是第二套 semver。
  - **单一版本源** `docker/instance-image/VERSION`（一行）。本地 `build.sh` 和 CI 都从它读，
    tag 与装进去的 dsh 版本不可能漂。Dockerfile **删掉 `DSH_VERSION` 的默认值**，缺参数**响亮失败**
    （静默装一个过期版本比报错糟得多）；两条 `test` 断言（`dsh --version` / `pnpm --version` 等于传入值）
    是「tag 与内容一致」的机器校验。
  - **tag 不可重建**：CI 推送前 `HEAD /v2/<repo>/manifests/<tag>`，已存在就失败（「bump VERSION 的修订号」）。
  - **事实进 OCI label**：`org.opencontainers.image.*`（`version` = `<dsh版本>_<修订号>`、`source`、
    `revision` = git sha、`created`）+ `io.dsh-cloud.dsh.version` / `io.dsh-cloud.image.revision`。
    tag 给人看，label 给机器读——`docker inspect` 就能回答「这版里是哪个 dsh」。
  - **仓库** `ghcr.io/eskim2001/dsh-instance`（GitHub `eskim2001/dsh-cloud`），由
    `.github/workflows/instance-image.yml` 推送。触发**只有 `workflow_dispatch`**：tag 不可变，
    VERSION 是唯一旋钮，发布必须是「人 + 改修订号」的刻意动作。包**公开**，读不需要 PAT，
    但仍要走匿名 token 换取（`ghcr.io/token?scope=repository:...`），不是裸 GET。
  - **两个架构一个 tag**：`linux/amd64` 和 `linux/arm64` 各在**原生 runner** 上构建（公开仓库的
    ARM runner 免费），按 digest 推、两个都成功后再合成一个 manifest list 标签。**不用 QEMU**——
    否则 `node-pty` 这类原生模块要在模拟的 arm64 里编译，慢且容易出怪问题。任一架构失败就不建
    tag（宁可没有，不要一个只有单架构的 tag）。
  - **本地构建用同一个全名**（只是没推上去）：`.env.local` 里 `INSTANCE_IMAGE_REPO` 一个值同时管
    本地和线上，下一轮同步 / 发布不用换命名。
  - **平台仓库改成配置项 `INSTANCE_IMAGE_REPO`**，并**取消 `SEED_IMAGE` 与 seed 的镜像引导**（修正 D21）：
    空表本来就意味着「创建不了实例」（`create` 响亮失败），不需要 seed 来引导第一版；引导入口就是
    管理台「镜像管理」页。原先的发布守卫靠**默认版本**推「我们的仓库」，表空就无从判断——改成配置后
    空表也能发第一版。
  - 本轮 dsh 走 **npm 已发布版本**；从上游源码构建的变体是下一轮。
- **理由**：D21 把「平台用哪个镜像」挪进了库，但镜像本身还是手敲 tag 的本地构建——tag 不表达内容、
  「发布」只检查「宿主上有个同名镜像」，所以**发布 ≠ 可重复构建**。这里补的是来源：版本单源 +
  不可变 tag + 机器可读 label + CI 产出。`INSTANCE_IMAGE_REPO` 本来也是下一轮同步 GHCR 需要的
  （同步得知道列哪个 repo），顺手解掉 D21 代价①。
- **备选**：tag 用平台自己的版本号（否——平台没有版本号，且与 dsh 版本的关系会漂）；
  `-` / `.` 做分隔符（否——上游 prerelease 里就有，分不出边界）；`+` build metadata（否——Docker tag 非法）；
  跟随 npm dist-tag（否——`latest` / `next` 是可变指针，要跟不可变的版本号）；push 触发 CI（否——
  Dockerfile 一改要么撞守卫（红）、要么绕过守卫换 tag（漂））；私有包 + PAT（否——公开就能读，
  少一把要轮换的凭据）；单 job 加 QEMU 出多架构（否——原生模块在模拟架构里编译，慢且易出怪问题，
  公开仓库的 ARM runner 免费，没有理由模拟）。
- **代价**：① base 镜像（`node:24-*` / `caddy`）仍是可变 tag，所以才需要修订号——同 tag 不同天重建
  未必同字节；② 多架构要跑两台 runner、构建时间翻倍（换来的是发布产物在 Apple Silicon 上直接能拉，
  不必本地再建一份）；
  ③ DB 里存的仍是 `ref` 字符串而非 digest，回滚记录因此不是内容级可验证的；
  ④ GHCR 新建的包**默认私有**，首次推送后要手动改成 Public，否则匿名拉取 401；
  ⑤ 控制台侧（同步 GHCR 标签进库、三态状态机、手动「同步」按钮、「本地优先缺了自动 pull」）**未做**，
  必须先有真实 GHCR 标签。→ **已由 D23 解掉**（2026-09-10）。
- **重审**：要做源码变体 / base 镜像 digest pin 时。（「控制台同步落地」已由 D23 解掉。）

## D23 · 镜像目录：`image_catalog` 快照 + 派生三态 + SSE 下载 + 缺镜像自动 pull

- **决策**：把「注册表上有什么」变成控制台看得见的东西。
  - **新表 `image_catalog`**（`ref` PK / `digest` / `synced_at`）存**可丢弃快照**：同步时整批重建
    （upsert + `prune`，上游删掉的 tag 跟着消失）。`image_release` 不动，继续只表达「我们的发布决定」。
  - **三态派生、不落库**：在 `image_release` 里 = **已发布**；否则宿主上有 = **已下载**；否则在
    catalog 里 = **未下载**。宿主存在性是**运行时事实**（`docker rmi` / `prune` 随时会变），存库必漂；
    接口同时给 `onHost`，好看出「已发布但宿主上被删了」。
  - **tag 形状卡住**：`<dsh版本>_<修订号>`（`^[A-Za-z0-9][A-Za-z0-9.\-]*_[1-9][0-9]*$`）。包是公开的，
    任何 collaborator 都能推 `latest` 之类垃圾 tag，而 `ImageRefSchema` 只挡非法字符。同步被过滤掉的
    tag **报数量**（不静默），发布同样按形状准入。
  - **下载走 SSE**（`GET /api/admin/images/pull?ref=…`，GET 是因为 `EventSource` 只支持 GET）：
    `docker pull` 的流是**逐行 JSON**（不是容器日志那种多路复用帧，别 `demuxFrames`），失败是
    **HTTP 200 + 流内 `{"error":…}`**。沿用 `log-stream.ts` 的约定：鉴权 / 仓库 / 形状校验在 hijack
    之前（失败走 4xx），`x-accel-buffering: no`、15s 心跳、`end` 事件后客户端 `close()`。
    **打开拉取流失败也走流内 `error` 事件，不回 502**——`EventSource` 读不到非 200 响应的 body，
    回 502 前端只能显示一句没头没尾的「下载失败」，而真实原因（「manifest 没有 arm64」之类）恰恰
    是最该看见的。所以这条路由的 HTTP 状态**恒为 200**，失败信号只有 `error` 事件。
    鉴权后不查 catalog——管理员有权拉平台仓库里任何形状合法的 tag，包括刚推上来还没同步过的那版。
  - **发布语义不变**（仍要求宿主上已有）；「下载」按钮负责把「未下载」变成「已下载」。
  - **自动 pull 收在 `applyRuntime()` 一处**（create / restart / 换镜像全覆盖），进程内
    `Map<ref, Promise>` 去重。**先查本地再校验仓库**——仓库这道只该拦「真的要出网拉」的，
    D22 之前那些裸 tag 的实例镜像明明在宿主上，照它拒会连重启都做不到。`assertImageAllowed`
    第 4 道从「宿主上已有」放宽成「catalog ∪ 宿主」，免得 `setImage` 先打了数据快照、删了容器
    才在 pull 上失败。
  - **新建时可选版本**（`GET /api/images` 返回全部已发布版本，新建弹窗里是下拉；不选就用默认版本）：
    创建**不要求宿主上已有**（`assertImageAllowed(..., { requireLocal: false })`）——它没有停机窗口，
    `applyRuntime` 本来就会自动拉。这与升级的差别是有意的（见代价⑥）：升级在打完快照、删掉容器之后
    才发现要长 pull，窗口不可预期。用户面能选的仍只是**已发布**的版本，仓库 / tag 形状两道照旧。
  - **顺带补一个既有的洞**：`boot.ts` 启动时把 `provisioning` 的行标成 error（「平台重启中断了创建」）。
    `createInstanceRecord` 先写 `provisioning`，而对账器跳过非 running/stopped、启动恢复只拉 running——
    进程在创建中途崩掉就留下**永久僵尸行**。加了 pull 之后这个窗口从秒级变成分钟级，所以这轮补上。
- **理由**：D22 之后 GHCR 上有真实标签了，但控制台对上游一无所知——GHCR 上存在、宿主上没下载的版本
  完全看不见；「可发布」全靠宿主本地状态推断，没有 digest；实例镜像被 prune 掉之后 `restart` 直接
  `No such image`（遗留实例 `test` 就是这么坏的）。
- **备选**：给 `image_release` 加 `state` / `digest` 列（否——同步的删除语句必须豁免已发布行，
  漏一处就删掉默认版本，新建实例直接坏）；宿主存在性也落库（否——运行时事实，必漂）；三态存成一列
  （否——两个真相源）；下载走 POST + 轮询作业表（否——这一轮不值得引入作业表，代价见下）；
  下载走 WebSocket（否——已有 SSE 约定，`EventSource` 自带重连）。
- **代价**：① 控制面多了一条到 registry 的**出网依赖**（同步 + 匿名 token 换取都要出网，失败是 502
  而非内部错误）；② **没有作业表**——下载靠 SSE 连接活着，关掉页面不会取消 `docker pull`（docker 那头
  继续跑），也没有断点续传 / 取消按钮；进程内去重只在单进程成立；③ digest 是 **manifest list** 的
  digest（`Docker-Content-Digest`），不是单架构内容哈希，只用来展示 / 比对版本，别当一致性证明；
  ④ catalog 有 **TTL 语义**——页面必须显示「上次同步」，否则「未下载」可能只是没同步过；
  ⑤ 自动 pull 让 create / restart 的最坏耗时从秒级变成分钟级（正常路径是管理员先点「下载」）；
  ⑥ 用户面 `stable` 仍保持「已发布 ∩ 宿主已有」，**不**让用户升级触发长 pull。
- **重审**：要下载取消 / 断点续传 / 跨进程去重（引入作业表）时；要做 base 镜像 digest pin 或私有包
  凭据轮换时；上游 tag 命名规则变了时。


## D24 · 域名拆分：`BASE_DOMAIN` 退成父域，控制台搬到 `CONSOLE_DOMAIN`

- **决策**：把「父域」和「控制台自己的主机名」拆成两个变量，并给实例命名加上纵深防御。
  - **`BASE_DOMAIN` 是父域**（本地 `lvh.me`，生产 `xxxx.app`）：实例主机名 = `<slug>.<BASE_DOMAIN>`，
    会话 cookie 的 `Domain=.<BASE_DOMAIN>`。**新增 `CONSOLE_DOMAIN`**（本地 `console.lvh.me`）：
    它决定 better-auth 的 `baseURL`、`trustedOrigins` 和未登录时的跳转目标。
    `env.ts` 的 `superRefine` 断言 `CONSOLE_DOMAIN` 是 `BASE_DOMAIN` 的**子域**
    （父域本身不行——`<父域>` 那一层留给实例命名空间），配错起不来。
  - **保留字扩充 + 创建路径兜底**：`RESERVED_SLUGS` 按组扩到 80 条（平台自用 / 认证 / 基础设施 /
    环境 / 监控 / 常见服务词，含 `console`、`platform`）；创建处理器再显式拒绝
    「slug 等于 `CONSOLE_DOMAIN` 的首段」——控制台域名可以配成静态表之外的词。
  - **软删的 slug 绑定原 owner**：`createInstanceRecord` 事务里查同 slug 的**任意行**（含软删），
    属于别人就 `SlugTakenError`。partial unique index 不动，所以**同一 owner 仍可重建同名**，
    purge 之后彻底释放。
  - **优先级是显式的**：开发态控制台 router 设 `priority: 1000`；实例 router **不设** priority。
    这样即使有 slug 撞上控制台 label，控制台也稳赢，不依赖 Traefik「规则长度相同则行为未定义」。
  - **注册面测试**：`http/route-surface.test.ts` 把全部已注册 GET 路由钉在一份白名单上，
    新增 GET 必须过一次人工决定（铁律 6：漏挂认证不报错）。
- **理由**：原来 `BASE_DOMAIN` 一个变量同时当控制台主机名和实例后缀，于是控制台主机名
  （`platform.<base>`）落在实例命名空间里。任何登录用户建一个 slug = `platform` 的实例，就渲染出
  规则长度与 `platform-web` 完全相同的 router；Traefik 平手行为未定义，而 forward-auth 的未登录
  跳转又指向同一个主机——最坏是**控制台全站打不开 + 所有租户的所有实例一起不可用**，一次 API 调用
  即可触发。拆开之后两者不再共享主机名，抢注在结构上不可能；保留字和 priority 只是纵深防御。
  另一条理由是浏览器状态按域名归属（cookie / localStorage / service worker）：主机名回收给另一个
  租户就等于把上一个租户的浏览器状态继承过去，所以软删的 slug 必须继续绑定原 owner。
- **备选**：只加保留字、不拆变量（否——控制台域名是可配置的，静态表永远滞后，且语义仍然混着）；
  实例 slug 强制随机后缀（否——用户要自选、要可读，而且不解决「控制台占用根域」的结构问题）；
  cookie 改 host-only + 控制台签发短时 token（**另开一轮**，会动认证链路，见 OPEN-QUESTIONS）；
  入口剥 `Set-Cookie`（否——Traefik 的 `headers` 中间件只能整条删，会连 dsh 自己的会话 cookie
  一起删掉，做不到「只删带 `Domain=` 的」）。
- **代价**：① 控制台地址变了（本地 `platform.lvh.me` → `console.lvh.me`），书签要改一次；
  ② **所有实例容器必须重建**——`DSH_TRUSTED_HOSTS` 是建容器时写进环境的，不重建就是「页面能开、
  API 全 403」（迁移步骤见 SECURITY-HARDENING.md）；③ 本地 cookie 域从 `.platform.lvh.me` 放宽到
  `.lvh.me`（覆盖本机所有 `lvh.me` 子域；生产是注册域本身，无差异）；④ 保留 slug 会累积，
  跨 owner 不得复用，要彻底释放得走 purge；⑤ **Set-Cookie 投毒仍未解**：同注册域下实例响应能种
  `Domain=<base>` 的 cookie，利用前提是「同一浏览器先后访问两个租户的实例」，结构解另开一轮；
  ⑥ **保留字只挡新建，不追溯存量**：`RESERVED_SLUGS` 是**创建期命名政策**，只挂在创建输入上
  （`CreateBodySchema`）；`InstanceSlugSchema` 只管形状，库里已有的行一律放行。最初的实现把保留字
  也放进 `InstanceSlugSchema`，于是 `specOf` 对存量行再判一次——扩表会让 slug 恰好落进新表的实例
  **打不开（门上 404）也删不掉（purge 500）**，等于把租户锁在门外。现在存量保留字实例照常可访问、
  可启停、可删除，只是这个名字不能再被新建占用。
- **重审**：把门改成 host-only cookie + 控制台签发短时 token 时；入口换成能按域名过滤 `Set-Cookie`
  的方案时；控制台需要再拆出多个主机名（如 `admin.` / `api.`）时——那时该引入一张显式的
  「平台保留主机名」表，而不是继续往 `RESERVED_SLUGS` 里加词。

## D25 · 路由投影按**容器事实**裁决，失败收尾补投影一次

- **决策**：Traefik 投影的准入判据从 DB `status` 换成**容器的实时状态**
  （[`apps/server/src/instance/routes-sync.ts`](../apps/server/src/instance/routes-sync.ts) 的
  `routableInstanceSlugs`）：容器处于 `running` / `restarting` / `paused` 就投影，`exited` /
  `created` / `dead` 或**容器根本不在**就不投影。只有编排进行中（`provisioning` / `removing`）
  例外——这两个窗口里容器死活都不算数，一律不投影。`containerStates` **取不到**（Docker 抖了）
  时退回 DB 意图，并按失败即关闭处理：只投影 `status === 'running'` 的行。
  配套地，所有失败收尾（`InstanceProvisioner.failWith`）在写 `error` + `lastError` 之后
  **重新投影一次路由**，投影自身失败只告警、不覆盖原始错误。
- **理由**：D16 之后 `status` 只记**意图**，一次失败的操作就把它写成 `error`，而容器往往还好好地
  跑着。照意图投影的问题是**路由只减不增**：`remove` 的第一步就是「置 `removing` → 投影一次」
  把路由摘掉（有意如此，先摘再删容器），若后面某一步失败，catch 写 `error` 却不补投影，
  对账器又跳过 `error` 行——**再也没有任何人把这条路由加回来**。用户看到「实例突然 404」，
  真实原因却是「上一次操作失败了」，两码事，而且没有任何日志或告警把这两件事联系起来。
  改成按事实裁决后，这条链路自己就闭合了：容器还在 → 路由还在 → 用户照常打开；
  容器真没了 → 没路由 → 页面上的「启动」重建（`start` 有 `containerId === null` 的回落）。
- **备选**：① 只在 catch 里补一次投影、判据仍看 `status`（否——`status` 已经是 `error`，
  补投影等于什么都不做）；② 让对账器也处理 `error` 行（否——`error` 是「等用户决断」的落定态，
  对账器自动改写它会让失败原因一闪而过，用户看不到）；③ 把 `error` 从 DB 里拆成独立的
  「事实」列（否——Docker 已经是事实的真相，再存一份就是第三个可能过期的副本）。
- **代价**：① 投影前多一次 `docker ps -a`（和 D16 同一份开销，按 `dsh-instance-` 前缀过滤约 35ms），
  且**所有**改路由的路径（创建 / 启停 / 删除 / 对账）都要带上它；② 取不到 Docker 时路由会
  短暂变窄——这是有意的取向，宁可少投影一条（用户重试或下一轮对账修回来），也不要多投影一条
  绕过门的裸路由；③ 「DB 记 `stopped`、容器却真在跑」时会被投影（外部 `docker start` 或
  上一次 stop 停在中间），此时以事实为准是对的，DB 由 45 秒的对账收敛。
- **注意（有意的不一致）**：这样会让「列表里显示**错误**、实例却**打得开**」同时出现
  （列表状态走 `resolveRuntimeStatus`，`error` 是短路返回的意图）。这不是 bug：状态回答
  「需不需要你管」，路由回答「能不能连上」。UI 上的错误文案本来就要指向 `lastError` 里的原因，
  而不是暗示「已经不可用了」。
- **重审**：引入异步作业表 / 编排状态机时（那时「进行中」不再只有 `provisioning` / `removing`
  两个词，`IN_FLIGHT` 需要跟着状态机走）；或控制面变成多实例部署、投影需要跨进程协调时。

