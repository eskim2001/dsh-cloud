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
  <b>在线演示</b> · <a href="https://console.demo.dshcloud.app/">console.demo.dshcloud.app</a><br>
  <sub>共享演示账号 <code>demo-user@dshcloud.app</code> · 密码 <code>demo-user</code></sub><br>
  <sub>工作空间直达 · <a href="https://demo-user.demo.dshcloud.app/">demo-user.demo.dshcloud.app</a></sub>
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

<table>
  <tr>
    <td align="center" width="50%">
      <a href="docs/screenshots/zh-CN/light/login.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/zh-CN/dark/login.png">
          <img src="docs/screenshots/zh-CN/light/login.png" alt="登录页：左侧黑曜石品牌区与鲸鱼动画，右侧登录表单" width="100%">
        </picture>
      </a>
      <br><sub>登录</sub>
    </td>
    <td align="center" width="50%">
      <a href="docs/screenshots/zh-CN/light/home.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/zh-CN/dark/home.png">
          <img src="docs/screenshots/zh-CN/light/home.png" alt="主页：继续工作、最近活动与快捷操作" width="100%">
        </picture>
      </a>
      <br><sub>主页</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <a href="docs/screenshots/zh-CN/light/workspaces.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/zh-CN/dark/workspaces.png">
          <img src="docs/screenshots/zh-CN/light/workspaces.png" alt="工作空间列表：每个工作空间的状态、规格与配额" width="100%">
        </picture>
      </a>
      <br><sub>工作空间</sub>
    </td>
    <td align="center" width="50%">
      <a href="docs/screenshots/zh-CN/light/workspace-new.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/zh-CN/dark/workspace-new.png">
          <img src="docs/screenshots/zh-CN/light/workspace-new.png" alt="创建工作空间：子域名、运行版本与资源规格" width="100%">
        </picture>
      </a>
      <br><sub>创建工作空间</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <a href="docs/screenshots/zh-CN/light/workspace.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/zh-CN/dark/workspace.png">
          <img src="docs/screenshots/zh-CN/light/workspace.png" alt="工作空间详情：状态、已用存储与运行版本" width="100%">
        </picture>
      </a>
      <br><sub>工作空间详情</sub>
    </td>
    <td align="center" width="50%">
      <a href="docs/screenshots/zh-CN/light/workspace-settings.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/zh-CN/dark/workspace-settings.png">
          <img src="docs/screenshots/zh-CN/light/workspace-settings.png" alt="工作空间设置：存储配额、版本升级与容器日志" width="100%">
        </picture>
      </a>
      <br><sub>工作空间设置</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <a href="docs/screenshots/zh-CN/light/admin.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/zh-CN/dark/admin.png">
          <img src="docs/screenshots/zh-CN/light/admin.png" alt="平台管理 · 概览：工作空间数、用户数与已统计存储" width="100%">
        </picture>
      </a>
      <br><sub>平台管理 · 概览</sub>
    </td>
    <td align="center" width="50%">
      <a href="docs/screenshots/zh-CN/light/admin-instances.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/zh-CN/dark/admin-instances.png">
          <img src="docs/screenshots/zh-CN/light/admin-instances.png" alt="平台管理 · 全部工作空间：搜索、过滤、配额与容器日志" width="100%">
        </picture>
      </a>
      <br><sub>平台管理 · 全部工作空间</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <a href="docs/screenshots/zh-CN/light/admin-versions.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/zh-CN/dark/admin-versions.png">
          <img src="docs/screenshots/zh-CN/light/admin-versions.png" alt="平台管理 · 版本管理：版本目录、默认版本与预热到本机" width="100%">
        </picture>
      </a>
      <br><sub>平台管理 · 版本管理</sub>
    </td>
    <td align="center" width="50%">
      <a href="docs/screenshots/zh-CN/light/admin-users.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/zh-CN/dark/admin-users.png">
          <img src="docs/screenshots/zh-CN/light/admin-users.png" alt="平台管理 · 用户：角色、每人的工作空间上限与封禁" width="100%">
        </picture>
      </a>
      <br><sub>平台管理 · 用户</sub>
    </td>
  </tr>
</table>

## 快速开始

### 部署到自己的服务器

