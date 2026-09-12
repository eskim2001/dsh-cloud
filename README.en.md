<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce) and (prefers-color-scheme: dark)" srcset="apps/web/public/brand/dshcloud-lockup-dark.svg">
    <source media="(prefers-reduced-motion: reduce)" srcset="apps/web/public/brand/dshcloud-lockup.svg">
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/dshcloud-swim-dark.png">
    <img src="docs/assets/dshcloud-swim.png" alt="dshcloud" width="640">
  </picture>
</p>

<p align="center">
  <b>DSH as a Service</b> — a self-hosted or cloud-hosted, multi-tenant platform for deploying and hosting DeepSeek Harness (dsh) instances.
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

**dshcloud** adds account management, instance provisioning and access control to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). Each instance runs in its own Docker container, with a dedicated network, persistent data volume and resource limits. Users access their instances through an authenticated subdomain; operators manage accounts, capacity and instance versions from a web console.

> **Early development.** Use this project for evaluation and development. It is not production-ready; deployment validation and security work remain open. See the permission boundaries and operational limits in the [architecture and security model](docs/ARCHITECTURE.md) before exposing it to the internet.

## Features

- **Instance management:** Create, start, stop, rebuild and delete instances. Per-user instance-count limits allow multiple instances within an assigned quota.
- **Resource controls:** CPU, memory and process limits, plus a hard capacity limit on each instance's `/data` filesystem. Administrators can adjust resource quotas after creation.
- **Authenticated access:** Per-instance subdomains behind Traefik, owner authorization and an instance-specific HMAC-derived gate token. Instances publish ports on the host loopback only, never on a public interface.
- **Persistent workspaces:** Workspace, configuration and installed user packages all live under `/data` — its own subdirectory in the storage pool, under an XFS project quota — so they survive instance rebuilds and image changes. Image changes take a pre-upgrade snapshot for rollback.
- **Operations:** Account bans, quota management, version publishing, runtime-backed status, usage sampling and instance log streaming. See the role boundaries below.
- **Bilingual console:** English and Simplified Chinese, light and dark themes, email/password sign-in and session management.

## Screenshots

### Instance list

<p>
  <a href="docs/screenshots/en/instances.png"><img src="docs/screenshots/en/instances.png" alt="Instance list" width="100%"></a>
</p>

### Instance details

<p>
  <a href="docs/screenshots/en/instance.png"><img src="docs/screenshots/en/instance.png" alt="Instance details, version and upgrade" width="100%"></a>
</p>

<details>
  <summary>Administration · All instances</summary>
  <p>
    <a href="docs/screenshots/en/admin-instances.png"><img src="docs/screenshots/en/admin-instances.png" alt="Administration · All instances" width="100%"></a>
  </p>
</details>

<details>
  <summary>Administration · Users</summary>
  <p>
    <a href="docs/screenshots/en/admin-users.png"><img src="docs/screenshots/en/admin-users.png" alt="Administration · Users" width="100%"></a>
  </p>
</details>

## Getting Started

Locally this uses `lvh.me`: `*.lvh.me` is public wildcard DNS that resolves to `127.0.0.1` everywhere, so no DNS configuration is needed and it cannot collide with anything holding `:53` such as Clash.

The Compose stacks in this repository target local development, not a production installation.

### Prerequisites

- Node.js 22 or later and pnpm 10.10.0, as specified in [package.json](package.json).
- Docker Desktop that can run Linux containers and ships Compose v2. The control plane connects to its daemon **at startup**, not only when creating instances.
- Host ports `80` / `443` / `3000` / `5173` / `55432` free.
- **A hard disk quota needs the host filesystem to provide it:** instance data lives under `HOST_STORAGE_ROOT` (`pnpm dev` uses `~/dsh-data`). On Linux it must be **XFS mounted with `pquota`**; if it is not XFS the platform builds its own loopback XFS image and mounts it (needs `CAP_SYS_ADMIN`), and if neither works it **refuses to start**. macOS / Docker Desktop kernels ship without quota support → it degrades to "not enforced plus a warning" and the console labels quotas as "no limit". See [D18](docs/DECISIONS.md).

