# Security

What Confluence protects, from whom, and how. The threat model and the
authorization map come first; after them, each control is recorded as it was
built, phase by phase, so the gap between intent and implementation stays
visible.

## Threat model

### Assets

| Asset                                          | Why it matters                                       |
| ---------------------------------------------- | ---------------------------------------------------- |
| Call media (audio, video, screen)              | The meeting itself                                   |
| Chat, whiteboard, shared files and their names | Meeting content, often more sensitive than the call  |
| Account credentials and sessions               | Everything else follows from them                    |
| Users' private keys and room keys              | Whoever holds them can read all meeting content      |
| Room links (slugs)                             | A link is the invitation; knowing it lets you ask in |
| Who met whom, when (metadata)                  | Sensitive even when content is not                   |

### Adversaries

| Adversary                                                                         | Can                                          | Should not be able to                                       |
| --------------------------------------------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| Outsider on the internet                                                          | Reach the web app and API                    | Sign in as anyone, enter a room, read or disrupt anything   |
| Network attacker (e.g. hostile Wi-Fi)                                             | See and alter traffic                        | Read or alter any of it (TLS in production; DTLS for media) |
| Someone who got a room link                                                       | Ask to join (unless the room is locked)      | Anything once the host locks or ends the room               |
| A malicious member of your meeting                                                | See what the meeting sees; send junk         | Impersonate another member; break the room for others       |
| Script injected into the web app (XSS)                                            | Run as the user, in their tab                | Exist at all (CSP); copy keys off the device                |
| Thief of a laptop with a session open                                             | Use the open session                         | Keep it after "sign out everywhere"; learn the password     |
| **The server operator, or anyone who compromises the server, database or bucket** | Read everything stored, alter what is served | Read meeting content: chat, whiteboard, files, media        |

The last row is the one end-to-end encryption exists for. The server is
treated as honest-but-curious for availability (it can always refuse service)
and as untrusted for confidentiality.

### What the server can and cannot see

| The server sees                                                 | The server never sees                       |
| --------------------------------------------------------------- | ------------------------------------------- |
| Accounts: email, display name, Argon2id password hash           | Passwords                                   |
| Who is in which room, and when; who presents                    | Audio, video or screen (peer-to-peer, DTLS) |
| Public keys; private keys **locked with the user's password**   | Private keys or room keys in usable form    |
| That a chat message was sent, by whom, when, how long (roughly) | Chat text                                   |
| Whiteboard element count, sizes, authors, times                 | What is drawn or written                    |
| File sizes, uploaders, times; storage keys                      | File contents, names or types               |
| Direct transfers: nothing (they never touch it)                 | —                                           |

### Threats and mitigations

| Threat                                                 | Mitigation                                                                                                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Password guessing, credential stuffing                 | Argon2id (64 MB); 5 failures per email per 15 min; per-IP limits; generic errors                                                                              |
| Account enumeration                                    | Identical responses and timing for known and unknown emails (register, reset)                                                                                 |
| Stolen access token                                    | 15-minute lifetime, memory-only; sockets of revoked sessions are disconnected                                                                                 |
| Stolen refresh token                                   | httpOnly, Secure, SameSite=Strict, path-scoped; rotated on use; reuse revokes the whole session family                                                        |
| CSRF                                                   | SameSite=Strict cookie on `/auth` only; every other call carries a bearer token; Origin check on cookie routes                                                |
| XSS                                                    | React escapes all text; no `innerHTML`; strict CSP with no inline script; chat and board text rendered as text or to a canvas; files are only ever downloaded |
| Clickjacking                                           | `frame-ancestors 'none'`, `X-Frame-Options: DENY`                                                                                                             |
| Reading meeting content on the server                  | End-to-end encryption: X25519 key pairs, sealed room keys, XChaCha20-Poly1305 for every message, element and file                                             |
| Server re-attributes, moves or replays encrypted items | Associated data binds each ciphertext to its room, sender (chat), element id (board) and purpose; decryption fails otherwise                                  |
| Server substitutes a public key (to receive room keys) | Keys are set once per account; keys are granted only to people visibly in the call; **safety codes** let people verify each other's keys                      |
| Tampered file in storage                               | Authenticated encryption (secretstream, detects truncation) plus a checksum recorded at upload                                                                |
| Malicious member sends malformed data                  | Every decrypted item is validated against a strict schema before use; oversized transfers are cut off; file types are checked by content                      |
| Someone joins who should not                           | Unguessable 12-character slugs; host can lock and end rooms; locked rooms admit existing members only                                                         |
| Flooding (HTTP or socket)                              | Per-IP and per-account rate limits in Redis; per-socket token buckets for signaling, board, chat; payload caps; element, file and room size caps              |
| Abusing TURN as an open relay or port scanner          | Short-lived HMAC credentials minted per join; relaying to private and loopback ranges denied                                                                  |
| Dependency compromise                                  | Lockfile; 24-hour minimum release age; build scripts allowlisted; `pnpm audit` in the Phase 7 review                                                          |
| Secrets in images or logs                              | `.env` excluded from images; production refuses placeholder secrets; logs redact tokens, passwords and ciphertext                                             |

