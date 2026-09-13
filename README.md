<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce) and (prefers-color-scheme: dark)" srcset="apps/web/public/brand/dshcloud-lockup-dark.svg">
    <source media="(prefers-reduced-motion: reduce)" srcset="apps/web/public/brand/dshcloud-lockup.svg">
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/dshcloud-swim-dark.png">
    <img src="docs/assets/dshcloud-swim.png" alt="dshcloud" width="640">
  </picture>
</p>

<p align="center">
  <b>DeepSeek Harness 的自托管多用户运行平台</b><br>
  <sub>A self-hosted, multi-user platform for DeepSeek Harness.</sub>
</p>

<p align="center">
  <b>简体中文</b> · <a href="README.en.md">English</a>
</p>

<p align="center">
  <a href="#功能">功能</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#文档">文档</a> ·
  <a href="#参与贡献">参与贡献</a>
</p>

**dshcloud** 在自有基础设施上为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）提供相互隔离的工作空间，并统一管理身份认证、资源配额和运行版本。用户可通过浏览器访问工作空间；工作空间数据独立持久化，升级运行版本时，文件、会话、插件和配置均保持不变。

管理员完成平台部署后，可通过邀请链接添加用户。每位用户均可在授权配额内创建和管理多个工作空间。

> **项目处于早期开发阶段。** 当前适合评估与开发，尚不具备生产可用性；部署验证和安全工作仍有未决项。部署至公网前，请先阅读[架构与安全模型](docs/ARCHITECTURE.md)中的权限边界与运行限制。

## 与本地运行的区别

| 本地运行 dsh | 使用 dshcloud |
| --- | --- |
| 依赖本地设备持续运行 | 在自有服务器上持续运行 |
| 访问范围受本地设备限制 | 可通过浏览器从多个设备访问 |
| 缺少用户间的资源与数据隔离 | **多用户：** 为每位用户提供独立工作空间 |
| 多项目需要维护多套安装 | **多工作空间：** 支持单个用户创建多个工作空间 |
| 升级可能需要重新配置环境 | 通过镜像升级，并保留持久化数据 |

## 功能

- **工作空间：** 支持创建、启动、停止、重建和删除。每个工作空间拥有独立容器与持久化存储，并可分别设置 CPU、内存、进程数和磁盘容量限制。
- **多用户：** 管理员通过邀请链接添加用户。用户仅可访问和管理其所属工作空间。
- **访问控制：** 工作空间端口仅发布至宿主回环地址；外部访问须通过 Traefik 前置认证、所有者校验和工作空间级签名验证。
- **版本管理：** 从 GHCR 同步版本目录，支持版本发布和默认版本设置。升级通过替换镜像完成，并在升级前自动创建可用于回滚的数据快照。
- **管理台：** 账号状态、资源配额、用量采样、工作空间日志流。
- **界面：** 英文与简体中文、明暗主题、⌘K 命令面板。

## 截图

### 主页

<p>
  <a href="docs/screenshots/zh-CN/home.png"><img src="docs/screenshots/zh-CN/home.png" alt="主页：最近的工作空间、快捷操作与最近活动" width="100%"></a>
</p>

### 工作空间

<p>
  <a href="docs/screenshots/zh-CN/workspaces.png"><img src="docs/screenshots/zh-CN/workspaces.png" alt="工作空间列表" width="100%"></a>
</p>

### 工作空间详情

<p>
  <a href="docs/screenshots/zh-CN/workspace.png"><img src="docs/screenshots/zh-CN/workspace.png" alt="工作空间详情、文件入口与版本" width="100%"></a>
</p>

<details>
  <summary>平台管理 · 概览</summary>
  <p>
    <a href="docs/screenshots/zh-CN/admin.png"><img src="docs/screenshots/zh-CN/admin.png" alt="平台管理 · 概览" width="100%"></a>
  </p>
</details>

<details>
  <summary>平台管理 · 全部工作空间</summary>
  <p>
    <a href="docs/screenshots/zh-CN/admin-instances.png"><img src="docs/screenshots/zh-CN/admin-instances.png" alt="平台管理 · 全部工作空间" width="100%"></a>
  </p>
</details>

<details>
  <summary>平台管理 · 用户</summary>
  <p>
    <a href="docs/screenshots/zh-CN/admin-users.png"><img src="docs/screenshots/zh-CN/admin-users.png" alt="平台管理 · 用户" width="100%"></a>
  </p>
</details>

## 快速开始

### 前置条件

