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
  DB 的 `instances.status` 降级为**意图**（编排动作、对账器、路由投影仍读它）。
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
- **权限**：**用户面**只能选平台提供的稳定版——`INSTANCE_STABLE_IMAGES`（逗号分隔的精确 tag，
  平台回归过才写进去）∩ 宿主上已有；**管理面**可任选宿主上任意本地 tag
  （`setImage(id, image, { allowAny: true })`），仍限平台自己的镜像仓库。
- **准入四道**（`assertImageAllowed`）：引用合法（`ImageRefSchema`）→ 是平台自己的仓库
  （`imageRepo(image) === imageRepo(INSTANCE_IMAGE)`，挡住「换成别人的镜像」）→ 白名单
  （用户面）/ 跳过（管理面 `allowAny`）→ **宿主上真的有**（`listImageTags()`）。
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