### Residual risks

Accepted, and worth knowing:

- **Safety codes only help if people compare them.** Nothing forces a check,
  and when someone's code changes (after a password reset) nobody is warned.
- **The web app itself is served by the server.** A server operator who
  wanted to could ship modified JavaScript that leaks keys. This is the
  standing limit of every browser-based end-to-end encryption system; the CSP
  and a reproducible build narrow it, and only a separately distributed,
  signed client removes it.
- **Metadata** (who met whom and when, sizes and counts) is visible to the
  server, as listed above.
- **An open tab is trusted.** While the page is open, its script can use the
  unlocked private key. The CSP is what keeps foreign script out.
- **Availability** is the server's to give: it can drop, delay or refuse
  anything; it cannot forge or read.

## Authorization map

Every route and socket event, and who may use it. "Member" means a row in
the room's membership (anyone admitted at least once); "seated" means
currently in the call on this socket; "host" means the owner or a moderator.

| Route / event                                                   | Allowed                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| `POST /auth/register`, `/login`, `/verify-email`, `/password/*` | Anyone (rate-limited)                                               |
| `POST /auth/refresh`, `/logout`                                 | Holder of the refresh cookie (Origin-checked)                       |
| `POST /auth/logout-all`, `GET /auth/me`                         | Signed in                                                           |
| `GET /livez`, `/healthz`                                        | Anyone                                                              |
| `POST /rooms`, `GET /rooms`                                     | Signed in (list shows only your rooms)                              |
| `GET /rooms/:slug`                                              | Signed in, knowing the link                                         |
| `PATCH /rooms/:slug` (rename, lock)                             | Host                                                                |
| `POST /rooms/:slug/end`                                         | Owner                                                               |
| `GET, PUT /me/keys`                                             | Signed in; PUT only while no keys are set                           |
| `GET /rooms/:slug/key`, `.../key/requests`, `.../members/keys`  | Member                                                              |
| `PUT /rooms/:slug/key`                                          | Member; only if the room has no key, or nobody holds it             |
| `POST /rooms/:slug/key/grants`                                  | Member who holds the key; target must be a member; never overwrites |
| `DELETE /rooms/:slug/key/mine`                                  | Member (their own copy only)                                        |
| `POST /rooms/:slug/files`                                       | Member; room not ended; 30 an hour                                  |
| `POST /rooms/:slug/files/:id/complete`                          | The uploader                                                        |
| `GET /rooms/:slug/files`, `.../:id/download`                    | Member                                                              |
| `DELETE /rooms/:slug/files/:id`                                 | The uploader, or a host                                             |
| `GET /rooms/:slug/board`, `GET /rooms/:slug/messages`           | Member                                                              |
| `room:join`                                                     | Signed in; admission rules (ended, locked, full)                    |
| `room:leave`, `media:state`, `screen:*`                         | Seated in that room                                                 |
| `webrtc:*`                                                      | Seated; addressee seated in the same room                           |
| `board:add`, `board:remove`, `board:draft`, `board:cursor`      | Seated; `add` may replace only your own element                     |
| `board:clear`                                                   | Seated host                                                         |
| `chat:send`                                                     | Seated                                                              |