- Node.js 22+，pnpm 10.10.0。版本见 [package.json](package.json)。
- Docker Desktop，能跑 Linux 容器，带 Compose v2。控制面启动时就要连 Docker daemon。
- 端口 `80`、`443`、`3000`、`5173`、`55432` 空闲。
- 磁盘硬配额要求宿主是挂载了 `pquota` 的 XFS。不是的话，平台会挂一个 loopback XFS 镜像（需 `CAP_SYS_ADMIN`）；两样都不行就拒绝启动。macOS 和 Docker Desktop 不支持，所以本地不强制配额，界面写「无上限」。工作空间数据放在 `HOST_STORAGE_ROOT`，`pnpm dev` 默认 `~/dsh-data`。见 [D18](docs/DECISIONS.md)。

### 启动开发环境

在仓库根目录：

```bash
pnpm install
```

```bash
pnpm dev
```

打开 `https://console.lvh.me`，用 `admin@lvh.me` / `dsh-cloud-dev` 登录。

`pnpm dev` 依次做：预检依赖、端口、Docker daemon → 生成 `apps/server/.env.local`（已存在就只校验，不改）→ 起 PostgreSQL 和入口服务（[docker/compose/local.yml](docker/compose/local.yml)）→ 迁移数据库、建首个管理员 → 起控制面和管理台，就绪后打印地址。

`Ctrl-C` 只停控制面和管理台，入口服务和 PostgreSQL 留着，下次秒起。要一起停：

```bash
pnpm dev:down
```

重置本地环境（清空数据库、重发 secret）：

```bash
docker compose -f docker/compose/local.yml down -v
```

再删 `apps/server/.env.local`。

### 本地入口与证书

本地走 `*.lvh.me`，全网解析到 `127.0.0.1`，不用改 hosts。代价是只能走 HTTPS，而仓库不给受信任的证书：Traefik 用自带的 `CN=TRAEFIK DEFAULT CERT`，浏览器会报红锁，点「高级 → 继续访问」即可。想绿锁就自己签一张 SAN 覆盖 `DNS:lvh.me,DNS:*.lvh.me` 的证书装进系统信任库。见 [D26](docs/DECISIONS.md)。

### 创建工作空间

登录后落在「主页」：最近用过的空间在最上面，下面是快捷操作和最近活动。

在「版本管理」页点「检查更新」，同步 GHCR 的可用版本，再发布需要的版本（可设为默认）。要让**用户**能升级到某个版本，得先把它「预热到本机」——用户端的升级列表只列本机已缓存的版本；创建工作空间不受此限，平台会自己拉。见 [D23](docs/DECISIONS.md)。

只有改了 `docker/instance-image/` 才需要本地构建：

```bash
./docker/instance-image/build.sh
```

tag 由 [VERSION](docker/instance-image/VERSION) 决定，格式 `<dsh版本>_<修订号>`（如 `0.1.2-rc.1_2`）。本地和 CI 构建出的镜像名一致：`ghcr.io/eskim2001/dsh-instance:<tag>`。见 [D22](docs/DECISIONS.md)。

配好版本后，在「工作空间」页创建工作空间，建好后从详情页直接在浏览器打开。

> 入口拓扑、`lvh.me` 的取舍，以及 Clash PAC、改完入口配置要重启容器这类问题，见[本地入口指南](docker/compose/README.md)。

## 参与贡献

欢迎提交问题报告、文档改进和范围明确的 pull request。报告缺陷时，请附上复现步骤和环境信息。涉及认证、隔离或数据模型的改动，请在实现前讨论其设计与安全影响。

本地开发流程和仓库约定见 [AGENTS.md](AGENTS.md)。测试应与其覆盖的行为位于同一目录，提交前请运行工作区检查。修改 README 的共用内容时，请同步更新中英文版本；修改控制台界面后，请运行 `node scripts/readme-shots.mjs` 重新生成截图，确保截图与当前界面保持一致。

## 文档

详细指南目前主要使用中文。

| 指南 | 内容 |
| --- | --- |
| [架构](docs/ARCHITECTURE.md) | 组件、隔离模型、权限边界与运行限制 |
| [存储选型与实测](docs/storage/README.md) | 给容器一块有硬上限的盘：四条路的实测数据、开发机怎么退化 |
| [设计决策](docs/DECISIONS.md) | 技术选择与取舍 |
| [待验证问题](docs/OPEN-QUESTIONS.md) | 未决验证与已知缺口 |
| [本地入口](docker/compose/README.md) | 开发环境中的 DNS、TLS 与工作空间访问 |
| [配置](.env.example) | 控制面环境变量模板 |
| [贡献者指南](AGENTS.md) | 本地开发、仓库结构与约定 |
| [安全策略](SECURITY.md) | 漏洞报告方式与范围 |

## 许可

dshcloud 使用 [MIT 许可证](LICENSE)。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 为上游项目，其代码及其他依赖分别遵循各自的许可证。