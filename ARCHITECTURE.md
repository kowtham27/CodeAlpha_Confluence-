# Architecture

## Shape

```
                 +--------------------------+
   Browser A ----|   React + Vite (:5173)   |---- Browser B
      |          +--------------------------+          |
      |                      | REST + WebSocket        |
      |                      v                         |
      |          +--------------------------+          |
      |          |   Express + Socket.IO    |          |
      |          |         (:4000)          |          |
      |          +---+------------------+---+          |
      |              |                  |              |
      |        +-----v-----+      +-----v-----+        |
      |        | Postgres  |      |   Redis   |        |
      |        +-----------+      +-----------+        |
      |                                                |
      +---------- WebRTC media, peer-to-peer ----------+
                  (never transits the server)
```

The server carries signaling, identity, and persistence. It never carries
media. That single fact is what makes media end-to-end encrypted for free, and
it is the constraint every later decision has to respect.

## Topology: mesh, and why

Each participant holds N-1 `RTCPeerConnection`s and uploads its stream once per
peer. Upload cost grows linearly, which caps a room at roughly 6 people on a
typical connection - hence `Room.maxParticipants = 6`.

The alternative, an SFU, accepts one upload and fans it out. It scales to
hundreds, and it costs a media server to operate. It also **terminates media
E2EE at the server** unless Insertable Streams (`RTCRtpScriptTransform`) are
layered on top, because the SFU must touch the RTP stream to route it.

For v1 the tradeoff favours mesh: zero media infrastructure, genuine E2EE by
construction, and a participant cap the product does not need to exceed.

To keep the door open, Phase 3 puts all peer-connection management behind a
`MediaTransport` interface (`publish` / `subscribe` / `unpublish` / `close`).
`MeshTransport` implements it now; a future `SfuTransport` drops in without
touching a single UI component.

## Encryption layers

Four distinct layers, often conflated. Naming them separately is the point:

| Layer       | Protects                        | Mechanism                                                                                                                      | Phase |
| ----------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----- |
| Media       | Audio, video, screen            | DTLS-SRTP, mandatory in WebRTC. Mesh means no server hop, so it is genuinely end-to-end. **Not reimplemented.**                | 3     |
| Transport   | Everything client-to-server     | TLS 1.3, HSTS, `Secure` cookies                                                                                                | 7     |
| Application | Chat, whiteboard ops, file keys | Room key (256-bit), wrapped per member with `crypto_box_seal` to their X25519 key; XChaCha20-Poly1305 with a per-message nonce | 7     |
| At rest     | Database, object storage        | Provider-level encryption. Largely redundant given the application layer, but defence in depth                                 | 7     |

The database schema encodes this: `Message` has `ciphertext` and `nonce`
columns and deliberately **no plaintext column**. `FileMeta.encryptedKeyWrapped`
holds a key the server cannot unwrap. The server is storage and routing, not a
reader.

## Authentication flow

```
 Register ──► 202 "check your email" ──► Mailpit / SMTP ──► link  /verify-email#token=…
                                                                    │ POST token
 Sign in ◄──────────────────────────── 200 "verified" ◄────────────┘
    │
    ▼ POST /auth/login (email, password)
 access JWT (15 min, memory) + refresh cookie (httpOnly, /auth, rotating)
    │
    ├─► REST:   Authorization: Bearer <jwt>   ──401 TOKEN_EXPIRED──► POST /auth/refresh ─► retry once
    └─► Socket: handshake auth { token }      ──TOKEN_EXPIRED──────► refresh ─► reconnect

 Revocation (logout / logout-all / reuse detected):
   refresh tokens marked revoked ─► Redis marker per session (TTL 15 min)
   ─► access tokens for that session rejected ─► its sockets disconnected
```

The auth module never imports Socket.IO. It emits `sessions-revoked` on a small
internal event bus (`lib/auth-events.ts`); `server.ts` subscribes and closes
the affected sockets. That keeps the HTTP layer testable with supertest alone.

**Why opaque refresh tokens, not JWTs?** They are only ever checked against the
database, which is what makes rotation, reuse detection, and revocation
possible. A self-contained JWT would add a signature format to attack and buy
nothing.

**Why must email be verified before sign-in** rather than gating individual
features? One rule is simpler to reason about than a matrix of what unverified
accounts may do, and it lets registration answer identically for new and
existing emails. See SECURITY.md, _Account enumeration_.

## Rooms and presence

A **room** is a Postgres row (name, owner, lock, capacity, ended). **Presence**
(who is in it right now) lives in Redis, because it changes on every join and
leave, must be shared by every API instance, and must clean itself up when an
instance dies without saying goodbye.

```
 presence:{slug}:beats   ZSET  userId -> last heartbeat (ms)
 presence:{slug}:peers   HASH  userId -> { peerId, displayName, role, joinedAt }
 presence:rooms          SET   rooms with anyone in them (walked by the sweeper)
```

