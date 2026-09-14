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

### Deploy to your own server

A Linux host with Docker (Compose v2), ports `80` / `443` free, and a disk that can enforce a quota.

```bash
curl -fsSL https://raw.githubusercontent.com/eskim2001/dsh-cloud/v0.1.3/scripts/install.sh | sudo bash
```

(Drop `sudo` if you are already root -- many VPS providers hand you a root shell, and those images often do not ship `sudo` at all.)

The script runs, in order: preflight (environment, ports, storage capability) → provision the storage pool → start PostgreSQL → migrate the database → create the first administrator → start the control plane and ingress. It ends by printing the console URL and an administrator password **shown once**. It asks for a domain and an administrator email along the way; answering is enough, and installing without a domain works too.

For bring-your-own certificates, upgrades and rollbacks, and **why it is expected for the control plane to hold the Docker socket and `CAP_SYS_ADMIN`**, see the [deployment guide](docker/platform/README.md).

<details>
<summary>Options, prerequisites, checksum, upgrade and uninstall</summary>

**Options** — all of them can be omitted; the defaults are below (`--help` lists the rest):

| Option | If omitted |
|---|---|
| `--domain <parent>` | No domain → **bootstrap**: the script prints a `http://<ip>/setup?token=...` link to enter it in a browser |
| `--admin-email <email>` | Asked interactively |
| `--email <email>` | No certificate expiry notices (certificates are still issued) |
| `--version <tag>` | Uses `latest` (**which moves**; the digest actually pulled is recorded in `/opt/dsh-cloud/.installed-version`) |
| `--non-interactive` | Never asks; every value must come from an option (for automation) |

`--domain` is the **parent** domain: the console lives at `console.<parent>` and every workspace takes a subdomain of its own. Certificates are issued per host (one for the console, one per workspace), so no DNS provider API is involved — but the wildcard record `*.<parent>` must point at this machine, or certificates cannot be issued.

Without a domain the platform runs in **bootstrap** mode: it serves **only** that one page (guarded by a one-time token; no other API is mounted). Submitting the domain closes the entry point immediately, and the console then lives at `console.<the parent you entered>`. See [D36](docs/DECISIONS.md).

**Prerequisites**

- A Linux host (x86-64 or arm64) with Docker and Compose v2.
- **Storage that can enforce a hard quota**: `HOST_STORAGE_ROOT` (default `/var/lib/dsh`) must either sit on XFS mounted with `pquota`, or the script creates a loopback XFS image for it (needs root, and writes the mount into `fstab`). If neither is possible the install **refuses to proceed** — once storage is pooled, a quota that merely looks enforced is worse than none. See [D18](docs/DECISIONS.md).
- Ports `80` and `443` free: the ingress binds them directly, and `80` is also needed for the ACME HTTP-01 check.
- Host access to GHCR (both the platform image and workspace images come from there).

**Read the script before running it**: replace `| sudo bash` with `-o install.sh`. Its URL is pinned to a tag, so the contents never change; to verify, compute the SHA-256 on both sides and compare:

```bash
curl -fsSL "https://raw.githubusercontent.com/eskim2001/dsh-cloud/v0.1.3/scripts/install.sh" | sha256sum
```

```bash
git show v0.1.3:scripts/install.sh | sha256sum
```

**Upgrade** (keeps data and secrets):

```bash
curl -fsSL "https://raw.githubusercontent.com/eskim2001/dsh-cloud/v0.1.4/scripts/install.sh" | sudo bash -s -- update --version 0.1.4
```

**Uninstall** (keeps the database volume and storage pool; add `--purge` to delete data irrecoverably):

```bash
curl -fsSL "https://raw.githubusercontent.com/eskim2001/dsh-cloud/v0.1.3/scripts/install.sh" | sudo bash -s -- uninstall
```

</details>

> The project is in early development: deployment verification and security work still have open items. Before exposing it to the internet, read the hardening checklist and permission boundaries in the [architecture and security model](docs/ARCHITECTURE.md).

### Local development

Use this path when changing code. Prerequisites: Node.js 22+ and pnpm 10.10.0, plus Docker Desktop with Compose v2.

```bash
pnpm install
```

```bash
pnpm dev
```

One command brings up everything: preflight → generate `apps/server/.env.local` → start PostgreSQL and the ingress ([local.yml](docker/compose/local.yml)) → migrate → create the administrator → start the server and console. Open `https://console.lvh.me` and sign in with `admin@lvh.me` / `dsh-cloud-dev`.

`Ctrl-C` stops the server and console; `pnpm dev:down` stops the ingress and PostgreSQL (add `-v` to drop the database too). Repository layout and conventions are in [AGENTS.md](AGENTS.md); local DNS, TLS and common failures are in the [local ingress guide](docker/compose/README.md).

### Create a workspace

You land on **Home** after signing in: recently used workspaces on top, quick actions and recent activity below.

On the "Versions" page, select "Check for updates" to sync the versions available in GHCR, then publish the ones you need (and set a default). To let **users** upgrade to a version, first "Pre-warm on this host" — the upgrade picker lists only versions cached locally. Workspace creation is not subject to this; the platform pulls what it needs. See [D23](docs/DECISIONS.md).

Build locally only if you changed `docker/instance-image/`:

```bash
./docker/instance-image/build.sh
```

The tag comes from [VERSION](docker/instance-image/VERSION) and follows `<dsh version>_<revision>` (for example, `0.1.2-rc.1_2`). Local and CI builds produce the same image name: `ghcr.io/eskim2001/dsh-instance:<tag>`. See [D22](docs/DECISIONS.md).

With a version configured, create a workspace on the "Workspaces" page and open it from its details page.

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