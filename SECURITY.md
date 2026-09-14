# Security

Full threat model lands in **Phase 7**. This file records what is already true,
so the gap between intent and implementation stays visible.

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

| Limit                    | Scope     | Window | Redis down  |
| ------------------------ | --------- | ------ | ----------- |
| 100 requests             | per IP    | 1 min  | fail open   |
| 5 failed logins          | per email | 15 min | fail closed |
| 10 registrations         | per IP    | 1 h    | fail closed |
| 3 verification re-sends  | per email | 1 h    | fail closed |
| 20 verification attempts | per IP    | 1 h    | fail closed |
| 3 reset emails           | per email | 1 h    | fail closed |
| 10 reset requests        | per IP    | 1 h    | fail closed |
| 20 reset submissions     | per IP    | 1 h    | fail closed |
| 30 room joins            | per user  | 1 min  | fail open   |

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

## Deliberate trade-offs

- **Lockout as denial of service.** Five failed logins lock an email for 15
  minutes, so an attacker who knows your email can keep you locked out. This is
  the standard trade against online guessing; per-IP limits and CAPTCHA are the
  usual mitigations if it becomes a problem.
- **Revocation check fails open.** If Redis is down, a revoked session keeps
  working until its access token expires — at most 15 minutes — rather than
  every user being signed out. Login limiters fail closed (`503`) instead:
  refusing logins is better than allowing unlimited guessing.
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

| Control                                          | Phase |
| ------------------------------------------------ | ----- |
| Ephemeral HMAC-derived TURN credentials          | 3     |
| Client-side file encryption (XChaCha20-Poly1305) | 5     |
| Room keys, sealed-box key wrapping, E2EE chat    | 7     |
| Strict nonce-based CSP, HSTS preload             | 7     |
| Documented threat model                          | 7     |
| Change password while signed in                  | —     |

## Known gaps

- `helmet` runs with `contentSecurityPolicy: false`. The strict nonce-based CSP
  is a Phase 7 deliverable and belongs on the nginx config that serves the web
  app, not on the JSON API.
- `.env.example` ships placeholder secrets. They are dev-only by construction —
  the production guard in `env.ts` rejects them — but never copy them onward.
- `JWT_REFRESH_SECRET` also keys the HMAC for stored token hashes. Rotating it
  invalidates every refresh token, pending verification link, and pending
  reset link at once.

## Reporting

This is a learning project and not deployed. If it ever is, add a contact and a
disclosure policy here.
