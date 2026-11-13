# 🍻 Drinking Buddies

Tinder-style app for finding someone to drink with nearby. Set where you're drinking
and what you're having, swipe on people who are out near you, and when you both
swipe right you match, chat and meet up.

## Run it

Requires **Node 22+** (pinned in `.nvmrc`; the server refuses to start on older versions).

```bash
nvm install && nvm use   # Node 22 from .nvmrc (or install Node 22 another way)
npm install
npm run db:start   # private PostgreSQL in ./data/pg (port 5433) — no sudo needed
                   # rate limits use your local Redis (redis://127.0.0.1:6379) if it's running
npm run dev        # DEMO=1: fake nearby verified users appear so you can test swiping/matching alone
ADMIN=yourname npm run dev:admin   # same, and makes `yourname` an admin (to approve your own selfie)
```

Open http://localhost:3000. In demo mode bots like you back 5–15 s after you like them, so you can
watch match notifications arrive. On a phone, browsers only allow GPS and the camera over **HTTPS**, so
use a tunnel (`cloudflared tunnel --url http://localhost:3000`) or type coordinates in the "enter it
manually" box.

**Tests:** `npm test` runs the API tests in `tests/` (Node's built-in runner). Each test file starts its own
server against a throwaway database on the dev Postgres, so run `npm run db:start` first. Set `DEV_PG_PORT` if
that Postgres isn't on 5433, or `TEST_DATABASE_URL` to use another server. Takes about 20 s.

**Settings:** copy `.env.example` to `.env` and fill in what you need. `npm start`, `npm run dev` and the
`db:`/`photos:` scripts load it automatically (Node 22's `--env-file`); real environment variables win
over the file, and `.env` is git-ignored.

Database commands: `npm run db:stop`, `npm run db:psql` (SQL shell), `npm run db:reset` (delete all
dev data), `npm run db:import [file]` (one-time import of the old `data/db.json` store; safe to re-run).
Any PostgreSQL 13+ works: set `DATABASE_URL` to use your own (the dev script is only a convenience).

## Database

PostgreSQL via `pg`. The schema lives in `db/migrations/*.sql` and is applied automatically on start
(each file once, tracked in `schema_migrations`; an advisory lock stops two servers migrating at once).
To change the schema, add `002_….sql`, never edit an applied file. Timestamps are epoch milliseconds
(`bigint`), matching `Date.now()` in the code. Photos are stored as `bytea`.

Things that must never happen twice are enforced by the database, not just the code — verified by a
test that fires simultaneous requests at two server instances sharing one database:

| Guarantee | How |
|---|---|
| One live match per pair, even if both like at the same instant | unique index on the pair |
| One verified account per phone / email / government ID | partial unique indexes |
| A Boost, deal code, promo slot or reset link is used once | single conditional `UPDATE … RETURNING` |
| One pending M-Pesa prompt per user / venue | partial unique index; row written before the STK push |
| A payment / receipt is applied once | `SELECT … FOR UPDATE` + unique receipt index |
| Max 6 photos, no gaps in their order | per-user row lock while editing photos |
| Failed-login and OTP attempts all count | atomic increments |

Sessions live in the database and rate limits in Redis, so any number of server instances can run
behind a load balancer. Expired sessions are cleaned hourly; audit entries are kept for a year.

## Rate limits (Redis)

Every limit (login, signup, OTP, email, password reset, swipes, messages, payments, uploads, the
general API budget…) is counted in Redis (`REDIS_URL`; dev default `redis://127.0.0.1:6379`), so all
instances share one count. Each check is one atomic Lua script (`INCR` + expiry), so simultaneous
requests on different servers are counted exactly, and every key expires with its window.
Keys look like `buddies:rl:login-user:<hash>`: the phone/email/username/IP part is SHA-256 hashed, so
no personal data sits in Redis. Change the prefix with `REDIS_PREFIX` if Redis is shared.

If Redis becomes unreachable, each instance falls back to in-memory limits (still enforced, just not
shared), logs a warning, and switches back by itself when Redis returns. `/api/health` reports
`rateLimits: "redis" | "fallback" | "memory"` so monitoring can alert on it. Set `REDIS_URL=` (empty)
to run without Redis on purpose. Production refuses to start without `REDIS_URL`.

## Deploy with Docker

**Image only** (bring your own Postgres, Redis and S3/R2 — e.g. managed services or a PaaS):

```bash
docker build -t drinking-buddies .
docker run -d --env-file .env -p 3000:3000 drinking-buddies
```

The image runs Node 22 as the unprivileged `node` user, contains only production dependencies and
the app code (no `.env`, no `data/`), has a `HEALTHCHECK` on `/api/health`, applies database
migrations on start, and shuts down cleanly on `SIGTERM`. It writes nothing outside `/app/data`
(only used by the local photo driver), so it can run with a read-only root filesystem. It needs all
production settings (see `.env.example`); it refuses to start with anything missing.

**Single server with Docker Compose** (app + Postgres + Redis + Caddy for automatic HTTPS):

```bash
cp .env.example .env     # set DOMAIN, POSTGRES_PASSWORD, REDIS_PASSWORD, APP_SECRET, ADMIN_USERS,
                         # VAPID keys, SMS/email/ID/M-Pesa keys and S3_* (or use MinIO below)
docker compose up -d --build
docker compose logs -f app
```

Point the domain's DNS at the server and open ports 80 and 443 first; Caddy fetches and renews the
certificate. Only Caddy is published to the internet; the app, database and Redis stay on the
internal network. The app container runs read-only with all Linux capabilities dropped.
For self-hosted photo storage add `--profile minio` (creates a private bucket; set the `S3_*` values
shown in `compose.yaml` and keep `PHOTO_DELIVERY=proxy`).

Back up the `pg-data` volume (or use `pg_dump`) and your photo bucket. Upgrades:
`git pull && docker compose up -d --build` (migrations run automatically).

## How it works

1. **Sign up** with username, name, date of birth (18+), phone, email and a strong password.
2. **Verify** (see below). Phone + email unlock the app; selfie + ID unlock liking and chat.
3. **"I'm out"**: drinking joint, drink, how long you're out (1–8 h), and GPS location.
   The status expires automatically.
4. **Swipe**: cards show fully verified people out right now within your radius, with distance,
   joint, drink, bio and up to 6 photos (tap the left/right edge or ↓ to flip; the middle opens details),
   plus what you share (**🍻 Same bar as you**, **Also on Tusker**) and timing
   (**Just arrived**, **Leaving soon**; times are rounded to 15 min). Order: Boosted, then people at
   your bar, then closest. Drag or flick (a fast short flick counts), tap a card (or ↑ / Enter) for
   more, ← / → to pass / like. Failed swipes put the card back; the deck preloads as you go; when it's
   empty it rechecks every 30 s and suggests a wider radius or a Boost.
5. **Match**: mutual right-swipe → "It's a match!" → chat, with a Directions link to their joint.
6. **Buy them a drink**: tap 🍺 in the chat, pick a drink and add a note. They get an offer
   card to Accept or Decline. Payment is settled at the bar for now (see
   `POST /api/matches/:id/drinks` in `server.js` to plug in M-Pesa later).
7. **Match notifications**: push notification (works with the app closed) plus an in-app popup
   and badge. On iPhone, push needs the app added to the Home Screen (iOS 16.4+).

## Buddies Plus & Boosts

Paid with M-Pesa (STK push) from **Profile → Buddies Plus** (`#/plus`). One-off payments; nothing auto-renews.

| | Free | Buddies Plus (KES 149/week · 499/month) |
|---|---|---|
| Likes | 25 per rolling 24 h | Unlimited |
| Who liked you | Count only (blurred) | See them and like back to match instantly |
| Search radius | 10 km | 50 km |
| Undo last pass | — | ↩ within the hour |
| Boosts | Buy them | +2 with the monthly plan |

**Boosts** (KES 50 each, or 5 for KES 200): 🚀 on the swipe screen puts you at the top of nearby feeds
for 30 minutes while you're out (it ends early if your "out" status does). One at a time.

All limits are enforced by the server (the app only shows them). Buying more Plus adds time on top
(up to a year ahead). Payments use the same protections as Featured billing below.

## Partner bars (Buddies for Business)

Bars manage their listing at **/partner.html** (also linked from Profile → "Own or manage a bar?").

1. **Apply**: any verified user registers a venue (name, area, address, KRA PIN, contact phone,
   map location). An admin checks it in **/admin.html → Venues** and approves, rejects, suspends
   or sets the plan (Basic / Featured).
2. **Get picked**: when people set "Where are you drinking?", nearby partner bars are listed
   (Featured first). Picking one uses the bar's official name, shows a PARTNER badge and the
   bar's deal on their card, and counts a check-in.
3. **Match deals**: when two people match and either is at a partner bar with a live deal, both
   see the same one-time code (`BUDDY-XXXXXX`, 24 h) in their chat. Staff type it into the
   **Redeem code** tab, which confirms it once and only at that venue.
4. **Quiet-night promos**: owners can send one push a day to verified people who are out within
   3 km **and opted in** (Profile → "Deals from partner bars nearby", off by default).
5. **Stats**: people here now, check-ins, matches made at the bar, redemptions, a 14-day chart,
   recent redemptions and promos. Totals only, never identities; audiences under 5 show as
   "fewer than 5".
6. **Team**: owners add staff by username (staff can redeem and see stats; only owners edit the
   deal, send promos or manage the team).

Venue name and location lock once approved. A venue whose owner deletes their account is
suspended. Every partner and admin action goes in the audit log.

### Featured billing (M-Pesa)

_The same payment engine (`lib/billing.js`) also sells Buddies Plus and Boosts._

Owners upgrade in the dashboard's **Billing** tab: pick **1 week** (KES 3,000) or **1 month**
(KES 10,000), confirm their Safaricom number, and approve the M-Pesa prompt (STK push) on their
phone. Featured time starts as soon as M-Pesa confirms, stacks on top of any remaining time (up to a
year ahead), and the owner gets an SMS receipt. Printable receipts are in the payment history. Owners
get an SMS 3 days before Featured ends. Admins see revenue, every payment, and anything held for review
in **/admin.html → Payments**, and can gift Featured days or end Featured from **Venues**.

How payments are protected:
- Safaricom's callback goes to a secret URL and must match a payment we started. Unknown or repeat
  callbacks are ignored.
- With real Daraja, every callback (paid *or* failed) is re-checked with Safaricom's STK query before
  anything changes, so a forged callback can't grant Featured or void a real payment.
- The amount must equal the price charged and each M-Pesa receipt can be used once. Anything else is
  held as **Needs review** and nothing is granted.
- If the callback never arrives (e.g. no public URL in testing), the dashboard's polling settles the
  payment by querying Safaricom.
- Only venue owners can pay or see billing; one pending payment per venue; attempts are rate-limited;
  every step is in the audit log. Phone numbers are masked in the UI.

Without Daraja keys in development, payments are **simulated** (no money moves; a number ending in
`000` simulates a cancelled payment). In production without keys, upgrades are switched off rather
than simulated.

Not done yet: KRA eTIMS tax invoices (receipts say they aren't one), automatic refunds (use the M-Pesa
portal), and auto-renewal (M-Pesa Ratiba standing orders could do this).

## Photos

Up to 6 per profile, managed in **Profile** (multi-select upload, ★ to make one the main photo, ✕ to
remove). Images are resized to 1080 px and re-encoded as JPEG in the browser before upload, which also
strips EXIF data such as GPS location. The **main** photo is the one the verification selfie is
checked against, so changing or removing it requires a new selfie check; extra photos can be added,
removed or reordered freely.

Photos are never embedded in API responses. Each has its own URL (`/api/photos/<user>/<photo>`)
that is only served to the owner, admins, and verified users who can see that profile (it's fully
verified) or are matched with them; everyone else gets a 404. Responses are `private, immutable`
cached (photo ids change on every upload). Admins can remove individual photos from **Reports**.

### Storage

The image files live in object storage; Postgres keeps only metadata and the object key.

| Driver | When | Settings |
|---|---|---|
| `s3` | Production: AWS S3, Cloudflare R2, Backblaze B2, MinIO… | `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`, `S3_ENDPOINT` (R2/MinIO), `S3_FORCE_PATH_STYLE=1` (MinIO), `S3_SSE` (e.g. `AES256` on AWS) |
| `local` | Development default: files in `./data/photos` (owner-only permissions) | `STORAGE_DIR` |

- **Keep the bucket private** (block all public access). Object keys are random (`photos/<id>-<random>.jpg`)
  and contain no user ids or names.
- **Delivery** — `PHOTO_DELIVERY=proxy` (default): the server checks access, then streams the bytes.
  `PHOTO_DELIVERY=redirect`: the server checks access, then answers with a 302 to a signed storage URL,
  so photo traffic goes straight to S3/R2 (or its CDN). Signed URLs are pinned to the current hour
  (valid 2 h), so they stay identical for an hour and browsers cache the image; unauthorised viewers
  still get a 404 and never see a URL. The storage host is added to the CSP `img-src` automatically.
- **No orphaned files** — uploads go to storage first and are deleted again if the database rejects
  the photo (e.g. over the 6-photo limit). When a photo row is deleted by any route (delete, replace,
  admin removal, account deletion), a database trigger queues its object in `storage_deletions`; a
  worker deletes it after the commit, retrying if storage is down. Several servers can share the queue.
- **Outages** — if storage is unreachable, uploads return 503 without saving anything, viewing returns
  503, and deletions wait in the queue. Nothing needs fixing afterwards.
- **Moving existing photos** — photos stored in Postgres before this change are still served from the
  database. `npm run photos:migrate` moves them to storage (safe while the app runs, safe to re-run).
- Verification selfies are still kept in the database briefly until an admin reviews them, then deleted.

## Account verification

| Step | How | Unlocks |
|---|---|---|
| 1. Phone | 6-digit SMS code (Africa's Talking). 10-min expiry, 5 tries, 60 s resend cooldown. One account per number. | — |
| 2. Email | Link (Resend), 24 h, single use. Opens on any device. One account per email. | Going out, browsing |
| 3. Selfie | Live camera photo copying a random pose; an admin compares it with the profile photo. Image deleted after review. Changing your profile photo requires a new selfie. | — |
| 4. Government ID | National ID / passport / alien ID checked against the registry (Smile ID). Only a keyed fingerprint of the number is stored, so one account per ID. Sets your age and locks your display name to your real first name. Under-18 → account suspended. | Liking, matching, chat, drink offers, appearing in the feed |

Admins (usernames in `ADMIN_USERS`, must have a verified phone) review selfies, handle
reports and bans, and read the audit log at **/admin.html**.

## Security

- **Sessions**: random 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie (`__Host-` + `Secure`
  in production), stored server-side only as a SHA-256 hash. 30-day absolute / 7-day idle expiry.
  Logout, log out of all devices, and password change/reset revoke sessions.
- **CSRF**: SameSite cookies, a required `X-CSRF` header, and an Origin check on every write.
- **Passwords**: scrypt, minimum 8 characters, common-password list, can't contain your
  username/phone/email. Constant-time comparison; unknown usernames take the same time as known ones.
- **Brute force**: per-IP and per-account rate limits on login, signup, OTP, email, reset, swipes,
  messages, reports and ID checks. 5 wrong passwords → account locked for 15 min (+ SMS/email alert).
- **Account recovery**: reset link to the verified email (30 min, single use), same response
  whether or not the account exists, all sessions revoked afterwards, alert sent.
- **Privacy**: others only see a rounded distance (never coordinates), never your phone,
  email, ID or DOB. Selfies are deleted after review; ID numbers are never stored.
  Users can delete their account and data.
- **Safety**: 3 reports from different people hide someone from the feed until an admin
  reviews; admins can ban; banned users are logged out everywhere.
- **Headers**: strict Content-Security-Policy (no inline scripts), `X-Frame-Options: DENY`,
  `nosniff`, `Referrer-Policy: no-referrer`, HSTS in production, `no-store` on API responses.
- **Audit log** of logins, failed logins, lockouts, verification events, password changes,
  reports and admin actions.
- **Links** in emails are built from `APP_URL` (never the request's Host header), and tokens
  sit in the URL fragment so they don't reach server logs and email link-scanners can't trigger them.
- **Data files** (`data/`) are written owner-read-only (0600).
- **Production guard**: with `NODE_ENV=production` the server refuses to start unless all real
  providers and secrets are configured, so OTPs can never fall back to the console.

## Configuration

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Postgres connection string (dev default: `postgres://buddies@127.0.0.1:5433/buddies`) |
| `DATABASE_SSL=1` | Use TLS to the database (most managed Postgres); `DATABASE_SSL_INSECURE=1` skips cert checks |
| `DB_POOL_SIZE` | Connections per server instance (default 10) |
| `REDIS_URL` | Redis for shared rate limits (`rediss://` for TLS; dev default `redis://127.0.0.1:6379`) |
| `REDIS_PREFIX` | Key prefix (default `buddies:`) |
| `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | Photo storage (any S3-compatible service) — required in production |
| `S3_REGION`, `S3_ENDPOINT`, `S3_FORCE_PATH_STYLE`, `S3_SSE` | `auto` + `https://<account>.r2.cloudflarestorage.com` for R2; path-style for MinIO; server-side encryption |
| `STORAGE_DRIVER`, `STORAGE_DIR` | `local` to store photos on disk (dev default `./data/photos`) |
| `PHOTO_DELIVERY` | `proxy` (default) or `redirect` (signed URLs straight from storage) |
| `NODE_ENV=production` | Enables production checks, `Secure` cookies, HSTS |
| `APP_URL` | Public https URL, used in email links |
| `APP_SECRET` | 32+ random chars; keys OTP and ID fingerprints (dev: auto-generated in `data/secret.json`) |
| `ADMIN_USERS` | Comma-separated admin usernames |
| `AT_USERNAME`, `AT_API_KEY`, `AT_SENDER_ID` | Africa's Talking SMS (`AT_USERNAME=sandbox` for their sandbox) |
| `RESEND_API_KEY`, `EMAIL_FROM` | Email via Resend (`EMAIL_FROM` like `Drinking Buddies <no-reply@yourdomain>`) |
| `SMILE_PARTNER_ID`, `SMILE_API_KEY`, `SMILE_ENV` | Smile ID KYC (`SMILE_ENV=production` for live, otherwise sandbox) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | Web Push keys |
| `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET` | Daraja app credentials |
| `MPESA_SHORTCODE`, `MPESA_PASSKEY` | Lipa Na M-Pesa Online shortcode + passkey (sandbox: 174379) |
| `MPESA_ENV` | `production` for live, otherwise sandbox |
| `MPESA_TYPE`, `MPESA_TILL` | `MPESA_TYPE=till` + till number for Buy Goods; default is Paybill |
| `MPESA_CALLBACK_IPS` | Optional comma-separated allowlist of Safaricom callback IPs (needs `TRUST_PROXY` behind a proxy) |
| `FEATURED_WEEK_KES`, `FEATURED_MONTH_KES` | Featured prices (default 3000 / 10000) |
| `PLUS_WEEK_KES`, `PLUS_MONTH_KES`, `BOOST_1_KES`, `BOOST_5_KES` | Plus and Boost prices (default 149 / 499 / 50 / 200) |
| `FREE_LIKES_PER_DAY` | Free plan like limit (default 25) |
| `TRUST_PROXY` | Set to `1` only when behind a reverse proxy/load balancer, so rate limits see real client IPs |

Without provider keys (development), OTP codes and email links print to the server console and are
shown in a yellow "Dev mode" box in the app; ID checks use a mock (any ID number ending in `0000` fails).

## Structure

| File | What |
|---|---|
| `server.js` | Express API: auth, verification, status, feed, swipes, matches, chat, admin |
| `lib/db.js` | Postgres pool, transactions, migrations, user row mapping |
| `db/migrations/` | SQL schema (applied automatically on start) |
| `scripts/dev-db.sh` | Private dev Postgres (`npm run db:*`) |
| `Dockerfile`, `.dockerignore` | Production image |
| `compose.yaml`, `deploy/Caddyfile` | Single-server deployment with HTTPS |
| `.env.example` | Every setting, documented |
| `scripts/import-json.js` | One-time import from the old JSON store |
| `lib/security.js` | Passwords, tokens, rate-limit middleware, cookies, security headers |
| `lib/storage.js` | Photo storage drivers (S3-compatible, local), signed URLs |
| `scripts/migrate-photos.js` | Moves photos still in Postgres to storage (`npm run photos:migrate`) |
| `lib/ratelimit.js` | Redis-backed limiter (atomic Lua script, hashed keys, in-memory fallback) |
| `lib/providers.js` | SMS (Africa's Talking), email (Resend), ID checks (Smile ID) + dev fallbacks |
| `public/account.js` | Verification, password reset and account security screens |
| `lib/mpesa.js`, `lib/billing.js` | Daraja STK push/query client; product catalog (Featured, Plus, Boosts), payments, callbacks, reminders |
| `public/plus.js` | Plus & Boost store, who-liked-you, upsells, Boost button |
| `lib/partners.js` | Partner venues: applications, deals & codes, promos, staff, stats, admin review |
| `public/partner.html`, `partner.js` | Buddies for Business dashboard |
| `public/admin.html`, `admin.js` | Admin console: selfie review, venues, reports & bans, audit log |
| `public/app.js` | Single-page frontend (hash routing, swipe gestures, chat polling) |
| `public/style.css` | Mobile-first dark UI |
| `public/sw.js`, `manifest.json` | PWA: installable to the home screen |

## Before a real launch

- Managed Postgres with automated backups (point-in-time recovery) and TLS (`DATABASE_SSL=1`). Add PostGIS if feeds ever need more than the lat/lng box index.
- WebSockets for real-time chat (now polls every 2.5 s) and push notifications for new messages / drink offers.
- Test Smile ID and Africa's Talking with sandbox keys; review the KYC field mapping in `lib/providers.js`.
- Managed Redis (any Redis 6+ or Valkey) with TLS (`rediss://…`) and a password; alert when `/api/health` shows `rateLimits: "fallback"`.
- Two-factor login for admin accounts; a privacy policy and terms (Kenya Data Protection Act registration).
- Create a private S3/R2 bucket (block public access, versioning or lifecycle rules for recovery), set
  the `S3_*` settings, run `npm run photos:migrate` once, and consider `PHOTO_DELIVERY=redirect` behind a CDN.
- Test M-Pesa end-to-end with Daraja sandbox keys and a public https `APP_URL` (the callback must be reachable), then go live.
- Real payment for drink offers (M-Pesa Daraja STK push / card), with a refund if declined.
- Native wrappers (Capacitor) if you want it in the Play Store / App Store.
