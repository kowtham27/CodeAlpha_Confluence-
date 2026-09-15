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
      |   presigned PUT/GET   +-------------------+    |
      +---------------------->|  Object storage   |<---+
      |   (ciphertext only)   |   (MinIO / S3)    |    |
      |                       +-------------------+    |
      |                                                |
      +--- WebRTC media + file data channels, P2P -----+
                  (never transits the server)
```

The server carries signaling, identity, and persistence. It never carries
media. That single fact is what makes media end-to-end encrypted for free, and
it is the constraint every later decision has to respect. File bytes bypass it
too: uploads go straight from the browser to object storage with presigned
URLs, already encrypted.

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

| Layer       | Protects                               | Mechanism                                                                                                                   | Phase |
| ----------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----- |
| Media       | Audio, video, screen, direct transfers | DTLS-SRTP / DTLS-SCTP, mandatory in WebRTC. Mesh means no server hop, so it is genuinely end-to-end. **Not reimplemented.** | 3, 5  |
| Transport   | Everything client-to-server            | TLS 1.3, HSTS, `Secure` cookies; strict CSP on the web app                                                                  | 7     |
| Application | Files, whiteboard, chat                | Room key (256-bit), sealed per member with `crypto_box_seal` to their X25519 key; XChaCha20-Poly1305 throughout             | 5–7   |
| At rest     | Database, object storage               | Provider-level encryption. Largely redundant given the application layer, but defence in depth                              | 7     |

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

## Video calling

```
 Ada ──offer──► server ──► Ben         SDP and ICE are relayed to exactly one
 Ada ◄─answer── server ◄── Ben         socket, after checking both are seated
 Ada ◄─ICE────► server ◄─► Ben         in the same room. Media never touches
 Ada ◄═══════ media, DTLS-SRTP ═════► Ben   the server.