一台 Linux 主机，装了 Docker（含 Compose v2），`80` / `443` 空闲，另有一块能给硬配额的盘。

```bash
curl -fsSL https://raw.githubusercontent.com/eskim2001/dshcloud/main/scripts/install.sh | bash
```

<details>
<summary>更多配置</summary>

完整列表见脚本的 `--help`：

| 参数 | 省略时 |
|---|---|
| `--version <tag>` | 用 `latest`（**会漂移**；装到的 digest 记在 `/opt/dsh-cloud/.installed-version`） |
| `--wizard-port <端口>` | 从 `3000` 起试 `3000-3003`，取第一台空闲的 |
| `--pool-root <路径>` | `/var/lib/dsh` |
| `--pool-size-mb <MB>` | 取所在文件系统可用空间的 80% |


引导页填的是**父域**：控制台落在 `console.<父域>`，每个工作空间各占 `<子域>.<父域>`。证书按主机逐个签发，所以泛解析 `*.<父域>` 必须先指向这台机器，否则签不下来。


**前置条件**

- Linux 主机（x86-64 或 arm64），装有 Docker 与 Compose v2。
- **一块能给硬配额的盘**：`HOST_STORAGE_ROOT`（默认 `/var/lib/dsh`）要么在以 `pquota` 挂载的 XFS 上，要么让脚本建一块 loopback XFS 镜像（要 root，并把挂载写进 `fstab`）。两条都做不到会拒绝安装。见 [D18](docs/DECISIONS.md)。
- 端口 `80`、`443` 空闲：入口直接绑它们，其中 `80` 还要留给 ACME 的 HTTP-01 校验。
- 宿主能访问 GHCR（拉平台镜像与工作空间镜像）。

**升级**（保留数据与密钥）：

```bash
curl -fsSL "https://raw.githubusercontent.com/eskim2001/dshcloud/main/scripts/install.sh" | bash -s -- update
```

**卸载**（默认保留数据库卷与存储池；加 `--purge` 连数据一起删，不可恢复）：

```bash
curl -fsSL "https://raw.githubusercontent.com/eskim2001/dshcloud/main/scripts/install.sh" | bash -s -- uninstall
```

</details>

> 项目处于早期开发阶段：部署验证与安全工作仍有未决项，公网部署前请先读[架构与安全模型](docs/ARCHITECTURE.md)里的权限边界与运行限制（§五、§八）。

### 本地开发

改代码用这条。前置：Node.js 22+ 与 pnpm 10.10.0，以及带 Compose v2 的 Docker。

```bash
pnpm install
```

```bash
pnpm dev
```

## 参与贡献

欢迎提交问题报告、文档改进和范围明确的 pull request。报告缺陷时，请附上复现步骤和环境信息。涉及认证、隔离或数据模型的改动，请在实现前讨论其设计与安全影响。

本地开发流程和仓库约定见 [AGENTS.md](AGENTS.md)。测试应与其覆盖的行为位于同一目录，提交前请运行工作区检查。修改 README 的共用内容时，请同步更新中英文版本；修改控制台界面后，请运行 `node scripts/readme-shots.mjs` 重新生成截图，确保截图与当前界面保持一致。

## 文档

详细指南目前主要使用中文。

| 指南 | 内容 |
| --- | --- |
| [架构](docs/ARCHITECTURE.md) | 组件、隔离模型、权限边界与运行限制 |
| [部署](docker/platform/README.md) | 平台镜像、生产拓扑、控制面的权限边界 |
| [存储选型与实测](docs/storage/README.md) | 给容器一块有硬上限的盘：四条路的实测数据、开发机怎么退化 |
| [设计决策](docs/DECISIONS.md) | 技术选择与取舍 |
| [待验证问题](docs/OPEN-QUESTIONS.md) | 未决验证与已知缺口 |
| [本地入口](docker/compose/README.md) | 开发环境中的 DNS、TLS 与工作空间访问 |
| [配置](.env.example) | 控制面环境变量模板 |
| [贡献者指南](AGENTS.md) | 本地开发、仓库结构与约定 |
| [安全策略](SECURITY.md) | 漏洞报告方式与范围 |

## 许可

dshcloud 使用 [MIT 许可证](LICENSE)。[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 为上游项目，其代码及其他依赖分别遵循各自的许可证。