## Authentication (Phase 1)

### Passwords

- **Argon2id, 64 MB, 3 passes, 1 lane** (`modules/auth/password.ts`), roughly
  300 ms per hash. Hashes created under weaker parameters are transparently
  re-hashed on the next successful login.
- **Length is the only rule**: 12–128 characters. Composition rules push users
  to predictable patterns (NIST SP 800-63B); the upper bound stops a huge
  "password" being used to burn server CPU.

### Account enumeration

An attacker should not be able to learn which emails have accounts.

- **Registration** always answers `202 Check your email`. A new address gets a
  verification link; an existing verified address gets a "someone tried to
  sign up with your email" notice instead, so only the inbox owner learns
  anything. Email is sent in the background so response time is identical.
- **Login** returns the same `401 Incorrect email or password` for an unknown
  email and a wrong password. When there is no user, a dummy argon2 verify
  runs anyway, so the two cases also take the same time.
- **Resend verification** always answers `202`.
- `EMAIL_NOT_VERIFIED` is only returned _after_ the correct password, so it
  reveals nothing to someone who does not already control the account.

### Email verification

- Required before sign-in.
- 256-bit random tokens, single-use, 24 h expiry. Only the newest link works:
  issuing one deletes older unused tokens.
- Stored as HMAC-SHA256 (keyed with `JWT_REFRESH_SECRET`): a database dump
  alone yields no usable token.
- The link carries the token in the **URL fragment** (`#token=`). Browsers never
  send fragments to servers, so it cannot land in access logs or `Referer`
  headers. The page strips it from the address bar on read.
- The page submits the token with a `POST`. Corporate mail scanners that
  pre-fetch links with `GET` cannot consume it.

### Password reset

- **Enumeration-safe.** `POST /auth/password/forgot` always answers `202` with
  the same message. Only an existing account is emailed; nothing is sent to
  unknown addresses (sending "no account here" mail would let anyone spam any
  inbox).
- **Tokens** follow the verification design (256-bit, single-use, HMAC-hashed,
  fragment link, `POST` to submit) but live in their **own table** with a
  **1-hour** lifetime. A verification token can never be accepted as a reset
  token — tested.
- **On success**, in one transaction the token is claimed and the password
  replaced; then **every session on every device is revoked**
  (`revokedReason = PASSWORD_RESET`), their sockets disconnected, the login
  lockout cleared, and a "your password was changed" email sent so an
  unexpected reset does not go unnoticed.
- **A reset verifies the email.** Following the link proves inbox control,
  which is all verification ever checked.
- A rejected new password (policy failure) does **not** consume the link.
- **Known timing gap:** for an existing account the endpoint writes a token row
  before answering, so it is a few milliseconds slower than for an unknown one.
  Much smaller than the argon2 gap closed on login, and the per-email and
  per-IP limits cap how many probes anyone can make.

### Sessions

| Token   | Form                     | Lifetime                   | Storage (client)                                       |
| ------- | ------------------------ | -------------------------- | ------------------------------------------------------ |
| Access  | HS256 JWT (`sub`, `sid`) | 15 min                     | JavaScript memory only — never localStorage            |
| Refresh | Opaque 256-bit random    | 7 days sliding, 30-day cap | `httpOnly; Secure; SameSite=Strict; Path=/auth` cookie |

- JWT verification **pins** `HS256` and checks issuer and audience, so a token
  cannot choose its own algorithm (`alg: none` is tested and rejected).
- The refresh cookie is invisible to page JavaScript (so to XSS), never sent
  cross-site, and scoped to `/auth` so it authenticates nothing else.