```

**`MediaTransport` / `MeshTransport`** (`apps/web/src/lib/media`). The UI only
knows `publish(track)`, `unpublish(kind)`, `subscribe(peerId)` and
`close()`. The mesh keeps one `RTCPeerConnection` per other participant.

**Fixed transceivers.** Every connection is negotiated once with exactly one
audio and one video transceiver, both `sendrecv`. Mute (`track.enabled`),
switching camera or microphone, and Phase 4's screen share are all
`sender.replaceTrack()`: no renegotiation, no new offer, no glare. Someone who
has no camera or refused permission still receives everyone, because the
transceivers exist either way.

**Who offers.** Spec: the peer with the lexicographically smaller socket id is
impolite and creates the offer; the other waits, then attaches its own tracks
to the transceivers the offer created, so the answer carries its media in the
same round trip. Perfect negotiation (`makingOffer` / `ignoreOffer`, implicit
rollback on the polite side) resolves any later collision, such as both sides
restarting ICE at once.

**Ordered signaling.** Messages for one peer are applied strictly in order
through a per-peer promise queue. Otherwise an ICE candidate arriving while
the offer is still being applied hits `addIceCandidate` too early and is lost.

**Signaling sessions.** Every transport instance has a random session id sent
with each message. A new session from a known peer means they rebuilt their
connections (reload, tab takeover, React's development double-mount), so the
receiver rebuilds its side instead of applying a stranger's SDP to the old
connection. Without this, the call test caught a real failure mode: audio kept
flowing while video froze, because the DTLS identity had changed underneath.

**Recovery.** `disconnected` for 3 s → `restartIce()`. `failed` → the
connection is torn down and rebuilt; the impolite side re-offers.

**No lost offers.** Existing members send offers the moment someone joins,
which can be before the newcomer's call UI (and transport) exists. Each socket
therefore gets a `SignalingInbox` at creation that queues signaling until a
transport attaches, then replays it in order. As a second line of defence, an
offer still unanswered after 5 s is re-sent as is (up to 3 times); a repeated
answer is ignored. Found under load in Phase 6, where a heavier room page
widened the window enough for a pair to never connect.

**TURN.** The API mints coturn "REST API" credentials at every join:
`username = "<expiry>:<userId>"`, `credential = base64(HMAC-SHA1(secret,
username))`, valid 12 hours. Verified against the running coturn: a minted
credential allocates (`ALLOCATE processed, success` in coturn's log); a
tampered one cannot.

**Mute state** is part of presence. `media:state` updates the participant's
entry atomically and is broadcast, so every tile shows a mute indicator, and
late joiners get it in their snapshot.

**Active speaker.** One `AudioContext`, an `AnalyserNode` per stream, RMS
sampled every 100 ms, smoothed, and held for 900 ms after someone stops, so
the highlight does not flicker on every breath.

**Resolution.** 640x360 at up to 30 fps. In a mesh each person uploads one copy
per peer: five peers at 720p would need roughly 7 Mbps of upload, at 360p
about 2.5 Mbps.

**Testing media.** Playwright runs Chromium with its fake camera and
microphone. The call test wraps `RTCPeerConnection` from the test side (the
app ships no test hooks) and asserts on real `getStats()` numbers: inbound
audio bytes and decoded video frames from every peer, sampled twice to show
they are still increasing.

## Screen sharing

**One presenter per room, arbitrated by the server** (`screen:claim` /
`screen:release`): a Redis key holds the presenter, set by a Lua script that
refuses a second claim unless the holder no longer has a seat. No TTL: a
presenter who vanished (left, disconnected, their server crashed) simply stops
counting, and the slot is also freed explicitly at every exit path: leave,
disconnect, tab takeover, presence sweep, and meeting end.

**Claim first, then open the picker**, so a busy room fails immediately with
"Ada is already sharing their screen" instead of after choosing a window.
Cancelling the picker releases the slot.

**The swap is `replaceTrack`.** The presenter's video sender switches from the
camera to the screen track on every connection; nothing is renegotiated. The
test proves it: the receiver's inbound resolution jumps from 640 to 1280 on
the same, still-connected peer connection.

**Screen audio** (`getDisplayMedia({ audio: true })`) cannot get its own
sender without renegotiating, so while presenting the audio sender carries a
Web Audio mix of the microphone and the shared tab's sound. Muting the mic
still silences only the mic.

**Stopping** from the app, or from the browser's own "Stop sharing" button (the
track's `ended` event), puts the camera and microphone back and releases the
slot. Switching devices mid-presentation updates the camera or the mixer's mic
without disturbing the screen.

**Layout.** A presentation takes a height-capped stage; everyone moves to a
filmstrip. The presenter sees "You are presenting" instead of their own
capture (a hall of mirrors when sharing the same tab). The stage's video is
muted: the presenter's tile keeps playing their audio, and a second unmuted
element would play every word twice.

## File sharing

Two ways to share, one drop zone. The user picks per file:

| Mode              | Path                                                   | Who gets it                            | Kept                |
| ----------------- | ------------------------------------------------------ | -------------------------------------- | ------------------- |
| Keep in this room | Browser encrypts, then presigned PUT to object storage | Every member of the room, now or later | 7 days, then purged |
| Send directly     | The call's `files` data channel, peer to peer          | Whoever is in the call right now       | Never stored        |

### End-to-end keys

Pulled forward from Phase 7, because a stored file needs a key the server
cannot read, and that key has to reach every member somehow. The same room key
will encrypt chat and whiteboard operations in Phase 7.

```
password --Argon2id--> lock key --XChaCha20-Poly1305--> private key (X25519)

