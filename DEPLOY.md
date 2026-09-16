# Deploying Confluence

One container serves the API and the web app from a single origin, and the
database, Redis, file storage, email and the TURN relay are services you
create elsewhere. Everything below has a free tier.

| Piece           | Service used here     | Why it is not in the container                     |
| --------------- | --------------------- | -------------------------------------------------- |
| App + API       | Render (Docker)       | —                                                  |
| Postgres        | Neon                  | container storage is wiped on every deploy         |
| Redis           | Upstash               | same, and it is shared between instances           |
| Encrypted files | Cloudflare R2         | same, and files outlive any one container          |
| Email           | Gmail SMTP            | see the Email section of `.env.example`            |
| Video relay     | a hosted TURN service | TURN needs UDP ports app platforms do not give you |

**One origin, on purpose.** The session cookie is `SameSite=Strict` and the
API allows exactly one origin, so the app and the API must be the same site.
`something.onrender.com` and `other.onrender.com` are _different_ sites to a
browser (`onrender.com` is a public suffix), which is why this is one service
rather than two.

## 1. Postgres (Neon)

1. Create a project at https://neon.tech (free, no card).
2. Copy the **pooled** connection string. It looks like
   `postgresql://user:password@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require`.
3. Keep it for `DATABASE_URL`.

## 2. Redis (Upstash)

1. Create a Redis database at https://upstash.com.
2. Copy the connection URL that starts with `rediss://` (TLS).
3. Keep it for `REDIS_URL`. Check their free-tier request limit: presence and
   rate limiting run a few commands per request.

## 3. File storage (Cloudflare R2)

1. Create a bucket at https://dash.cloudflare.com → R2 (a card is required
   even on the free allowance; Backblaze B2 or Supabase Storage work the same
   way if you would rather not).
2. Create an API token with **Object Read & Write** for that bucket, and keep
   the access key id and secret.
3. Values to keep:
   - `S3_ENDPOINT` and `S3_PUBLIC_ENDPOINT`:
     `https://<account-id>.r2.cloudflarestorage.com`
   - `S3_REGION`: `auto`
   - `S3_BUCKET`: the bucket name
4. **CORS matters.** Browsers upload and download files directly to the
   bucket with presigned URLs, so add a CORS rule allowing your app's origin:

   ```json
   [
     {
       "AllowedOrigins": ["https://<your-service>.onrender.com"],
       "AllowedMethods": ["GET", "PUT"],
       "AllowedHeaders": ["*"],
       "ExposeHeaders": ["ETag"],
       "MaxAgeSeconds": 3000
     }
   ]
   ```

   Without it, uploads fail in the browser with an opaque network error.

## 4. Video relay (TURN)

Calls connect browser to browser, but roughly one connection in six needs a
relay (strict company networks, some mobile carriers).

**Cloudflare Realtime, which this repo prefers.** In the Cloudflare dashboard
→ Realtime → TURN, create a key and keep `CLOUDFLARE_TURN_TOKEN_ID` and
`CLOUDFLARE_TURN_API_TOKEN`. The API asks Cloudflare for a short-lived
credential each time someone joins, so there is no shared secret to rotate and
the token never reaches a browser. If Cloudflare is unreachable, joining still
works and falls back to whatever else is configured; only calls that actually
need a relay suffer.

**Any other service** (Metered, Twilio) instead, with fixed credentials:

- `TURN_URLS`: comma-separated, e.g.
  `stun:stun.example.com:3478,turn:relay.example.com:3478?transport=udp,turn:relay.example.com:3478?transport=tcp`
- `TURN_USERNAME` and `TURN_PASSWORD`: the credentials it issued

Set these and the bundled coturn is not used at all. Free tiers are metered
by relayed traffic, which is only used for calls that cannot connect directly.

## 5. Email that a free host can send

**Render blocks outbound SMTP (ports 25, 465 and 587) on free web services**,
so Gmail is unreachable from a free instance: the connection times out no
matter how it is configured. Two ways round it:

- **Send over HTTPS instead**, which is never blocked. Create a free account
  at https://www.brevo.com, verify your own email address as a sender
  (Senders → Add a sender; no domain needed), and create an API key under
  SMTP & API → API Keys. Then set `MAIL_TRANSPORT=brevo` and
  `BREVO_API_KEY=<the key>`, and leave the `SMTP_*` variables unset. Free
  tier: around 300 emails a day.