### Run it

From the repository root:

```bash
pnpm install
```

```bash
pnpm dev
```

Open `https://console.lvh.me` and sign in with `admin@lvh.me` / `dsh-cloud-dev`.

`pnpm dev` does the following in order, and stops with a clear reason if any step fails:

1. Preflight: dependencies, ports, Docker daemon.
2. Generate `apps/server/.env.local` (if it already exists it is only validated, never modified) — both secrets are generated randomly and never printed.
3. Start Postgres and the ingress ([docker/compose/local.yml](docker/compose/local.yml)) and wait until Postgres really accepts connections.
4. Run migrations and create the first administrator.
5. Start the server (reloads on code changes) and the console, and print the URL only once the console is up.

Ctrl-C stops the server and the console but **leaves the ingress and Postgres running**, so the next `pnpm dev` is instant. To stop them:

```bash
pnpm dev:down
```

To start completely fresh (drop the database, regenerate secrets):

```bash
docker compose -f docker/compose/local.yml down -v
```

then delete `apps/server/.env.local`.

### The browser certificate warning is expected

Traefik has no certificate configured, so it falls back to its built-in default self-signed certificate (`CN=TRAEFIK DEFAULT CERT`) and the browser shows a red lock — click "Advanced → Proceed". Rationale in [D26](docs/DECISIONS.md). For a green lock, sign a certificate whose SAN covers `DNS:lvh.me,DNS:*.lvh.me` and add it to your system trust store; the repository does not include this step.

### Create an instance

On the "Versions" page click "Check for updates" to read GHCR tags into the catalog, then "Publish" the version you want and "Set as default" if needed. For **users to be able to upgrade** to a version you must also "Pre-warm on this host" — the upgrade picker only lists versions already cached locally (rationale in [D23](docs/DECISIONS.md)); **creating an instance is not affected**, missing images are pulled automatically.

Build locally only if you changed `docker/instance-image/`:

```bash
./docker/instance-image/build.sh
```

The tag comes from [VERSION](docker/instance-image/VERSION) and reads `<dsh version>_<our revision>` (e.g. `0.1.2-rc.1_2`); local builds and CI use the same full name `ghcr.io/eskim2001/dsh-instance:<tag>`. See [D22](docs/DECISIONS.md).

Then create one on the "Instances" page and open it.

> For the ingress topology, why `lvh.me`, and the pitfalls (Clash PAC, restarting the container after ingress config changes), see the [local ingress guide](docker/compose/README.md).

## Contributing

Bug reports, documentation improvements and focused pull requests are welcome. Include reproduction steps and your environment when reporting a bug. For changes to authentication, isolation or the data model, discuss the design and security implications before implementation.

Read [AGENTS.md](AGENTS.md) for local development and repository conventions. Keep tests close to the behavior they cover, run the workspace checks, and update both README translations when changing shared documentation; after changing console UI, re-run `node scripts/readme-shots.mjs` so the screenshots do not age faster than the code.

## Documentation

The detailed guides currently contain primarily Chinese text.

| Guide | Contents |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Components, isolation model, permission boundaries and operational limits |
| [Storage selection & measurements](docs/storage/README.md) | Giving a container a disk with a hard limit: the four options, measured, and how dev machines degrade |
| [Design decisions](docs/DECISIONS.md) | Technical choices and trade-offs |
| [Open questions](docs/OPEN-QUESTIONS.md) | Unresolved validation and known gaps |
| [Local ingress](docker/compose/README.md) | DNS, TLS and instance access in development |
| [Configuration](.env.example) | Server environment template |
| [Contributor guidance](AGENTS.md) | Local development, repository layout and conventions |
| [Security policy](SECURITY.md) | Vulnerability reporting and scope |

## License

dshcloud is licensed under the [MIT License](LICENSE). [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is the upstream project; its code and other dependencies remain subject to their respective licenses.