# Security Policy

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Use GitHub's private
vulnerability reporting: go to the **Security** tab of this repository and click
**Report a vulnerability**. That opens a private advisory visible only to the
maintainers.

Include what you did, what happened, and what you expected. A proof of concept —
commands, a request, or a short script — is worth more than a description.

## What is in scope

The interesting failures for this project are the ones that break a boundary:

- **Cross-instance reachability** — reaching another instance's container, network, files or credentials from inside one instance (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §四).
- **Authentication or authorization bypass** — reaching an instance's `dsh` without going through platform auth, or reaching someone else's instance while logged in as yourself.
- **Gate token forgery or leak** — making an instance container accept a request that did not come through the platform ingress, or obtaining the per-instance gate token.
- **Escalation through the privileged component** — the storage pool is enforced with XFS project quotas (see [D18](docs/DECISIONS.md), implemented in `apps/server/src/instance/pool.ts`), and setting a quota needs `CAP_SYS_ADMIN`. In the deployed topology the **control plane itself** is that privileged component: it holds `cap_add: [SYS_ADMIN]` **and** the Docker socket, which together are host root (see [D35](docs/DECISIONS.md) — this adds no trust surface over the socket alone, but it is worth stating plainly). Anything that lets an **instance** influence a quota or pool operation, or makes the control plane touch a path outside `<HOST_STORAGE_ROOT>/<key>`, is a serious bug. Note there is no separate privileged helper container: the `nsenter` helper this section used to describe was never part of the shipped design.
- **Platform credential exposure** — leaking `PLATFORM_SECRET` / `BETTER_AUTH_SECRET`, or getting a shared credential into a tenant container.

## What is *not* a vulnerability

- **Code execution inside your own instance.** An instance container runs an agent harness; it can spawn processes, run shell commands and write files by design. That is the product, not a bug.
- **Reading your own `/data`.** Your instance, your data.
- **The shared kernel.** Containers share the host kernel, so a kernel or runc escape is a cross-instance problem by definition. This is a known, documented limitation — [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §四 explains the trade-off and the microVM path out. A concrete, working escape is still very much in scope.
- **The instance being able to reach the internet.** Outbound access is currently unrestricted and deliberate; outbound policy is a roadmap item.
- **Missing rate limits, missing 2FA, missing audit log.** Real gaps, but features rather than vulnerabilities — open an issue.

## Supported versions

The project is pre-1.0: only the latest commit on `main` is supported. Fixes are not backported.