- **Or upgrade the Render service to a paid instance**, where SMTP ports are
  open and the Gmail settings work as written.

Either way `MAIL_FROM` must be an address the provider is allowed to send
from: the Gmail address for SMTP, the verified sender for Brevo. Paste it
into the dashboard **without quotes** — `Confluence <you@gmail.com>`, not
`"Confluence <you@gmail.com>"`. A `.env` file needs those quotes to keep the
space; a dashboard stores them as part of the value.

## 6. The app (Render)

1. Push this repository to GitHub.
2. At https://dashboard.render.com → **New → Blueprint**, pick the repo.
   Render reads `render.yaml` and creates one web service.
3. Fill in the environment variables it asks for (everything marked
   `sync: false`), using the values collected above plus, for email:
   `SMTP_HOST=smtp.gmail.com`, `SMTP_USER=<your gmail>`,
   `SMTP_PASS=<App Password>`, `MAIL_FROM="Confluence <your gmail>"`.
4. Deploy. The first build takes several minutes: it compiles the API and the
   web app inside Docker.
5. Once the URL exists (`https://confluence-xxxx.onrender.com`), set
   `WEB_ORIGIN` to exactly that URL and redeploy. The API refuses requests
   from any other origin, so this must match, without a trailing slash.

## 7. Create the database tables

The container does not migrate on start: a half-finished deploy must never
alter a live database. Run it once from your machine, and again whenever a
migration is added:

```bash
DATABASE_URL="<the Neon URL>" pnpm --filter @confluence/api exec prisma migrate deploy
```

## 8. Check it

1. Open the URL, sign up, and follow the link in the email.
2. Start a meeting, open the invite link in another browser, and confirm
   video, chat, files and the whiteboard work.
3. Test from a phone on mobile data, not your Wi-Fi: that is the path that
   exercises TURN.

## When something does not work

`GET /healthz` on the deployed URL reports every dependency, and is the
fastest way to tell configuration from code:

```json
{ "status": "ok", "dependencies": { "postgres": {...}, "redis": {...},
  "storage": {...}, "mail": {...} } }
```

- **`mail` reports a timeout.** The host is blocking outbound SMTP, which is
  what a free Render service does. Switch to `MAIL_TRANSPORT=brevo` (step 5)
  or upgrade the instance; no SMTP setting fixes it.
- **Emails are rejected with "valid sender email required" or "sender name is
  missing".** `MAIL_FROM` is not a usable address: quotes around the whole
  value, or an address with no name. The API now strips stray quotes, adds a
  name when there is none, and refuses to start on a value that is not an
  address at all.
- **`mail` reports a rejected login or key.** For Gmail, `SMTP_PASS` must be
  a 16-character App Password with the spaces removed, and `MAIL_FROM` must
  contain that same address. For Brevo, the key must be valid and the sender
  in `MAIL_FROM` verified in their dashboard.
- **`storage` is up but sharing a file fails in the browser.** The bucket has
  no CORS rule for your origin; see step 3.
- **Sign-in works but the session is lost on reload.** `WEB_ORIGIN` does not
  match the address in the browser, exactly, including `https://` and no
  trailing slash.
- **Calls connect on the same network but not across networks.** The TURN
  settings are missing or rejected; the log line `Cloudflare TURN
unavailable` names the reason.

## What free costs you

- **The service sleeps after 15 minutes of inactivity.** The next visitor
  waits around a minute, and anyone in a call when it stops is disconnected.
  Render's Starter plan (about $7/month) removes this, and is the single
  change worth making before real users arrive.
- **One instance.** Redis already coordinates presence and signalling across
  instances, so raising the instance count works, but only on a paid plan.
- **Backups.** Neon keeps a short restore window on the free plan. Before
  anything you would hate to lose, take your own dump:
  `pg_dump "<DATABASE_URL>" -Fc -f confluence-$(date +%F).dump`

## Custom domain

A domain makes the URL yours and survives moving off Render. In Render →
Settings → Custom Domains, add `app.yourdomain.com`, create the CNAME record
it shows you, then set `WEB_ORIGIN` to `https://app.yourdomain.com`, update
the R2 CORS origin, and redeploy. Certificates are issued automatically.