room key (32 random bytes) --crypto_box_seal--> one sealed copy per member
file key (one per file)    --XChaCha20-Poly1305, room key--> encryptedKeyWrapped
file bytes                 --secretstream, 64 KiB chunks, file key--> object storage
{name, type, size}         --XChaCha20-Poly1305, file key--> FileMeta.filename
```

- **User keys.** Created in the browser at first sign-in, the one moment the
  password is available. The server stores the public key and the private key
  locked with the password (Argon2id, then XChaCha20-Poly1305); it cannot open
  it. Public keys are **set once**: replacing one would redirect every future
  room key to whoever did it, so a stolen access token must not be able to.
  Only a password reset clears them.
- **On this device.** After unlocking, the private key is kept in IndexedDB,
  encrypted with a non-extractable WebCrypto AES-GCM key, so a reload (which
  restores the session from the refresh cookie, with no password) does not ask
  again. A browser with no copy shows a password prompt. Sign-out clears it.
- **Room key.** The first member to need it creates it (`PUT /rooms/:slug/key`,
  first writer wins atomically) and records a BLAKE2b fingerprint,
  `Room.keyCheck`. Every member who opens a copy checks it against the
  fingerprint before using it, so a copy that is not this room's key is
  discarded rather than used.
- **Distribution.** A member who lacks the key is announced
  (`room:key-requested`) when they join. Any holder's browser seals the key to
  the newcomer's public key and posts it; the server delivers
  `room:key-granted` to the newcomer's own sockets. Holders only grant to
  people **currently in the call**, whom their user can see. The server refuses
  grants from non-holders and never overwrites an existing copy.
- **Lost keys.** A password reset clears the user's key pair and every room key
  sealed to it; other members re-grant it the next time they meet. If nobody
  holds a room's key any more, the next member creates a new one
  (compare-and-swap on the old fingerprint). Files under the old key stay
  listed but unreadable.

### Persisted files

1. The browser sniffs the file's real type from its bytes against an allowlist
   (never the extension alone; HTML, SVG, scripts and executables are refused).
2. It generates a file key, encrypts the file with secretstream in 64 KiB
   chunks (so truncation and reordering are detected), encrypts the name and
   type with the same key, wraps the file key with the room key, and hashes the
   ciphertext (BLAKE2b-256).
3. `POST /rooms/:slug/files` creates a pending row and returns a presigned PUT
   **bound to the exact ciphertext size** (a signed `Content-Length`).
4. The browser uploads straight to storage, with progress.
5. `POST .../complete`: the API checks the stored object's size itself, marks
   the row uploaded, and broadcasts `file:shared`.

Downloads are the reverse: a 5-minute presigned GET (served as an attachment
from the storage origin, not the app's), a checksum check, decryption, and a
save dialog. Files are never rendered in the page.

A Redis-locked job deletes expired files and uploads abandoned for over an
hour, object first then row, every 30 minutes on whichever instance gets the
lock. The storage probe is reported in `/healthz` but does not fail readiness:
calls work without storage.

### Direct transfers

Each peer connection gets a **pre-negotiated** data channel (`id: 0`,
`negotiated: true`): the impolite side creates it with its transceivers, so the
one initial offer carries a data section; the polite side creates its end
while answering. No extra negotiation, no glare. A transfer is a JSON `begin`,
16 KiB binary chunks with `bufferedAmount` back-pressure (pause above 4 MiB,
resume below 1 MiB), then `end`. The receiver refuses anything larger than
announced and re-sniffs the finished file before offering to save it. DTLS
already encrypts the channel end to end, so no second layer is added.

## Whiteboard

A shared canvas, end-to-end encrypted with the same room key as files: the
server keeps the board consistent without being able to see it.

**Elements, not pixels.** The board is a list of elements (freehand stroke,
line, arrow, rectangle, ellipse, text) in a fixed 1600 × 1000 coordinate
space that every screen scales to fit, so everyone sees the same layout. Each
element is JSON, encrypted with the room key before it leaves the browser,
with the room, element id and purpose bound in as associated data: the server
cannot swap one element's ciphertext for another's, or replay a draft as a
committed element. Receivers validate every decrypted element against a Zod
schema; another member's browser is untrusted input.

**Ordering without reading.** Every change is `add` (or replace your own),
`remove` (anyone: it is a shared board), or `clear` (host only). Each takes the
next value of `Room.boardSeq` in the same transaction that stores it; that row
lock also serialises concurrent changes to one room. The sender learns its
`seq` from the ack; everyone else receives `board:op` in server order.

**Compaction without reading.** `WhiteboardOp` holds only live elements, one
row per element id: removing deletes the row, clearing deletes them all. A
board drawn on for hours loads as fast as its current picture. Capped at 2,000
live elements per room.

**Late joiners** fetch a snapshot (all live elements plus the `seq` they
reflect, read in one repeatable-read transaction) while buffering live ops,
then apply buffered ops newer than the snapshot. The session is rebuilt after
every rejoin, so a reconnect never leaves a gap.

**Live feel.** While someone draws, an encrypted draft of the element in
progress is relayed (never stored) every ~60 ms, and pointer positions every
~50 ms with the person's name. Both are sent volatile: a slow client drops
stale frames instead of queueing them.

**Client.** `BoardSession` (a plain class, not React state) owns sync; the
canvas subscribes to drafts and cursors directly, so 20 frames a second never
re-render the call. Two stacked canvases: committed elements redraw on change,
the live layer on `requestAnimationFrame`. Pen input uses coalesced pointer
events for smooth strokes, simplified with Ramer-Douglas-Peucker before
sending. Undo and redo are per person (your own adds and erases). The board is
sized to fit the viewport's height, because you cannot draw on the part of a
board that has scrolled away. Export renders to a PNG in the browser.

## Chat

In-meeting chat, encrypted with the room key like everything else.

- **Sending.** The browser picks the message id (a UUID), encrypts `{ text }`
  with the room key, binding the room, the sender's user id and the message
  id as associated data, and emits `chat:send`. The server stores the nonce
  and ciphertext in separate columns, acks the stored message, and broadcasts
  it to the rest of the room with the sender identity it authenticated.
- **Why bind the sender.** The room key is shared, so encryption alone proves
  only "someone in the room wrote this". Binding the claimed sender means the
  server cannot re-label Ada's message as Ben's: it would not decrypt.
- **Retries** reuse the message id, so a lost ack never produces a duplicate.
  Messages show at once and turn solid when confirmed; a failed one offers
  Retry.
- **History** is paged newest-first (50 at a time) over REST and decrypted in
  the browser; it reloads after every rejoin so nothing sent during a
  disconnect is missed.
- **Safety codes** (in the chat panel) show a 30-digit fingerprint of every
  member's public key. See SECURITY.md.

The side panel holds chat or files; each has an unread badge while closed.

## Polish (Phase 8)

**Lobby.** A room link opens a pre-join screen, not the call. It checks the
room over REST first (so a bad, ended or locked link explains itself before
any device is touched), then previews the camera, offers device pickers and
"starts off" toggles, and joins only on "Join now". The choices go to the
call as preferences: the chosen devices are acquired again and anything
chosen off starts muted (`track.enabled = false`), so turning it on later is
instant. Someone who has just created the room goes straight in; the
navigation marker for that is cleared at once, because history keeps it
across reloads.

**Reconnection.** A dropped socket shows "Reconnecting…"; on reconnect the
room is rejoined automatically (a new peer id), the mesh is rebuilt, and the
whiteboard, chat and file lists reload so nothing sent in between is missed.
ICE restarts and rebuilds cover network changes that keep the socket, and the
signaling inbox plus offer re-send cover lost negotiation messages. An e2e
test takes a browser offline and back, and checks media flows again.

**Connection quality.** Every 2 s the call reads `getStats()` for each
connected peer: the selected candidate pair's round-trip time, packet loss
over the interval, and audio jitter, graded good / fair / poor against VoIP
thresholds (250 ms / 2 %, 500 ms / 8 %). Remote tiles show three bars with
an accessible label.

**Keyboard shortcuts.** Single keys (M, V, S, C, F, B, and ? for help),
ignored while typing, with a modifier held, or while a dialog is open. They
are chosen not to collide with the whiteboard's tool keys (P L A R O T E).
The help is a native `<dialog>`: focus trapping and Esc come from the browser.

**Themes.** System (the default), light or dark. An explicit choice sets
`data-theme` on `<html>`, which the palette obeys over the system preference;
it is applied before the first paint and kept in localStorage.

**Accessibility.** axe-core checks every main screen against WCAG 2.1 A and
AA in both themes as part of the e2e suite. It found and fixed: green status
text below 4.5:1 contrast, and chat messages orphaned by putting
`role="log"` on the list itself.

**A smaller API image.** 966 MB → 413 MB. The API image takes a
production-only install of just the API and its workspace packages, then a
reachability prune (`infra/prune-api-deps.mjs`) drops the Prisma CLI tree
that pnpm links as an optional peer of `@prisma/client` but nothing imports
at run time. The logger uses `pino-pretty` only if it is installed.

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
- **`libsodium-wrappers` lacks `crypto_pwhash`** (Argon2id). The `-sumo`
  build has it, at about twice the size; the web app loads it on demand, not
  in the sign-in bundle.
- **`minio/minio` is gone from Docker Hub**, and MinIO stopped publishing
  community images in late 2025. Compose pins the last one, from `quay.io`.
  It is a local stand-in: production should use S3, R2 or another
  S3-compatible store. Nothing in the code is MinIO-specific.
- **Tailwind 4's `@theme` cannot nest in a media query.** Colours are plain
  CSS variables switched per scheme, mapped to utilities with `@theme inline`.

## Open questions

- Deployment target. Railway and Fly.io both handle long-lived WebSockets and a
  coturn sidecar. Vercel cannot host the API.
