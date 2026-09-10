<p align="center">
  <picture>
    <source media="(prefers-reduced-motion: reduce) and (prefers-color-scheme: dark)" srcset="apps/web/public/brand/dshcloud-lockup-dark.svg">
    <source media="(prefers-reduced-motion: reduce)" srcset="apps/web/public/brand/dshcloud-lockup.svg">
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/dshcloud-swim-dark.png">
    <img src="docs/assets/dshcloud-swim.png" alt="dshcloud" width="640">
  </picture>
</p>

<p align="center">
  A self-hosted or cloud-hosted, multi-tenant platform for deploying and hosting DeepSeek Harness (dsh) instances.
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

**dshcloud** adds account management, instance provisioning and access control to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). Each instance runs in its own Docker container, with a dedicated network, persistent data filesystem and resource limits. Users access their instances through an authenticated subdomain; operators manage accounts, capacity and instance versions from a web console.

> **Early development.** Use this project for evaluation and development. It is not production-ready; deployment validation and security work remain open. See [Security and Limitations](#security-and-limitations) before exposing it to the internet.

## Features

- **Instance management:** Create, start, stop, rebuild and delete instances. Per-user instance-count limits allow multiple instances within an assigned quota.
- **Resource controls:** CPU, memory and process limits, plus a hard capacity limit on each instance's `/data` filesystem. Administrators can adjust resource quotas after creation.
- **Authenticated access:** Per-instance subdomains behind Traefik, owner authorization and an instance-specific HMAC-derived gate token. Instance containers publish no host ports.
- **Persistent workspaces:** Workspace, configuration and installed user packages are directed to `/data`, which survives container rebuilds and image changes. Image changes take a pre-upgrade snapshot for rollback.
- **Operations:** Account bans, quota management, image selection, Docker-backed status, usage sampling and container log streaming. See the role boundaries below.
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
  <summary>Administration console</summary>
  <p>
    <a href="docs/screenshots/en/admin.png"><img src="docs/screenshots/en/admin.png" alt="Administration console" width="100%"></a>
  </p>
</details>

<details>
  <summary>Sign-in page</summary>
  <p>
    <a href="docs/screenshots/en/login.png"><img src="docs/screenshots/en/login.png" alt="Sign-in page" width="100%"></a>
  </p>
</details>

## Getting Started

Locally this uses `lvh.me`: `*.lvh.me` is public wildcard DNS that resolves to `127.0.0.1` everywhere, so no DNS configuration is needed and it cannot collide with anything holding `:53` such as Clash.

The Compose stacks in this repository target local development, not a production installation.

### Prerequisites

- Node.js 22 or later and pnpm 10.10.0, as specified in [package.json](package.json).
- Docker Desktop that can run Linux containers and ships Compose v2. The control plane connects to its daemon **at startup**, not only when creating instances.
- Host ports `80` / `443` / `3000` / `5173` / `55432` free.
- For instance storage, a Docker host with loop devices, ext4 and the host utilities used by the [storage helper](apps/server/src/instance/host-storage.ts). Storage operations require short-lived privileged helper containers. On Docker Desktop, this host is its Linux VM, not macOS.

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

On the "Images" page in the console, click "Sync" to pull GHCR tags into the catalog, then "Download" → "Publish" → "Set as default" for the version you want; missing images are pulled automatically when an instance is created. See [D23](docs/DECISIONS.md).

Build locally only if you changed `docker/instance-image/`:

```bash
./docker/instance-image/build.sh
```

The tag comes from [VERSION](docker/instance-image/VERSION) and reads `<dsh version>_<our revision>` (e.g. `0.1.2-rc.1_2`); local builds and CI use the same full name `ghcr.io/eskim2001/dsh-instance:<tag>`. See [D22](docs/DECISIONS.md).

Then create one on the "Instances" page and open it.

> For the ingress topology, why `lvh.me`, and the pitfalls (Clash PAC, restarting the container after ingress config changes), see the [local ingress guide](docker/compose/README.md).

## Architecture

```text
Browser
  |
  v
Traefik (TLS and routing)
  |-- Base domain ------> Web console / Fastify control plane
  |                                         |-- PostgreSQL
  |                                         |-- Docker API
  |
  `-- Instance subdomain -> Forward-auth (session + owner)
                          -> Per-instance network
                          -> Caddy gate -> dsh
                                             `-- /data
```

The control plane provisions containers, storage and routes. Traefik joins each instance's dedicated bridge network and reaches the instance without a published host port. After owner authorization, it forwards an instance-specific token that the in-container gate checks.

The backend uses Fastify, Drizzle and dockerode; the console uses Vite, React and shadcn/ui. Runtime specifications and the Docker renderer live in [packages/instance-spec](packages/instance-spec). See the [architecture document](docs/ARCHITECTURE.md) for the full design.

## Security and Limitations

**Treat every instance container as an untrusted code execution environment.** Running shell commands, installing dependencies and writing files inside an instance are expected behavior, not a security exception.

### Access and data boundaries

- **Instance owners** access their own `dsh`, workspace, usage metrics and logs. Being signed in is not enough to open someone else's instance.
- **Platform administrators** manage users, quotas and image versions, and can inspect instance status and container logs. The platform provides no administrator interface for reading or browsing users' `/data` content, and the instance ingress has no administrator bypass.
- **Usage visibility in the current implementation:** Live CPU/memory/disk usage and metric history are owner-only endpoints. The administrator console currently exposes resource allocations, not other users' live usage metrics; do not confuse quota with usage.
- **Logs are not private file storage:** Container output may contain user content or secrets. Administrator log access does not imply that logs are free of sensitive data.
- **Host access is a separate trust boundary:** A host or Docker operator can access underlying storage. Application-level restrictions are not encryption against the host operator. Keep platform secrets, database credentials and the Docker socket out of instance containers.
- **Session isolation:** The trusted ingress removes platform cookies after authorization while preserving instance cookies. Control-plane writes require an exact trusted `Origin`; the authentication plugin's native account-administration endpoints are disabled.

### Operational limits

- Containers run as non-root, drop Linux capabilities and use `no-new-privileges`, but still share the host kernel. This is not VM-level isolation. Outbound network access is currently unrestricted.
- The disk quota limits the `/data` filesystem, not all host storage. Container writable layers, logs and upgrade snapshots require separate host capacity planning.
- Image changes require downtime. Rollback restores both the previous image and its pre-upgrade data snapshot, discarding subsequent data changes. Only one pre-upgrade snapshot is retained per instance; it is not an independent backup.
- Deleting without purging retains data and its ownership record. Reusing the subdomain creates a separate filesystem; recovering retained data requires operator verification, not automatic adoption by name.
- Public deployment checks remain open, including network isolation and TLS/DNS configuration on the target host. See [open questions](docs/OPEN-QUESTIONS.md). The local stack and development credentials must not be treated as a hardened public deployment.
- Billing, independent backups, a full observability stack and multi-node runtimes are not included in the current implementation. Existing status reconciliation and usage sampling are not a substitute for these capabilities.

Report vulnerabilities according to [SECURITY.md](SECURITY.md). Do not disclose security issues in public issues.

## Development

Run the workspace checks from the repository root:

```bash
pnpm typecheck
pnpm test
```

Optional integration checks exercise Docker and host storage. Use a disposable development environment and review the scripts before running them:

```bash
pnpm --filter @dsh-cloud/server check:storage
pnpm --filter @dsh-cloud/server spike
```

Their implementations are [check-storage.ts](apps/server/scripts/check-storage.ts) and [spike-instance.ts](apps/server/scripts/spike-instance.ts). These scripts use the calling process environment; unlike `dev:local`, they do not explicitly load the server environment file.

Security integration tests create and clean up temporary PostgreSQL and Traefik containers without connecting to the application database. Docker and the local images `postgres:16-alpine` and `traefik:v3.5` are required:

```bash
pnpm --filter @dsh-cloud/server test:security
```

Existing installations must follow the [security migration notes](docs/SECURITY-HARDENING.md) before starting the updated server. The migration preserves existing storage paths; it does not move or erase instance data.

## Contributing

Bug reports, documentation improvements and focused pull requests are welcome. Include reproduction steps and your environment when reporting a bug. For changes to authentication, isolation or the data model, discuss the design and security implications before implementation.

Read [AGENTS.md](AGENTS.md) for repository conventions and development commands. Keep tests close to the behavior they cover, run the workspace checks, and update both README translations when changing shared documentation.

## Documentation

The detailed guides currently contain primarily Chinese text.

| Guide | Contents |
| --- | --- |
| [Architecture](docs/ARCHITECTURE.md) | Components, access control and isolation model |
| [Design decisions](docs/DECISIONS.md) | Technical choices and trade-offs |
| [Open questions](docs/OPEN-QUESTIONS.md) | Unresolved validation and known gaps |
| [Local ingress](docker/compose/README.md) | DNS, TLS and instance access in development |
| [Configuration](.env.example) | Server environment template |
| [Contributor guidance](AGENTS.md) | Repository layout, conventions and checks |
| [Security policy](SECURITY.md) | Vulnerability reporting and scope |

## License

dshcloud is licensed under the [MIT License](LICENSE). [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) is the upstream project; its code and other dependencies remain subject to their respective licenses.