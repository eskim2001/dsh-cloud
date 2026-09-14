<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce) and (prefers-color-scheme: dark)" srcset="apps/web/public/brand/dshcloud-lockup-dark.svg">
    <source media="(prefers-reduced-motion: reduce)" srcset="apps/web/public/brand/dshcloud-lockup.svg">
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/dshcloud-swim-dark.png">
    <img src="docs/assets/dshcloud-swim.png" alt="dshcloud" width="640">
  </picture>
</p>

<p align="center">
  <b>A self-hosted, multi-user platform for DeepSeek Harness</b>
</p>

<p align="center">
  <a href="README.md">简体中文</a> · <b>English</b>
</p>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#getting-started">Getting Started</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="#contributing">Contributing</a>
</p>

**dshcloud** provides isolated workspaces for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) on infrastructure you control, with centralized authentication, resource quotas and version management. Users can access their workspaces through a browser. Workspace data is persisted independently, so files, sessions, plugins and configuration remain intact across version upgrades.

After deploying the platform, administrators can add users through invitation links. Each user can create and manage multiple workspaces within their assigned quota.

> **Early development.** Use this project for evaluation and development. It is not production-ready; deployment validation and security work remain open. See the permission boundaries and operational limits in the [architecture and security model](docs/ARCHITECTURE.md) before exposing it to the internet.

## Local dsh vs. dshcloud

| Running dsh locally | On dshcloud |
| --- | --- |
| Depends on the local device remaining available | Runs continuously on infrastructure you control |
| Access is limited by the local device | Accessible through a browser from multiple devices |
| No resource or data isolation between users | **Multi-user:** each user receives isolated workspaces |
| Multiple projects require separate installations | **Multiple workspaces:** each user can create several workspaces |
| Upgrades may require environment reconfiguration | Image-based upgrades preserve persistent data |

## Features

- **Workspaces:** create, start, stop, rebuild and delete workspaces. Each workspace has an independent container and persistent storage, with configurable limits for CPU, memory, process count and disk capacity.
- **Multi-user:** administrators add users through invitation links. Users can access and manage only their assigned workspaces.
- **Access control:** workspace ports are published only to the host loopback interface. External access requires Traefik authentication, an ownership check and per-workspace signature validation.
- **Version management:** synchronize the version catalog from GHCR, publish versions and configure the default version. Upgrades replace the image and create a rollback-capable data snapshot beforehand.
- **Console:** account status, resource quotas, usage sampling and workspace log streaming.
- **Interface:** English and Simplified Chinese, light and dark themes, ⌘K command menu.

## Screenshots

<table>
  <tr>
    <td align="center" width="50%">
      <a href="docs/screenshots/en/light/login.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/dark/login.png">
          <img src="docs/screenshots/en/light/login.png" alt="Sign-in page: obsidian brand pane with the whale animation on the left, form on the right" width="100%">
        </picture>
      </a>
      <br><sub>Sign in</sub>
    </td>
    <td align="center" width="50%">
      <a href="docs/screenshots/en/light/home.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/dark/home.png">
          <img src="docs/screenshots/en/light/home.png" alt="Home: continue working, recent activity and quick actions" width="100%">
        </picture>
      </a>
      <br><sub>Home</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <a href="docs/screenshots/en/light/workspaces.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/dark/workspaces.png">
          <img src="docs/screenshots/en/light/workspaces.png" alt="Workspace list: status, spec and quota for each workspace" width="100%">
        </picture>
      </a>
      <br><sub>Workspaces</sub>
    </td>
    <td align="center" width="50%">
      <a href="docs/screenshots/en/light/workspace-new.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/dark/workspace-new.png">
          <img src="docs/screenshots/en/light/workspace-new.png" alt="Create workspace: subdomain, version and resource sizing" width="100%">
        </picture>
      </a>
      <br><sub>Create workspace</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <a href="docs/screenshots/en/light/workspace.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/dark/workspace.png">
          <img src="docs/screenshots/en/light/workspace.png" alt="Workspace details: status, storage used and running version" width="100%">
        </picture>
      </a>
      <br><sub>Workspace details</sub>
    </td>
    <td align="center" width="50%">
      <a href="docs/screenshots/en/light/workspace-settings.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/dark/workspace-settings.png">
          <img src="docs/screenshots/en/light/workspace-settings.png" alt="Workspace settings: storage quota, version upgrade and container logs" width="100%">
        </picture>
      </a>
      <br><sub>Workspace settings</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <a href="docs/screenshots/en/light/admin.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/dark/admin.png">
          <img src="docs/screenshots/en/light/admin.png" alt="Administration · Overview: workspaces, users and measured storage" width="100%">
        </picture>
      </a>
      <br><sub>Administration · Overview</sub>
    </td>
    <td align="center" width="50%">
      <a href="docs/screenshots/en/light/admin-instances.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/dark/admin-instances.png">
          <img src="docs/screenshots/en/light/admin-instances.png" alt="Administration · All workspaces: search, filters, quotas and container logs" width="100%">
        </picture>
      </a>
      <br><sub>Administration · All workspaces</sub>
    </td>
  </tr>
  <tr>
    <td align="center" width="50%">
      <a href="docs/screenshots/en/light/admin-versions.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/dark/admin-versions.png">
          <img src="docs/screenshots/en/light/admin-versions.png" alt="Administration · Versions: version catalogue, default version and host pre-warming" width="100%">
        </picture>
      </a>
      <br><sub>Administration · Versions</sub>
    </td>
    <td align="center" width="50%">
      <a href="docs/screenshots/en/light/admin-users.png">
        <picture>
          <source media="(prefers-color-scheme: dark)" srcset="docs/screenshots/en/dark/admin-users.png">
          <img src="docs/screenshots/en/light/admin-users.png" alt="Administration · Users: roles, per-user workspace limits and bans" width="100%">
        </picture>
      </a>
      <br><sub>Administration · Users</sub>
    </td>
  </tr>