Every mutation is a Lua script, so each check-then-act is atomic across
instances: capacity ("is there a seat?" and "take it" cannot be split by a
racing joiner), and compare-and-delete on leave ("remove my entry only if it is
still mine").

**One seat per person.** Entries are keyed by user, not socket. Joining from a
second tab replaces the first: it gets `room:displaced`, and the room sees a
swap rather than a newcomer. Without this, Phase 3's mesh would try to call
yourself, and capacity would count one person twice.

**Crashed instances leave no ghosts.** Each instance refreshes its own sockets'
heartbeats every 10 s. Any instance's sweeper (every 15 s) removes entries not
refreshed for 30 s and announces them with reason `timeout`. Keys also carry a
TTL, so an abandoned room's presence disappears even if every instance dies.

**Join ordering.** The server subscribes the socket to the room's broadcasts
_before_ taking the seat and reading the snapshot. In the other order, a user
joining in between would appear in neither the snapshot nor a `peer-joined`
event. This way they can at worst appear in both, and the client dedupes by
user id.

**Locked means no newcomers**, not "nobody": anyone already admitted can rejoin
a locked room, so a dropped connection does not lock you out of your own
meeting.

**Horizontal scaling.** The Socket.IO Redis adapter makes broadcasts and room
membership span instances. Its pub/sub channel is namespaced by `NODE_ENV`
because Redis pub/sub ignores the database number: without it, the test suite
and a running dev server would hear each other's events. An integration test
runs two server instances and checks that people on each share one room.

**Why acknowledgements, not request/response events?** Every client request
(`room:join`, `room:leave`) carries a Socket.IO ack and gets exactly one
`{ ok: true, data } | { ok: false, error }` back, validated with Zod on both
ends. The client always learns the outcome, including a typed refusal
(`ROOM_FULL`, `ROOM_LOCKED`, `ROOM_ENDED`), and never waits forever.

**One socket for the signed-in area.** The web app's signed-in routes sit under
a single layout route that owns the socket, so moving from the home page into
a room keeps the connection instead of dropping and reopening it.

## Decisions

**pnpm workspace over npm/yarn.** Strict isolated `node_modules` catches
phantom dependencies at install time rather than in the Docker build.

**`packages/shared` as the wire contract.** Every socket event name and payload
schema is defined once and imported by both sides. Drift becomes a compile
error instead of a runtime mystery.

**`app.ts` returns the app; `main.ts` listens.** Costs one file, buys
supertest-driven HTTP tests with no port binding - which matters from Phase 1 on.

**Express 4, not 5.** Held to the spec. The relevant cost: Express 4 does not
forward rejected promises from async handlers, so an unhandled rejection becomes
a request that hangs until timeout. `middleware/async-handler.ts` wraps every
async route to close that gap. Express 5 does this natively; if we ever revisit
the pin, that wrapper is what goes away.

**Full Prisma schema migrated in Phase 0.** One coherent initial migration
rather than eight that each rewrite the last. Later phases add columns and
indexes; they do not restructure.

**Liveness and readiness are separate endpoints.** `/livez` never touches a
dependency, so a database outage does not get healthy containers killed and
restarted in a loop. `/healthz` probes both, bounded at 2s each, and returns 503
with per-dependency detail.

**Node 24 everywhere.** Local, Docker, and CI all pin the same major.
`argon2` (Phase 1) and `libsodium-wrappers` compile native/WASM artifacts; a
runtime mismatch between host and container is a classic source of breakage.

**One Dockerfile, shared install stage.** `infra/Dockerfile` has `api` and
`web` targets built from a common `deps` stage, so a dependency change installs
and supply-chain-verifies packages once rather than once per image. pnpm's
metadata cache (`/root/.cache/pnpm`) is a persistent BuildKit cache mount.
Measured on this project's lockfile (553 entries):

| Build                                   | Supply-chain check        | Notes                       |
| --------------------------------------- | ------------------------- | --------------------------- |
| Before (two Dockerfiles, no meta cache) | 9 m 03 s per image        | measured on one image       |
| Cold, new layout                        | 5 m 57 s, once            | 14.5 min total, both images |
| Dependency change, warm cache           | 2 m 46 s – 6 m 14 s, once | two runs; see below         |
| Code-only change                        | skipped                   | 5 min total, both images    |

Read the warm-cache row carefully: the metadata cache did **not** make the
check reliably faster. pnpm still makes a freshness request per package, so the
time tracks registry latency, which varied more than 2x between runs on the
same machine. The dependable wins are structural: the check runs once per
build instead of once per image, and code-only changes skip it entirely.

The check runs at all on a dependency change because pnpm keys its "already
verified" record on the lockfile's inode and mtime, which differ in every
container. Skipping it inside Docker would be faster, but it is the defence
against a lockfile edited to slip past `minimumReleaseAge`, so it stays.

**TypeScript 5.9, not 7.** TypeScript 7's native compiler is current, but
`typescript-eslint` still targets the 5.x API. A nine-phase build is the wrong
place to be first to find that integration's edges.

## Version notes

Ecosystem changes and pitfalls that bit during the build, worth knowing:

- **Prisma 7 removed `url` from the datasource block.** The CLI reads the
  connection string from `apps/api/prisma.config.ts`; the client gets it from
  the `@prisma/adapter-pg` driver adapter. Prisma also no longer auto-loads
  `.env`, so both entry points call `dotenv` explicitly.
- **pnpm 12 renamed the build-script allowlist** to `allowBuilds` in
  `pnpm-workspace.yaml`, and stopped reading the `package.json` `"pnpm"` field.
- **pnpm 12 enforces `minimumReleaseAge`.** Dependencies published in the last
  24h are rejected. Kept on deliberately; see SECURITY.md. It also re-verifies
  the whole lockfile against the registry on every container install, which is
  most of a cold `stack:up` build's time.
- **Migrations must create their own extensions.** Prisma's shadow database,
  CI, and managed Postgres never run `infra/postgres/init.sql`, so the init
  migration issues `CREATE EXTENSION citext` itself.
- **Two copies of `@types/express-serve-static-core`** made `declare module`
  augmentation silently no-op. The direct pin must match the version
  `@types/express` resolves.
- **Tailwind 4's `@theme` cannot nest in a media query.** Colours are plain
  CSS variables switched per scheme, mapped to utilities with `@theme inline`.

## Open questions

- Deployment target. Railway and Fly.io both handle long-lived WebSockets and a
  coturn sidecar. Vercel cannot host the API.
