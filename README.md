# Confluence

Browser-based video conferencing with live collaboration — video calling, screen
sharing, file transfer, and a shared whiteboard. No downloads, no plugins.

Built in phases. **Phase 0 (foundation) is complete**; see [ARCHITECTURE.md](ARCHITECTURE.md)
for the design and [the phase plan](#phase-plan) for what is next.

## Prerequisites

| Tool           | Version | Notes                                                  |
| -------------- | ------- | ------------------------------------------------------ |
| Node.js        | >= 24   | `.nvmrc` pins 24                                       |
| pnpm           | >= 12   | `npm i -g pnpm`                                        |
| Docker Desktop | latest  | WSL2 backend; required for Postgres, Redis, and coturn |

## Quick start

```bash
git clone <repo> && cd confluence
cp .env.example .env          # dev defaults work as-is
pnpm install
pnpm infra:up                 # postgres, redis, coturn (containers)
pnpm db:generate              # generate the Prisma client
pnpm db:migrate               # apply migrations
pnpm dev                      # api on :4000, web on :5173 (on the host)
```

To run **everything** in containers instead, production-style (API built and
run from `dist/`, web served by nginx):

```bash
pnpm stack:up                 # builds api + web images, starts all 5 services
```

Both modes publish ports 4000 and 5173 for the app, so run `pnpm dev` or
`pnpm stack:up`, not both.

Open http://localhost:5173. The page shows a live health panel; both
dependencies should read **up**.

Verify the API directly:

```bash
curl localhost:4000/livez     # 200 {"status":"ok"} — liveness, no dependencies
curl localhost:4000/healthz   # 200 when healthy, 503 when a dependency is down
```

## Commands

| Command                                                     | Does                                                      |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| `pnpm dev`                                                  | Run every workspace in watch mode                         |
| `pnpm build`                                                | Typecheck and build all workspaces                        |
| `pnpm typecheck`                                            | Typecheck without emitting                                |
| `pnpm lint` / `pnpm lint:fix`                               | ESLint across the monorepo                                |
| `pnpm format` / `pnpm format:check`                         | Prettier                                                  |
| `pnpm test`                                                 | Vitest                                                    |
| `pnpm db:migrate` / `db:generate` / `db:seed` / `db:studio` | Prisma                                                    |
| `pnpm infra:up`                                             | Start Postgres, Redis, coturn only (pair with `pnpm dev`) |
| `pnpm stack:up`                                             | Build and start all five services in containers           |
| `pnpm infra:down` / `infra:logs` / `infra:ps`               | Stop, tail logs, list services                            |
| `pnpm infra:nuke`                                           | Stop services **and delete volumes**                      |

## Layout

```
apps/api        Express + Socket.IO server
apps/web        React client
packages/shared Zod schemas, socket event contract — imported by both
packages/crypto libsodium helpers (E2E encryption, Phase 7)
infra           Docker Compose, coturn, Dockerfiles
```

`packages/shared` is the single source of truth for anything crossing the wire.
An event name or payload shape is defined there first, then implemented on both
sides, so the two can never drift.

## Phase plan

| Phase | Scope                                                      | Status  |
| ----- | ---------------------------------------------------------- | ------- |
| 0     | Monorepo, Docker, Prisma, health checks                    | ✅ done |
| 1     | Auth: Argon2id, JWT, refresh rotation with reuse detection | next    |
| 2     | Rooms, presence, signaling backbone                        |         |
| 3     | Mesh WebRTC video calling                                  |         |
| 4     | Screen sharing                                             |         |
| 5     | File sharing (P2P DataChannel + encrypted object storage)  |         |
| 6     | Collaborative whiteboard                                   |         |
| 7     | E2E encryption and security hardening                      |         |
| 8     | Reconnection, quality indicators, a11y, theming            |         |

## Troubleshooting

**Docker fails with `read-only file system` or `Wsl/Service/CreateInstance/E_FAIL`**
— almost always a full host drive. Docker Desktop's virtual disk grows on
demand; when the host has no room, writes fail and Linux remounts the disk
read-only. Free space, or move the disk image (Settings → Resources →
Advanced → Disk image location) to a roomier drive, then restart Docker.
If a build then fails with `EOF while parsing` a `package.json`, the crash
left a corrupted build cache: run `docker builder prune -af`.

**`ERR_PNPM_IGNORED_BUILDS`** — pnpm 12 blocks dependency lifecycle scripts.
The allowlist is `allowBuilds` in `pnpm-workspace.yaml` (renamed from
`onlyBuiltDependencies`; the `package.json` `"pnpm"` field is no longer read).

**`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`** — a dependency was published within
the last 24h. This is a deliberate supply-chain guard, not a bug: pin a slightly
older version rather than lowering `minimumReleaseAge`.

**`/healthz` returns 503** — expected when Postgres or Redis is down. The body
names which one and why. Run `pnpm infra:up`.