</table>

## Getting Started

### Deploy to your own server

A Linux host with Docker (Compose v2), ports `80` / `443` free, and a disk that can enforce a quota.

```bash
curl -fsSL https://raw.githubusercontent.com/eskim2001/dsh-cloud/v0.1.10/scripts/install.sh | sudo bash
```

(Drop `sudo` if you are already root.)

<details>
<summary>More options</summary>

The full list is in the script's `--help`:

| Option | If omitted |
|---|---|
| `--version <tag>` | Uses `latest` (**which moves**; the digest actually pulled is recorded in `/opt/dsh-cloud/.installed-version`) |
| `--wizard-port <port>` | Tries `3000-3003` and takes the first free one |
| `--pool-root <path>` | `/var/lib/dsh` |
| `--pool-size-mb <MB>` | 80% of the free space on that filesystem |

The page takes the **parent** domain: the console lives at `console.<parent>` and every workspace takes a subdomain of its own. Certificates are issued per host, so the wildcard record `*.<parent>` must point at this machine first.

**Prerequisites**

- A Linux host (x86-64 or arm64) with Docker and Compose v2.
- **Storage that can enforce a hard quota**: `HOST_STORAGE_ROOT` (default `/var/lib/dsh`) must either sit on XFS mounted with `pquota`, or the script creates a loopback XFS image for it (needs root, and writes the mount into `fstab`). If neither is possible the install refuses to proceed. See [D18](docs/DECISIONS.md).
- Ports `80` and `443` free: the ingress binds them directly, and `80` is also needed for the ACME HTTP-01 check.
- Host access to GHCR (both the platform image and workspace images come from there).

**Upgrade** (keeps data and secrets):

```bash
curl -fsSL "https://raw.githubusercontent.com/eskim2001/dsh-cloud/v0.1.10/scripts/install.sh" | sudo bash -s -- update --version 0.1.10
```

**Uninstall** (keeps the database volume and storage pool; add `--purge` to delete data irrecoverably):

```bash
curl -fsSL "https://raw.githubusercontent.com/eskim2001/dsh-cloud/v0.1.10/scripts/install.sh" | sudo bash -s -- uninstall
```

</details>

> The project is in early development: deployment verification and security work still have open items. Before exposing it to the internet, read the hardening checklist and permission boundaries in the [architecture and security model](docs/ARCHITECTURE.md).

### Local development

Use this path when changing code. Prerequisites: Node.js 22+ and pnpm 10.10.0, plus Docker with Compose v2.

```bash
pnpm install
```

```bash
pnpm dev
```

## Contributing

Bug reports, documentation improvements and narrowly scoped pull requests are welcome. Include reproduction steps and environment details when reporting a bug. For changes to authentication, isolation or the data model, discuss the design and security implications before implementation.

See [AGENTS.md](AGENTS.md) for the local development workflow and repository conventions. Keep tests next to the behavior they cover and run the workspace checks before submitting changes. Update both README translations when changing shared documentation. After modifying the console UI, run `node scripts/readme-shots.mjs` to regenerate screenshots and keep them consistent with the current interface.

## Documentation

The detailed guides currently contain primarily Chinese text.

| Guide | Contents |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Components, isolation model, permission boundaries and operational limits |
| [Deployment](docker/platform/README.md) | Platform image, production topology, the control plane's permission boundaries |
| [Storage selection & measurements](docs/storage/README.md) | Giving a container a disk with a hard limit: the four options, measured, and how dev machines degrade |
| [Design decisions](docs/DECISIONS.md) | Technical choices and trade-offs |
| [Open questions](docs/OPEN-QUESTIONS.md) | Unresolved validation and known gaps |
| [Local ingress](docker/compose/README.md) | DNS, TLS and workspace access in development |
| [Configuration](.env.example) | Server environment template |
| [Contributor guidance](AGENTS.md) | Local development, repository layout and conventions |
| [Security policy](SECURITY.md) | Vulnerability reporting and scope |

## License

dshcloud is licensed under the [MIT License](LICENSE). [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is the upstream project; its code and other dependencies remain subject to their respective licenses.