**Rotation with reuse detection** (`modules/auth/session.service.ts`). Every
refresh consumes the presented token and issues a new one in the same
_family_. Tokens are single-use, so a consumed token appearing again means two
parties hold it — the user and whoever stole it. The server cannot tell which
is which, so it **revokes the whole family** and both must sign in again,
logging `auth.refresh.reuse_detected`.

A 10-second grace window treats a just-rotated token presented again as a
benign race (two tabs refreshing together): the request gets `REFRESH_STALE`
and the family survives. The grace window **grants nothing** — the stale token
still does not refresh. The client also serialises refreshes across tabs with
the Web Locks API, so the race is rare in the first place.

**Revocation is immediate.** Logout, logout-everywhere, and reuse detection
write a short-lived Redis marker per revoked session, checked on every
authenticated request. Access tokens already issued for a revoked session stop
working at once instead of living out their 15 minutes, and every socket opened
under that session is disconnected.

### Rate limits

Redis sorted-set sliding windows, applied atomically in Lua, so limits hold
across API instances and cannot be raced past (`lib/rate-limiter.ts`).

| Limit                    | Scope      | Window      | Redis down  |
| ------------------------ | ---------- | ----------- | ----------- |
| 100 requests             | per IP     | 1 min       | fail open   |
| 5 failed logins          | per email  | 15 min      | fail closed |
| 10 registrations         | per IP     | 1 h         | fail closed |
| 3 verification re-sends  | per email  | 1 h         | fail closed |
| 20 verification attempts | per IP     | 1 h         | fail closed |
| 3 reset emails           | per email  | 1 h         | fail closed |
| 10 reset requests        | per IP     | 1 h         | fail closed |
| 20 reset submissions     | per IP     | 1 h         | fail closed |
| 30 room joins            | per user   | 1 min       | fail open   |
| 300 signaling msgs burst | per socket | 30/s refill | in memory   |

Subjects are hashed before use as Redis keys, keeping raw emails out of Redis.

### CSRF

Cookie-authenticated routes (`/auth/login`, `/refresh`, `/logout`,
`/logout-all`) reject any request whose `Origin` is not the web app, or whose
`Sec-Fetch-Site` is `cross-site`. This is a second layer behind
`SameSite=Strict`.

### Realtime

Socket.IO connections are authenticated in `io.use()` with the access token,
before any handler can run. Expired tokens get a distinct `TOKEN_EXPIRED`
error so the client refreshes and reconnects; revoked sessions are refused.

## Rooms (Phase 2)

- **Every socket event is validated and authorized on its own.** Payloads are
  parsed with Zod regardless of the TypeScript event map (the bytes come from
  the network); handlers re-check the caller's right to act — you can only
  leave the room your socket is in. Joining once does not imply permission for
  later events.
- **Admission is server-side only.** Existence, ended, locked, and capacity are
  all enforced by the server; capacity atomically in Redis, so racing joiners
  cannot over-fill a room (tested with concurrent joins).
- **Room links are the access control**, so slugs are 72 random bits
  (`randomBytes(9)`, base64url). Guessing one is not feasible at any rate the
  API allows; the per-user join limit (30/min) and global IP limit apply.
- **Host actions** (lock, rename, end) are checked against the caller's role in
  that room, not a global flag. Only the owner can end a meeting.
- **Broadcasts carry only shared fields.** `room:updated` sends name and lock
  state, never a summary with the actor's role in it.
- **Revoking a session removes its seat**: its sockets are disconnected, which
  releases presence and tells the room.
- **Audit log:** room created, joined, and ended.

## Calls (Phase 3)

- **Media is end-to-end encrypted by construction.** WebRTC mandates
  DTLS-SRTP, and in a mesh no server is ever on the media path.
- **The signaling relay is not an open pipe.** Offers, answers and ICE
  candidates are relayed to exactly one socket, and only if sender and
  addressee both hold seats in the same room. Tests prove a socket cannot reach
  someone in another meeting, cannot signal without a seat, and cannot address
  itself.
