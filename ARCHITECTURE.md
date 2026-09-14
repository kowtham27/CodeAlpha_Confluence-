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

**TypeScript 5.9, not 7.** TypeScript 7's native compiler is current, but
`typescript-eslint` still targets the 5.x API. A nine-phase build is the wrong
place to be first to find that integration's edges.

## Version notes

Three ecosystem changes bit during Phase 0 and are worth knowing:

- **Prisma 7 removed `url` from the datasource block.** The CLI reads the
  connection string from `apps/api/prisma.config.ts`; the client gets it from
  the `@prisma/adapter-pg` driver adapter. Prisma also no longer auto-loads
  `.env`, so both entry points call `dotenv` explicitly.
- **pnpm 12 renamed the build-script allowlist** to `allowBuilds` in
  `pnpm-workspace.yaml`, and stopped reading the `package.json` `"pnpm"` field.
- **pnpm 12 enforces `minimumReleaseAge`.** Dependencies published in the last
  24h are rejected. Kept on deliberately; see SECURITY.md.

## Open questions

- Email verification in Phase 1 - adds an SMTP dependency. Currently deferred:
  `User.emailVerifiedAt` exists in the schema but nothing writes it.
- Deployment target. Railway and Fly.io both handle long-lived WebSockets and a
  coturn sidecar. Vercel cannot host the API.
