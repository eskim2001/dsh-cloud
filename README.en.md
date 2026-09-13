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

### Home

<p>
  <a href="docs/screenshots/en/home.png"><img src="docs/screenshots/en/home.png" alt="Home: recent workspaces, quick actions and recent activity" width="100%"></a>
</p>

### Workspaces

<p>
  <a href="docs/screenshots/en/workspaces.png"><img src="docs/screenshots/en/workspaces.png" alt="Workspace list" width="100%"></a>
</p>

### Workspace details

<p>
  <a href="docs/screenshots/en/workspace.png"><img src="docs/screenshots/en/workspace.png" alt="Workspace details, files entry and version" width="100%"></a>
</p>

<details>
  <summary>Administration · Overview</summary>
  <p>
    <a href="docs/screenshots/en/admin.png"><img src="docs/screenshots/en/admin.png" alt="Administration · Overview" width="100%"></a>
  </p>
</details>

<details>
  <summary>Administration · All workspaces</summary>
  <p>
    <a href="docs/screenshots/en/admin-instances.png"><img src="docs/screenshots/en/admin-instances.png" alt="Administration · All workspaces" width="100%"></a>
  </p>
</details>

<details>
  <summary>Administration · Users</summary>
  <p>
    <a href="docs/screenshots/en/admin-users.png"><img src="docs/screenshots/en/admin-users.png" alt="Administration · Users" width="100%"></a>
  </p>
</details>

## Getting Started

### Prerequisites

- Node.js 22+ and pnpm 10.10.0; see [package.json](package.json).
- Docker Desktop with Linux container support and Compose v2. The control plane connects to the Docker daemon at startup.
- Host ports `80`, `443`, `3000`, `5173`, `55432` free.
- Hard disk quotas need the host on XFS mounted with `pquota`. Otherwise the platform mounts a loopback XFS image, which requires `CAP_SYS_ADMIN`; if neither works it refuses to start. macOS and Docker Desktop support neither, so quotas are not enforced in development and the console shows "no limit". Workspace data lives under `HOST_STORAGE_ROOT`, `~/dsh-data` by default with `pnpm dev`. See [D18](docs/DECISIONS.md).

### Run it

From the repository root:

```bash
pnpm install
```

```bash
pnpm dev
```

Open `https://console.lvh.me` and sign in with `admin@lvh.me` / `dsh-cloud-dev`.

`pnpm dev` runs: preflight (dependencies, ports, Docker daemon) → generate `apps/server/.env.local` (validated only if it already exists) → start PostgreSQL and the ingress ([docker/compose/local.yml](docker/compose/local.yml)) → migrate the database and create the first administrator → start the server and console, then print the URL.

`Ctrl-C` stops the server and console; the ingress and PostgreSQL keep running, so the next start is fast. To stop them too:

```bash
pnpm dev:down
```

To reset the local environment (drops the database, regenerates secrets):

```bash
docker compose -f docker/compose/local.yml down -v
```

Then delete `apps/server/.env.local`.

### Local ingress and certificates

Everything local goes through `*.lvh.me`, which resolves to `127.0.0.1` everywhere, so there is nothing to add to your hosts file. The cost is HTTPS only, and the repository ships no trusted certificate: Traefik uses its built-in `CN=TRAEFIK DEFAULT CERT`, so the browser shows a certificate warning — select "Advanced → Proceed". For a green lock, issue a certificate with a SAN covering `DNS:lvh.me,DNS:*.lvh.me` and add it to the system trust store. See [D26](docs/DECISIONS.md).

### Create a workspace

You land on **Home** after signing in: recently used workspaces on top, quick actions and recent activity below.

On the "Versions" page, select "Check for updates" to sync the versions available in GHCR, then publish the ones you need (and set a default). To let **users** upgrade to a version, first "Pre-warm on this host" — the upgrade picker lists only versions cached locally. Workspace creation is not subject to this; the platform pulls what it needs. See [D23](docs/DECISIONS.md).

Build locally only if you changed `docker/instance-image/`:

```bash
./docker/instance-image/build.sh
```

The tag comes from [VERSION](docker/instance-image/VERSION) and follows `<dsh version>_<revision>` (for example, `0.1.2-rc.1_2`). Local and CI builds produce the same image name: `ghcr.io/eskim2001/dsh-instance:<tag>`. See [D22](docs/DECISIONS.md).

With a version configured, create a workspace on the "Workspaces" page and open it from its details page.

> For the ingress topology, the trade-offs of `lvh.me`, and issues such as Clash PAC or needing to restart the container after ingress config changes, see the [local ingress guide](docker/compose/README.md).

## Contributing

Bug reports, documentation improvements and narrowly scoped pull requests are welcome. Include reproduction steps and environment details when reporting a bug. For changes to authentication, isolation or the data model, discuss the design and security implications before implementation.

See [AGENTS.md](AGENTS.md) for the local development workflow and repository conventions. Keep tests next to the behavior they cover and run the workspace checks before submitting changes. Update both README translations when changing shared documentation. After modifying the console UI, run `node scripts/readme-shots.mjs` to regenerate screenshots and keep them consistent with the current interface.

## Documentation

The detailed guides currently contain primarily Chinese text.

| Guide | Contents |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Components, isolation model, permission boundaries and operational limits |
| [Storage selection & measurements](docs/storage/README.md) | Giving a container a disk with a hard limit: the four options, measured, and how dev machines degrade |
| [Design decisions](docs/DECISIONS.md) | Technical choices and trade-offs |
| [Open questions](docs/OPEN-QUESTIONS.md) | Unresolved validation and known gaps |
| [Local ingress](docker/compose/README.md) | DNS, TLS and workspace access in development |
| [Configuration](.env.example) | Server environment template |
| [Contributor guidance](AGENTS.md) | Local development, repository layout and conventions |
| [Security policy](SECURITY.md) | Vulnerability reporting and scope |

## License

dshcloud is licensed under the [MIT License](LICENSE). [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is the upstream project; its code and other dependencies remain subject to their respective licenses.