- **`from` is stamped by the server** from the sender's real socket id, never
  taken from the payload, so one peer cannot impersonate another.
- **Payloads are bounded** (SDP 64 KB, candidate 2 KB, ids 64 chars), and each
  socket has a token-bucket budget (burst 300, 30/s), so no socket can flood
  another through the relay.
- **TURN credentials are short-lived and per user**: coturn REST-API style
  HMAC credentials, valid 12 hours, minted at every join. The browser never
  sees the shared secret. Verified against the running coturn: a minted
  credential allocates, a tampered one does not.
- **The relay cannot probe the host.** coturn denies relaying to loopback,
  link-local and private ranges. Observed during testing: a relay request
  toward 127.0.0.1 was refused with `403 Forbidden IP`.
- **Mute state** can only be changed for the caller's own seat (compare-and-set
  on the peer id), so a displaced tab cannot overwrite the new tab's state.

## Screen sharing (Phase 4)

- Only a participant seated in the room can claim or release its screen slot,
  and a release only frees the slot if the caller holds it (compare-and-delete
  on the socket id), so nobody can end someone else's presentation.
- The slot cannot be squatted by a vanished client: a claim takes over a lock
  whose holder no longer has a seat.
- Screen capture always goes through the browser's own picker; the app cannot
  capture anything the user did not choose.

## Files and end-to-end keys (Phase 5)

What the server and the storage bucket hold for a shared file, and why none of
it is readable without a room member's password (design in ARCHITECTURE.md,
"File sharing"):

| Stored                        | Where                          | Protected by                                                       |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------ |
| File bytes                    | Object storage                 | secretstream (XChaCha20-Poly1305), per-file key                    |
| File name, type, size         | `FileMeta.filename`            | XChaCha20-Poly1305, per-file key                                   |
| Per-file key                  | `FileMeta.encryptedKeyWrapped` | XChaCha20-Poly1305, room key                                       |
| Room key, one copy per member | `RoomMember.wrappedRoomKey`    | `crypto_box_seal` to that member's X25519 key                      |
| Member's private key          | `User.encryptedPrivateKey`     | XChaCha20-Poly1305 under an Argon2id-derived key from the password |

The integration suite proves the claim directly: it uploads a file and asserts
that neither the stored object nor any database column contains its name,
type or content.

Controls:

- **Uploads never pass through the API.** Presigned PUTs are valid for 15
  minutes and signed over the exact ciphertext size and content type, so the
  storage layer itself refuses a larger or relabelled upload. The API then
  checks the stored size before announcing the file.
- **Downloads** are 5-minute presigned GETs from the storage origin with
  `Content-Disposition: attachment`: a stored object can never render with the
  app's origin or cookies. The browser also verifies the ciphertext checksum
  before decrypting, and saves files rather than opening them.
- **Type allowlist by content.** Files are sniffed from their bytes before
  upload and again on receipt of a direct transfer. HTML, SVG, scripts and
  executables are refused even when renamed. 100 MB maximum.
- **Authorization.** Only room members can list, upload, or download; only the
  uploader or a host can delete; only a key holder can grant the room key, and
  a grant never replaces a copy someone already has.
- **Public keys are set once** per account. An attacker with a stolen access
  token cannot substitute their own key to receive future room keys; only a
  password reset (which proves control of the inbox) clears keys.
- **Retention.** Files are deleted after 7 days, abandoned uploads after an
  hour. 30 uploads per user per hour.
- **Direct transfers** ride the call's DTLS-encrypted data channels and are
  never stored anywhere; the receiver drops a transfer that exceeds its
  announced size.

## Whiteboard (Phase 6)

- Every element, live draft and cursor position is encrypted with the room key
  in the browser. The database holds `{ ciphertext }` per element; the
  integration suite asserts that no stored row contains the element's text,
  type or colour, and that a ciphertext does not decrypt under a different
  element id (ids are bound in as associated data).
