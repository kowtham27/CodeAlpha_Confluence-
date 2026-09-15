# Confluence

Browser-based video conferencing with live collaboration — video calling, screen
sharing, file transfer, and a shared whiteboard. No downloads, no plugins.

Built in phases. **Phases 0–7 are complete**: foundation, accounts and
sessions, rooms and presence, multi-party video calling, screen sharing, file
sharing, a whiteboard and chat (all three end-to-end encrypted), and security
hardening; see [ARCHITECTURE.md](ARCHITECTURE.md) for the design,
[SECURITY.md](SECURITY.md) for the security model, and
[the phase plan](#phase-plan) for what is next.

## Prerequisites

| Tool           | Version | Notes                                                                  |
| -------------- | ------- | ---------------------------------------------------------------------- |
| Node.js        | >= 24   | `.nvmrc` pins 24                                                       |
| pnpm           | >= 12   | `npm i -g pnpm`                                                        |
| Docker Desktop | latest  | WSL2 backend; runs Postgres, Redis, MinIO, coturn, and Mailpit locally |

## Quick start

```bash
git clone <repo> && cd confluence
cp .env.example .env          # dev defaults work as-is
pnpm install
pnpm infra:up                 # postgres, redis, minio, coturn, mailpit (containers)
pnpm db:generate              # generate the Prisma client
pnpm db:migrate               # apply migrations
pnpm dev                      # api on :4000, web on :5173 (on the host)
```

Open http://localhost:5173 and create an account. Registration sends a
verification email; in development every email lands in **Mailpit** at
http://localhost:8025 instead of a real inbox. Open it, click the link, and
sign in. "Forgot password?" on the sign-in page works the same way.

To try a meeting, create a room on the home page and open its invite link in
a second browser (or a private window) signed in as another account. Allow
camera and microphone when asked, and you are in a video call: mute, camera
off, device switching, and presenting your screen are in the control bar, and
the tile of whoever is talking is highlighted.

**Whiteboard** (in the room's header) opens a shared canvas: pen, shapes,
text and eraser, with everyone's cursor and strokes appearing live. It is
encrypted with the same room key as files, kept for latecomers, and can be
saved as a PNG. Undo is Ctrl+Z; tools have single-key shortcuts (P, L, A, R,
O, T, E).

**Chat** (in the room's header) is end-to-end encrypted too. Under
"Compare safety codes" each person's key fingerprint is shown: read yours out
and check theirs to be sure nobody, not even the server, is in the middle.

**Files** (in the room's header) shares files two ways: kept in the room for 7
days, encrypted in your browser before upload so the server only ever stores
ciphertext, or sent directly to the people in the call over WebRTC, never
stored at all. Encrypted files land in the local **MinIO** bucket; its console
is at http://localhost:9001 (credentials: `S3_ACCESS_KEY` / `S3_SECRET_KEY`
from `.env`) if you want to see for yourself that the stored objects are
unreadable.

Two tabs on one machine prove the app works, but not the network: for a real
test, join from a second device on the same Wi-Fi, which also exercises the
TURN relay's fallback path. Browsers only allow camera access on `localhost` or
HTTPS, so another device needs the app served over HTTPS (or a tunnel).

To run **everything** in containers instead, production-style (API built and
run from `dist/`, web served by nginx):

```bash
pnpm stack:up                 # builds api + web images, starts all services
```

Both modes publish ports 4000 and 5173 for the app, so run `pnpm dev` or
`pnpm stack:up`, not both.

## Testing

| Command                                                        | What it runs                                           | Needs           |
| -------------------------------------------------------------- | ------------------------------------------------------ | --------------- |
| `pnpm --filter @confluence/api test`                           | Unit + integration tests (Vitest)                      | `pnpm infra:up` |
| `pnpm --filter @confluence/api exec vitest run --project unit` | Unit tests only                                        | nothing         |
| `pnpm --filter @confluence/web test`                           | Web unit tests (file-type sniffing, board geometry)    | nothing         |
| `pnpm --filter @confluence/crypto test`                        | Crypto package tests (libsodium)                       | nothing         |
| `pnpm test:e2e`                                                | Browser tests (Playwright, Chromium) of the full flows | `pnpm infra:up` |

Integration tests use a separate `confluence_test` database (created and
migrated automatically), Redis logical DB 15, and a separate
`confluence-files-test` bucket in the local MinIO, so they never touch dev data.
End-to-end tests read real emails out of Mailpit and start the dev servers if
they are not already running. Each run first clears the local rate-limit
counters (`rl:*` keys only, localhost only): every simulated person is
127.0.0.1, so between them they exceed the per-IP registration and request
limits meant for one real client. `security.spec.ts` checks the production
CSP, so it skips against the dev server; run the suite against `pnpm stack:up`
to include it. First run only: `pnpm --filter @confluence/web exec playwright install chromium`.

## Commands

| Command                                                     | Does                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| `pnpm dev`                                                  | Run every workspace in watch mode                               |
| `pnpm build`                                                | Typecheck and build all workspaces                              |
| `pnpm typecheck`                                            | Typecheck without emitting                                      |
| `pnpm lint` / `pnpm lint:fix`                               | ESLint across the monorepo                                      |
| `pnpm format` / `pnpm format:check`                         | Prettier                                                        |
| `pnpm test` / `pnpm test:e2e`                               | Vitest / Playwright                                             |
| `pnpm db:migrate` / `db:generate` / `db:seed` / `db:studio` | Prisma                                                          |
| `pnpm infra:up`                                             | Start Postgres, Redis, MinIO, coturn, Mailpit (pair with `dev`) |
| `pnpm stack:up`                                             | Build and start every service in containers                     |
| `pnpm infra:down` / `infra:logs` / `infra:ps`               | Stop, tail logs, list services                                  |
| `pnpm infra:nuke`                                           | Stop services **and delete volumes**                            |

## Layout

```
apps/api        Express + Socket.IO server
apps/web        React client (+ e2e/ Playwright tests)
packages/shared Zod schemas, socket event contract — imported by both
packages/crypto libsodium helpers: user keys, room keys, file encryption
infra           Docker Compose, one multi-target Dockerfile, coturn, nginx
```

`packages/shared` is the single source of truth for anything crossing the wire.
An event name or payload shape is defined there first, then implemented on both
sides, so the two can never drift.

## Phase plan

| Phase | Scope                                                                                     | Status  |
| ----- | ----------------------------------------------------------------------------------------- | ------- |
| 0     | Monorepo, Docker, Prisma, health checks                                                   | ✅ done |
| 1     | Accounts, email verification, password reset, rotating sessions, rate limits, socket auth | ✅ done |
| 2     | Rooms, presence, signaling backbone                                                       | ✅ done |
| 3     | Mesh WebRTC video calling                                                                 | ✅ done |
| 4     | Screen sharing                                                                            | ✅ done |
| 5     | File sharing (P2P DataChannel + encrypted object storage)                                 | ✅ done |
| 6     | Collaborative whiteboard                                                                  | ✅ done |
| 7     | E2E encryption and security hardening                                                     | ✅ done |
| 8     | Reconnection, quality indicators, a11y, theming                                           | next    |

## Troubleshooting

**Docker fails with `read-only file system` or `Wsl/Service/CreateInstance/E_FAIL`**
— almost always a full host drive. Docker Desktop's virtual disk grows on
demand; when the host has no room, writes fail and Linux remounts the disk
read-only. Free space, or move the disk image (Settings → Resources →
Advanced → Disk image location) to a roomier drive, then restart Docker.
If a build then fails with `EOF while parsing` a `package.json`, the crash
left a corrupted build cache: run `docker builder prune -af`.

**`/auth/...` returns 404, or the dev API logs `EADDRINUSE`** — the API
container from `pnpm stack:up` still holds port 4000. Stop it with
`docker compose --env-file .env -f infra/docker-compose.yml rm -sf api web`.

**No verification email** — check Mailpit at http://localhost:8025. If it is
empty, confirm `pnpm infra:ps` shows `mailpit` running and `.env` has
`SMTP_HOST=localhost` and `SMTP_PORT=1025`.

**A `401` from `/auth/refresh` on first page load** — expected when signed out.
The app tries to restore a session from the refresh cookie on every load.

**`ERR_PNPM_IGNORED_BUILDS`** — pnpm 12 blocks dependency lifecycle scripts.
The allowlist is `allowBuilds` in `pnpm-workspace.yaml` (renamed from
`onlyBuiltDependencies`; the `package.json` `"pnpm"` field is no longer read).

**`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`** — a dependency was published within
the last 24h. This is a deliberate supply-chain guard, not a bug: pin a slightly
older version rather than lowering `minimumReleaseAge`.

**`/healthz` returns 503** — expected when Postgres or Redis is down. The body
names which one and why. Run `pnpm infra:up`.
