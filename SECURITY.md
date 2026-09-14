# Security

Full threat model lands in **Phase 7**. This file records what is already true,
so the gap between intent and implementation stays visible.

## Implemented in Phase 0

**Environment validation.** `apps/api/src/config/env.ts` parses every variable
with Zod at process start and exits with a readable message on failure. In
production it additionally refuses to boot if any secret still holds a
`change_me` placeholder.

**Log redaction.** `apps/api/src/lib/logger.ts` redacts `authorization` and
`cookie` headers, `set-cookie`, and any field named `password`, `passwordHash`,
`token`, `refreshToken`, `ciphertext`, or `encryptedPrivateKey`. Redaction is
configured centrally rather than left to per-call-site discipline.

**CORS.** Exact-origin allowlist from `WEB_ORIGIN`, `credentials: true`, never a
wildcard - required for the Phase 1 refresh-token cookie to be safe.

**Payload caps.** JSON bodies capped at 1MB; Socket.IO `maxHttpBufferSize` at
1MB, so one message cannot exhaust memory.

**Error disclosure.** The error handler returns a generic message in production
and logs the detail server-side. Unexpected errors never reach the client.

**Supply chain.** pnpm's `minimumReleaseAge` is set to 1440 minutes, rejecting
any dependency published in the last 24 hours. Most compromised-publish attacks
are detected and unpublished well inside that window. During Phase 0 this
correctly blocked `zod@4.6.4` (published roughly 26h earlier); the fix was to
pin `4.6.2`, not to lower the threshold. **Do not lower it to unblock an
install.**

**Build scripts.** Only `@prisma/engines`, `esbuild`, `prisma`, and `argon2` may
run lifecycle scripts (`allowBuilds` in `pnpm-workspace.yaml`). Every other
dependency installs inert.

**coturn relay restrictions.** `infra/coturn/turnserver.conf` denies relaying to
loopback, link-local, and RFC1918 ranges, so the TURN server cannot be used to
port-scan the host network.

## Not yet implemented

| Control                                            | Phase |
| -------------------------------------------------- | ----- |
| Argon2id password hashing (64MB, t=3)              | 1     |
| Refresh-token rotation with family reuse detection | 1     |
| Redis-backed sliding-window rate limits            | 1     |
| Socket handshake authentication                    | 1     |
| Per-event authorization (membership + role)        | 2     |
| Ephemeral HMAC-derived TURN credentials            | 3     |
| Client-side file encryption (XChaCha20-Poly1305)   | 5     |
| Room keys, sealed-box key wrapping, E2EE chat      | 7     |
| Strict nonce-based CSP, HSTS preload               | 7     |
| Audit logging                                      | 7     |
| Documented threat model                            | 7     |

## Known gaps

- `helmet` runs with `contentSecurityPolicy: false`. The strict nonce-based CSP
  is a Phase 7 deliverable and belongs on the nginx config that serves the web
  app, not on the JSON API.
- `.env.example` ships placeholder secrets. They are dev-only by construction -
  the production guard in `env.ts` rejects them - but never copy them onward.
- No authentication exists yet. Every endpoint is currently public. That is
  expected at Phase 0 and is the whole subject of Phase 1.

## Reporting

This is a learning project and not deployed. If it ever is, add a contact and a
disclosure policy here.