- Only a socket seated in the room may change the board or relay drafts and
  cursors; only the room's host may clear it; a member may replace only their
  own elements (erasing anyone's is allowed, as on a real whiteboard).
- Decrypted elements are validated against a strict schema before drawing;
  text is drawn to a canvas, never inserted as HTML.
- Per-socket budgets: 60 changes (refilling at 10/s) and 120 live frames
  (refilling at 50/s). A 64 KB ciphertext cap per element and 2,000 live
  elements per room bound storage.

## Chat and safety codes (Phase 7)

- Chat messages are encrypted in the browser with the room key. The server
  stores them split into `nonce` and `ciphertext` columns (the schema has no
  plaintext column) and cannot read them; the integration suite checks the
  stored bytes.
- Each message is bound to its room, its sender's user id and its own id. The
  server cannot move a message to another room, present Ada's words as Ben's,
  or replay a message under a new id: decryption fails. Message ids are
  chosen by the sender, so a retried send is recognised rather than
  duplicated, and nobody else can reuse an id.
- Only seated sockets can send; only members can read history; 20-message
  bursts, then one a second.
- **Safety codes.** Every member's public key has a 30-digit code (keyed
  BLAKE2b). People compare the code their screen shows for someone with the
  code that person reads out. A match proves the server did not substitute a
  key. The end-to-end test checks that two browsers compute the same codes.

## Hardening (Phase 7)

**Content-Security-Policy** for the web app, set by nginx on every response
(including fingerprinted assets, which nginx would otherwise serve without
the server-level headers):

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self';
img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self';
connect-src 'self' <API origin> <API ws origin> <storage origin>; worker-src 'self' blob:;
object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
```

No inline script is allowed at all; the production build has none, so nonces
(which exist to allow specific inline scripts) are unnecessary. The single
relaxation is `'wasm-unsafe-eval'`, which permits compiling libsodium's
WebAssembly and nothing else. Nothing in the app evaluates code: Zod is set to
jitless mode (otherwise it probes `Function('')` to decide whether to compile
validators, which the policy blocks but still reports as a violation), and
socket.io's `Function('return this')` global shim only runs where `self` is
undefined, which is never in a browser. The end-to-end suite verifies the
policy against the production image and runs sign-in (Argon2id in
WebAssembly) and encrypted chat under it with zero violations; it is what
caught both the Zod probe and a missing WebSocket origin in `connect-src`.

**Other headers.** `Permissions-Policy` allows camera, microphone and screen
capture for this origin only; `Referrer-Policy: no-referrer` (room links are
secrets); `Cross-Origin-Opener-Policy: same-origin`; `X-Content-Type-Options`;
`X-Frame-Options: DENY`; `Strict-Transport-Security` with a two-year max-age
(browsers apply it once served over TLS; add `preload` only with a committed
domain). The API, which serves only JSON, sends `default-src 'none';
frame-ancestors 'none'` and helmet's defaults, and caches CORS preflights for
10 minutes.

**Dependency audit.** `pnpm audit` found five advisories. Closed by overrides
in `pnpm-workspace.yaml`: `qs` (two, reachable through Express's query
parsing) and `mysql2` (two, pulled in by the Prisma CLI, never loaded).
Accepted: `deepmerge-ts` stack exhaustion on recursive objects, inside
Prisma's config loader, which merges only this repository's own static config;
fixing it means a major-version override inside Prisma.

## Deliberate trade-offs

- **Lockout as denial of service.** Five failed logins lock an email for 15
  minutes, so an attacker who knows your email can keep you locked out. This is
  the standard trade against online guessing; per-IP limits and CAPTCHA are the
  usual mitigations if it becomes a problem.
- **Revocation check fails open.** If Redis is down, a revoked session keeps
  working until its access token expires — at most 15 minutes — rather than
  every user being signed out. Login limiters fail closed (`503`) instead:
  refusing logins is better than allowing unlimited guessing.
- **A password reset loses your old keys.** The private key is locked with the
  password, and the server cannot unlock it (that is the point), so a reset
  clears the key pair. Rooms re-share their keys the next time another member
  is in a call with you; a room where nobody else still holds the key starts
  over with a new one, and files shared under the old key become unreadable.
- **The unlocked private key stays on the device** (IndexedDB, encrypted with
  a non-extractable WebCrypto key) so a reload does not ask for the password.
  This stops script from copying the key off the device, but a script running
  in the page while it is open could still use it. The strict CSP in Phase 7 is
  the defence against such a script existing at all. Sign-out deletes it.
- **Access tokens in memory** are lost on reload, costing one `/auth/refresh`
  per page load (a `401` in the console when signed out). The alternative,
  localStorage, is readable by any injected script.

## Also in place (Phase 0)

**Environment validation.** `apps/api/src/config/env.ts` parses every variable
with Zod at process start and exits with a readable message on failure. In
production it additionally refuses to boot if any secret still holds a
`change_me` placeholder.

**Log redaction.** `apps/api/src/lib/logger.ts` redacts `authorization` and
`cookie` headers, `set-cookie`, and any field named `password`, `passwordHash`,
`token`, `refreshToken`, `ciphertext`, or `encryptedPrivateKey`.

**CORS.** Exact-origin allowlist from `WEB_ORIGIN`, `credentials: true`, never a
wildcard.

**Payload caps.** JSON bodies capped at 1 MB (oversized and malformed bodies
return `413` / `400`, not `500`); Socket.IO `maxHttpBufferSize` at 1 MB.

**Error disclosure.** Unexpected errors return a generic message in production
and are logged server-side in full.

**Audit log.** Every auth event (register, verify, login success/failure,
lockout, reuse detection, logout, logout-all, password reset requested and
completed) writes an `AuditLog` row with IP
and user agent. Writes are fire-and-forget: an audit failure never fails the
user's request, but it is logged at error level.

**Supply chain.** pnpm's `minimumReleaseAge` is 1440 minutes, rejecting any
dependency published in the last 24 hours. Most compromised-publish attacks are
detected and unpublished well inside that window. It has blocked two
publishes during this build (`zod@4.6.4`, `nodemailer@10.0.10`); the fix both
times was to pin the previous version. **Do not lower it to unblock an install.**

**Build scripts.** Only `@prisma/engines`, `esbuild`, `prisma`, and `argon2` may
run lifecycle scripts (`allowBuilds` in `pnpm-workspace.yaml`).

**Container images.** `.dockerignore` keeps `.env` and host `node_modules` out
of every image; the API runs as the non-root `node` user.

**coturn relay restrictions.** `infra/coturn/turnserver.conf` denies relaying to
loopback, link-local, and RFC1918 ranges, so the TURN server cannot be used to
port-scan the host network.

## Not yet implemented

| Control                                     | Notes                               |
| ------------------------------------------- | ----------------------------------- |
| Warning when a member's safety code changes | Codes change only on password reset |
| Change password while signed in             | Reset by email works today          |
| TLS termination and HSTS preload            | Deployment concern; needs a domain  |
| Signed, separately distributed client       | See residual risks                  |

## Known gaps

- `.env.example` ships placeholder secrets. They are dev-only by construction —
  the production guard in `env.ts` rejects them — but never copy them onward.
- `JWT_REFRESH_SECRET` also keys the HMAC for stored token hashes. Rotating it
  invalidates every refresh token, pending verification link, and pending
  reset link at once.

- **Key authenticity rests on people comparing safety codes.** Holders seal
  the room key to the public key the server hands them for a requester. A
  malicious server could hand over its own key for a fake member. Keys
  cannot be replaced once set, keys are granted only to people visibly in the
  call, and safety codes make a substitution detectable, but only when
  someone compares them.
- **Encrypted metadata still leaks size and timing.** The server sees each
  file's approximate size, when it was shared, and by whom; for the board, how
  many elements there are, how big, who added them, and when.

## Reporting

This is a learning project and not deployed. If it ever is, add a contact and a
disclosure policy here.
