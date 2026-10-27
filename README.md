# PBAT DOOR TO DOOR

The volunteer website for the PBAT DOOR TO DOOR movement, served at **https://pbatdoor2door2027.org** (`www` redirects to it).

- **Landing page** (`/`): the movement and its Founder & Convener, Tompolo; the President's photo, a short bio timeline, and the administration's works, each linked to its source.
- **Join or log in** (`/login`; `/join` and `/signup` redirect here): type an email **or** a Nigerian phone number, then the 6-digit code. The first sign-in creates the account.
- **My account** (`/account`; `/welcome` redirects here): "Complete your profile" (full name, state and LGA required; the rest optional), edit details, link a second email or phone (which merges duplicate accounts), see signed-in devices, log out of one or all devices. Sessions last until the member logs out.
- **Polling units**: state → LGA → ward → polling unit lists from INEC data (176,846 units) in `public/geo/`, plus **"near me"**, which suggests the closest units from the phone's GPS (`/api/geo/near`).

It runs as three containers on one server: **Caddy** (HTTPS), the **Node.js app**, and **PostgreSQL**, plus a small **backup** container.

Repository: https://github.com/PBAT-DOOR-2-DOOR/pbatdoor2door2027 · on the server it lives at **`/opt/pbatdoor2door`** and is operated by the user **`user1`**.

---

## Contents

1. [Local development](#1-local-development)
2. [Server setup (fresh Ubuntu 24.04 Linode)](#2-server-setup-fresh-ubuntu-2404-linode)
3. [DNS on Cloudflare](#3-dns-on-cloudflare)
4. [Email (Brevo or ZeptoMail) and phone sign-in](#4-email-and-phone-sign-in)
5. [First deploy](#5-first-deploy)
6. [Updates](#6-updates)
7. [Backups and restore](#7-backups-and-restore)
8. [Environment variables](#8-environment-variables)
9. [Operations cheat sheet and troubleshooting](#9-operations-cheat-sheet-and-troubleshooting)
10. [Tests](#10-tests)
11. [What changed from the original app, and why](#11-what-changed-from-the-original-app-and-why)

---

## 1. Local development

Needs Docker (Docker Desktop on macOS/Windows).

```bash
git clone https://github.com/PBAT-DOOR-2-DOOR/pbatdoor2door2027.git
cd pbatdoor2door2027
printf 'NODE_ENV=development\n' > .env      # codes shown on screen; phone codes in the log
docker compose up --build                  # http://localhost:3000
```

This starts Postgres and the app only (Caddy and backups are in the `prod` profile). Without an email provider, the sign-in code is shown on the page in development and is always written to the log (`docker compose logs -f app`).

To work on the code without rebuilding the image, run Postgres in Docker and Node 22 on your machine:

```bash
# Postgres isn't published outside Docker by default. Publish it locally with an override file
# (git-ignored, picked up automatically by docker compose; never create it on the server):
printf 'services:\n  db:\n    ports: ["127.0.0.1:5432:5432"]\n' > docker-compose.override.yml
docker compose up -d db
npm install
DATABASE_URL=postgres://pbat:pbat-local-dev-only@127.0.0.1:5432/pbat NODE_ENV=development npm run dev
```

Editing content:

- **His works**: the `WORKS` list near the bottom of `public/index.html`.
- **Photos**: add your own to `public/images/` (`hero.jpg`, `gallery-1.jpg` … `gallery-5.jpg`); they replace the default Wikimedia Commons photos automatically. Only use photos you have the right to use.
- **Form options** (states, interests): `validate.js`.

Inline scripts in the pages are allowed by hash in the Content-Security-Policy, computed automatically when the app starts, so editing a page needs no security change, only a deploy.

---

## 2. Server setup (fresh Ubuntu 24.04 Linode)

Server: **IPv4 `172.237.115.143`**, **IPv6 `2600:3c13::2000:f3ff:fe9e:b734`**. A 2 GB plan is comfortable; on 1 GB the setup script adds swap.

### 2a. Linode Cloud Firewall

The Linode has a Cloud Firewall attached. In Cloud Manager → Firewalls → (the firewall) → Rules, set:

| Direction | Protocol | Ports | Sources | Action |
|---|---|---|---|---|
| Inbound | TCP | 22 | All IPv4, All IPv6 (or just your own IPs) | Accept |
| Inbound | TCP | 80 | All IPv4, All IPv6 | Accept |
| Inbound | TCP | 443 | All IPv4, All IPv6 | Accept |
| Inbound | UDP | 443 | All IPv4, All IPv6 | Accept (HTTP/3, optional) |
| Inbound | default policy | | | **Drop** |
| Outbound | default policy | | | Accept |

Port 80 must stay open: Let's Encrypt uses it to issue and renew certificates, and Caddy uses it to redirect to HTTPS. The server also runs its own firewall (ufw) with the same rules.

### 2b. Run the setup script (once, as root)

Log in as root with your SSH key (or use the Linode LISH console), then:

```bash
curl -fsSLO https://raw.githubusercontent.com/PBAT-DOOR-2-DOOR/pbatdoor2door2027/main/scripts/server-setup.sh
# private repo? copy it from your computer instead:  scp scripts/server-setup.sh root@172.237.115.143:
bash server-setup.sh
```

`scripts/server-setup.sh` is safe to re-run. It:

1. installs updates and base packages, and turns on automatic security updates (`unattended-upgrades`);
2. creates **`user1`** in the `sudo` group (sudo asks for user1's password; the script asks you to choose it), and copies root's `authorized_keys` to it;
3. installs **Docker Engine and the compose plugin from Docker's official apt repository**, and adds user1 to the `docker` group;
4. enables **ufw**: deny inbound except 22/tcp, 80/tcp, 443/tcp, 443/udp;
5. adds 2 GB of swap if the server has less than 4 GB RAM and no swap;
6. creates **`/opt/pbatdoor2door`** owned by user1, clones the repository there, and creates `/opt/pbatdoor2door/.env` (mode 600) from `.env.example` with a generated `POSTGRES_PASSWORD` and the right `BACKUP_UID`/`BACKUP_GID`.

> Membership of the `docker` group is equivalent to root on this server. Only give it to people you'd give root.

**Private repository.** The script first tries an anonymous HTTPS clone. If that fails, it creates a deploy key for user1 (`/home/user1/.ssh/pbat_deploy`), prints its public key, and stops. Add it on GitHub under the repo's **Settings → Deploy keys → Add deploy key** (leave "Allow write access" off), then run `bash server-setup.sh` again. Later `git pull`s by `scripts/deploy.sh` use the same key.

Alternatively, use the developer's own credentials: as user1, `git clone https://github.com/PBAT-DOOR-2-DOOR/pbatdoor2door2027.git /opt/pbatdoor2door` with a GitHub fine-grained personal access token (read-only "Contents" on this one repo) as the password, then `git config credential.helper store` so pulls don't prompt. A deploy key is preferable because it isn't tied to a person and can only read this repo.

### 2c. Optional final step: disable root SSH login

**Only after** you've confirmed, in a new terminal, that `ssh user1@172.237.115.143` works and `sudo -v` accepts user1's password:

```bash
DISABLE_ROOT_SSH=1 bash server-setup.sh     # as root
```

This turns off root logins and password logins over SSH (keys only). It refuses to run if user1 has no SSH keys or isn't in `sudo`. The LISH console in Cloud Manager still works if you ever lock yourself out.

---

## 3. DNS on Cloudflare

The domain's DNS is on Cloudflare; email for the domain is on Zoho Mail. In Cloudflare → the domain → DNS → Records:

| Type | Name | Content | Proxy status |
|---|---|---|---|
| A | `@` | `172.237.115.143` | **DNS only** (grey cloud) |
| AAAA | `@` | `2600:3c13::2000:f3ff:fe9e:b734` | **DNS only** |
| A | `www` | `172.237.115.143` | **DNS only** |
| AAAA | `www` | `2600:3c13::2000:f3ff:fe9e:b734` | **DNS only** |
| MX | `@` | `mx.zoho.com` (10), `mx2.zoho.com` (20), `mx3.zoho.com` (50) | — keep as they are |
| TXT | `@` | `v=spf1 include:zohomail.com include:spf.brevo.com ~all` | — (see section 4) |

Remove any other A/AAAA/CNAME records for `@` and `www` (for example registrar parking). If there are CAA records, one must allow `letsencrypt.org`.

**Why "DNS only"**: Caddy gets certificates from Let's Encrypt by answering on this server's port 80, and the app limits sign-in codes per visitor IP. With Cloudflare's proxy (orange cloud) in the way, every request appears to come from Cloudflare, so all visitors would share a handful of IPs and hit the limit. Grey cloud avoids both problems and is the default (`PROXY_MODE=direct`).

Check from your computer once the records are saved:

```bash
dig +short A pbatdoor2door2027.org; dig +short AAAA pbatdoor2door2027.org
dig +short A www.pbatdoor2door2027.org; dig +short AAAA www.pbatdoor2door2027.org
```

### Optional: using Cloudflare's proxy (orange cloud)

Supported, if you want Cloudflare's caching or DDoS protection:

1. Do the first deploy with **DNS only**, so Caddy obtains its certificates directly.
2. In `.env`, set `PROXY_MODE=cloudflare`, then `docker compose up -d caddy`. Caddy then trusts Cloudflare's published IP ranges (`deploy/caddy/proxy-cloudflare.caddy`) and takes the visitor's IP from the `CF-Connecting-IP` header, but only for requests that really come from Cloudflare (from anyone else the header is ignored, so it can't be spoofed).
3. In Cloudflare: SSL/TLS → Overview → **Full (strict)**. Leave **Always Use HTTPS off** (Caddy already redirects, and certificate renewals need plain HTTP on `/.well-known/acme-challenge/` to reach the server).
4. Switch the four A/AAAA records to **Proxied**.
5. Cloudflare's IP list rarely changes; to refresh it, run `scripts/update-cloudflare-ips.sh` then `docker compose restart caddy`.

To go back, set `PROXY_MODE=direct`, `docker compose up -d caddy`, and grey-cloud the records.

---

## 4. Email and phone sign-in

### Email: Brevo (recommended)

**Linode blocks outbound SMTP** (ports 25/465/587) on new accounts, so use an HTTPS email API. Brevo, ZeptoMail, Resend and the Gmail Apps Script all work; `SMTP_*` will time out unless Linode lifts the block.

1. Brevo → SMTP & API → API keys → create a key; put it in `BREVO_API_KEY`.
2. Brevo → Senders, Domains & Dedicated IPs → Domains → **Add/Authenticate** `pbatdoor2door2027.org`. Add exactly the records Brevo shows in Cloudflare (all are DNS-only by nature): the `brevo-code:…` TXT, the DKIM records (`brevo1._domainkey`, `brevo2._domainkey`) and a DMARC record if you don't have one, for example `_dmarc` TXT `v=DMARC1; p=none; rua=mailto:dmarc@pbatdoor2door2027.org`.
3. **SPF: the domain can have only one SPF record.** Zoho's is `v=spf1 include:zohomail.com ~all`. **Edit that record** (don't add a second one) so it becomes:

   ```
   v=spf1 include:zohomail.com include:spf.brevo.com ~all
   ```

4. Set `MAIL_FROM="PBAT DOOR TO DOOR <no-reply@pbatdoor2door2027.org>"`.
5. If Brevo's **Authorised IPs** security option is on, add `172.237.115.143` and `2600:3c13::2000:f3ff:fe9e:b734`, or API calls from the server are rejected.
6. After deploying, sign in with a Gmail address and check that the code arrives in the inbox (not spam). mail-tester.com gives a deliverability score.

### Email: Zoho ZeptoMail (alternative)

ZeptoMail is Zoho's transactional email service, a natural fit since the domain already uses Zoho Mail. In ZeptoMail, add and verify the domain (add the DKIM and bounce/CNAME records it shows, in Cloudflare as DNS only; if it asks for an SPF include, merge it into the same single SPF record as above). Create a Mail Agent → SMTP/API → copy the **Send Mail token** into `ZEPTOMAIL_TOKEN` (with or without its `Zoho-enczapikey ` prefix), and set `MAIL_FROM` to an address on the verified domain. For a Zoho account hosted in the EU data centre, also set `ZEPTOMAIL_API_URL=https://api.zeptomail.eu/v1.1/email`.

If several are set, the first one wins in this order: Brevo, ZeptoMail, Resend, Gmail Apps Script (`apps-script/Code.gs`), SMTP.

### Phone sign-in (optional)

Without a phone option configured, production runs email-only and the page says phone sign-in isn't available yet. Options (texting costs money with every provider):

- **Google Firebase** (no Sender ID or CAC): set `FIREBASE_API_KEY` and `FIREBASE_PROJECT_ID`, and add `pbatdoor2door2027.org` and `www.pbatdoor2door2027.org` under Firebase → Authentication → Settings → **Authorized domains**. The browser does the code step with Firebase (invisible reCAPTCHA) and the server verifies Google's signed token. The Content-Security-Policy allows Google's script, reCAPTCHA and Firebase origins automatically when Firebase is configured. If the phone step is ever blocked by the browser, set `CSP_MODE=report-only`, redeploy, and check the browser console for the blocked address.
- **Message Central VerifyNow** (`MC_CUSTOMER_ID`, `MC_PASSWORD`; `MC_FLOW=WHATSAPP` for WhatsApp).
- **DageSMS** (`DAGESMS_API_KEY`, optional `DAGESMS_SENDER`).
- **Termii** (`TERMII_API_KEY`, `TERMII_SENDER_ID`).
- **Twilio** (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`).

Each visitor IP can request at most 10 codes per hour (`OTP_IP_LIMIT_PER_HOUR`), to protect SMS credit. The count is kept in Postgres, so restarts don't reset it.

---

## 5. First deploy

As **user1** (log in again after the setup script so the `docker` group applies):

```bash
ssh user1@172.237.115.143
cd /opt/pbatdoor2door
nano .env
```

Fill in at least `ACME_EMAIL` (Let's Encrypt expiry notices), `MAIL_FROM` and `BREVO_API_KEY` (or `ZEPTOMAIL_TOKEN`). `POSTGRES_PASSWORD`, `BACKUP_UID`/`BACKUP_GID`, `SITE_DOMAIN=pbatdoor2door2027.org`, `COMPOSE_PROFILES=prod` and `NODE_ENV=production` are already set. Then:

```bash
scripts/deploy.sh
```

The script checks `.env` for unsafe settings, builds the image, starts Postgres → app (which runs database migrations) → Caddy and the backup service, waits for the app's health check, and then checks `https://pbatdoor2door2027.org/readyz` through Caddy. On the first run Caddy obtains the certificates (usually within a minute; watch with `docker compose logs -f caddy`).

Verify:

```bash
curl -I http://pbatdoor2door2027.org          # 308 -> https://pbatdoor2door2027.org/
curl -I https://www.pbatdoor2door2027.org     # 301 -> https://pbatdoor2door2027.org/
curl -fsS https://pbatdoor2door2027.org/readyz   # {"ok":true,"db":"up"}
docker compose logs app | grep 'is running'      # shows email: brevo, sms: … , db: postgres
```

Then sign in with a real email, complete a profile, and try "near me" on a phone.

---

## 6. Updates

```bash
ssh user1@172.237.115.143
cd /opt/pbatdoor2door && scripts/deploy.sh
```

`scripts/deploy.sh` runs `git pull --ff-only`, rebuilds the app image, restarts the stack and health-checks it. If the new version doesn't become healthy, it starts the previous image again (tagged `pbat-app:previous`) and exits with an error; the checkout stays at the new commit so you can fix forward or `git checkout` back. Database migrations (`migrations/*.sql`) run automatically when the app starts; they are forward-only and must stay backward-compatible with the previous version (add columns/tables; don't drop or rename in the same release). To run them by hand: `docker compose run --rm app node scripts/migrate.js`.

Changing only `.env`: `docker compose up -d` (recreates the containers whose settings changed).

Keeping the server patched: security updates install automatically. For Docker and other packages, occasionally run `sudo apt update && sudo apt upgrade` and reboot when asked; all containers restart on their own (`restart: unless-stopped`). To pick up newer base images (Node, Postgres minor, Caddy), run `docker compose pull && scripts/deploy.sh --no-pull`.

---

## 7. Backups and restore

The **backup** container runs `pg_dump` every night at `BACKUP_TIME_UTC` (default 01:30 UTC = 02:30 in Lagos), plus one at startup if none exists from the last 24 hours. Dumps are verified (`pg_restore --list`) and stored in `/opt/pbatdoor2door/backups/` (mode 700, owned by user1):

- `daily/pbat-YYYYMMDD-HHMMSS.dump`, kept `BACKUP_KEEP_DAYS` (14) days;
- `weekly/`, the Sunday copy, keeping the last `BACKUP_KEEP_WEEKLY` (8).

```bash
docker compose exec backup sh /scripts/backup-once.sh     # take a backup now
ls -lh backups/daily backups/weekly
docker compose logs backup                                 # history and any failures
```

**Restore** (replaces the current database; a safety dump of the current one is taken first):

```bash
cd /opt/pbatdoor2door
scripts/restore.sh backups/daily/pbat-YYYYMMDD-HHMMSS.dump    # type "restore" to confirm
```

**Off-server copies.** The backups contain members' personal data (dates of birth, addresses, polling units), so keep them private. They are on the same disk as the database, so also:

- enable **Linode Backups** for this Linode (Cloud Manager → the Linode → Backups), which keeps daily/weekly whole-disk snapshots; and/or
- copy `backups/` nightly to encrypted off-site storage, e.g. Linode Object Storage with an `rclone` `crypt` remote.

**Moving from the old app's database** (e.g. Neon): `pg_dump --format=custom --no-owner "<old DATABASE_URL>" > old.dump`, copy it to the server, `scripts/restore.sh old.dump`. The migrations are written to accept the old schema and add what's new.

---

## 8. Environment variables

All settings live in `/opt/pbatdoor2door/.env` (see `.env.example`; never commit `.env`). Quote values containing spaces or `<>`; avoid `$`.

| Variable | Purpose |
|---|---|
| `NODE_ENV` | `production` on the server (the deploy script enforces it). `development` locally: shows codes on screen and enables phone codes in the log. |
| `COMPOSE_PROFILES` | `prod` on the server, so Caddy and backups run. Empty locally. |
| `APP_NAME` | Name used in emails and SMS. |
| `SITE_DOMAIN` | `pbatdoor2door2027.org`. Caddy serves it and redirects `www.` to it. |
| `ACME_EMAIL` | Contact for Let's Encrypt. |
| `PROXY_MODE` | `direct` (DNS only, default) or `cloudflare` (behind Cloudflare's proxy). |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Database name, user and password. The password is applied only when the database volume is first created; to change it later use `ALTER USER` as well. |
| `BACKUP_DIR`, `BACKUP_UID`, `BACKUP_GID`, `BACKUP_TIME_UTC`, `BACKUP_KEEP_DAYS`, `BACKUP_KEEP_WEEKLY` | Backup location, file owner (user1), schedule and retention. |
| `MAIL_FROM` | Sender, e.g. `"PBAT DOOR TO DOOR <no-reply@pbatdoor2door2027.org>"`. |
| `BREVO_API_KEY` | Brevo email (recommended). |
| `ZEPTOMAIL_TOKEN`, `ZEPTOMAIL_API_URL` | Zoho ZeptoMail email; the URL only for EU accounts. |
| `RESEND_API_KEY` | Resend email. |
| `GMAIL_SCRIPT_URL`, `GMAIL_SCRIPT_SECRET` | Gmail via Google Apps Script (`apps-script/Code.gs`, ~100 emails/day). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | SMTP (blocked on Linode by default). |
| `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_SDK_URL`, `FIREBASE_JWKS_URL` | Firebase phone sign-in. |
| `MC_CUSTOMER_ID`, `MC_PASSWORD` / `MC_KEY`, `MC_FLOW`, `MC_EMAIL`, `MC_BASE_URL` | Message Central. |
| `DAGESMS_API_KEY`, `DAGESMS_SENDER`, `DAGESMS_ROUTE`, `DAGESMS_BASE_URL` | DageSMS. |
| `TERMII_API_KEY`, `TERMII_SENDER_ID`, `TERMII_CHANNEL`, `TERMII_BASE_URL` | Termii. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Twilio. |
| `OTP_IP_LIMIT_PER_HOUR` | Codes per visitor IP per hour (default 10). |
| `CSP_MODE` | `enforce` (default), `report-only`, or `off`. |
| `TRUST_PROXY` | Proxy hops in front of the app (default 1 = Caddy). Don't change. |
| `LOG_LEVEL` | `info` (default), `debug`, `warn`… |
| `MIGRATE_ON_START` | `true` (default) to apply migrations on start. |
| `APP_PORT` | Loopback port Caddy uses to reach the app (default 3000). |
| `PG_SHARED_BUFFERS`, `DATABASE_POOL_MAX` | Postgres memory and app connection pool size. |
| `DATABASE_URL`, `DATABASE_SSL` | Only to use an external Postgres instead of the `db` container (`DATABASE_SSL=require` or `verify` for hosted databases). |

---

## 9. Operations cheat sheet and troubleshooting

```bash
cd /opt/pbatdoor2door
docker compose ps                       # status and health
docker compose logs -f app              # app logs (JSON); caddy / db / backup likewise
docker compose restart app
docker compose exec db psql -U pbat     # SQL shell
docker compose down                     # stop everything (data is kept in volumes)
```

| Symptom | Check / fix |
|---|---|
| Certificate not issued | DNS records not pointing here yet, port 80 closed in the Linode Cloud Firewall or ufw, a CAA record blocking Let's Encrypt, or Cloudflare proxy on before the first deploy. See `docker compose logs caddy`. Let's Encrypt rate-limits repeated failures, so fix the cause first. |
| `502` from the site | App down: `docker compose ps`, `docker compose logs --tail 100 app`. |
| App unhealthy right after deploy | Usually a bad `.env` value; the logs say which. The deploy script has already restarted the previous image. |
| Everyone gets "Too many codes requested" | Real visitor IPs aren't reaching the app: Cloudflare's proxy is on but `PROXY_MODE` is still `direct`. |
| No emails arrive | `docker compose logs app \| grep -i 'send failed'`. 401 = wrong key or Brevo Authorised IPs; unverified sender; or spam (finish SPF/DKIM). SMTP timeouts mean the port is blocked: switch to Brevo or ZeptoMail. |
| Login works but you're bounced back to `/login` | You're on `http://` or the raw IP; use `https://pbatdoor2door2027.org`. |
| Firebase `auth/unauthorized-domain` | Add both hostnames to Firebase Authorized domains. |
| `git pull` permission denied | Deploy key missing or removed on GitHub (section 2b). |
| Disk filling up | `docker system df`; `docker image prune`; old backups rotate automatically. Container logs are capped at 5 × 10 MB per service. |

---

## 10. Tests

- `npm test`: unit tests (input validation, the polling-unit lookup compared with the original linear scan at hundreds of points, email provider request formats, CSP hashes).
- `scripts/test-stack.sh`: builds and starts the **whole production stack** locally (Postgres, app with `NODE_ENV=production`, Caddy with HTTPS on a test domain using Caddy's internal CA, backups), with a mock standing in for Brevo and DageSMS, then runs `test/e2e/stack.test.js` through Caddy: health/readiness, HTTP→HTTPS and www→apex redirects, pages and legacy redirects, security headers, pre-compressed geo data, email sign-in (cooldown, wrong code, single-use code, Secure/HttpOnly/SameSite cookie, no codes leaked), profile validation and save, second device, phone sign-in, account linking and merge, logout and logout-all, `/api/geo/near`, the per-IP limit including that a spoofed `X-Forwarded-For` is ignored. It then restarts the app and checks sessions and the rate limit survived, takes a backup, restores it with `scripts/restore.sh`, and checks again. It needs free ports 80, 443, 3000 and 8025, so run it on a development machine, **not on the production server**.

---

## 11. What changed from the original app, and why

The stack is the same: Node.js 22 LTS, Express 4, plain HTML/CSS/JS, and all routes, behaviour and provider options are unchanged. The changes are about running it reliably on one server for a high-traffic campaign:

| Change | Why |
|---|---|
| **PostgreSQL only** (SQLite removed). Schema in `migrations/*.sql`, applied in order at startup under a lock, tracked in `schema_migrations`. Indexes on every lookup column (verified email/phone, sessions by member and recency, code expiry, rate-limit buckets). | One reliable database with real backups; removes the `node:sqlite` "column index out of range" bug on some Node versions; schema changes become reviewable files. |
| **Account merge and sign-up run in transactions** (with row locks). | A failure or two concurrent requests half-way through a merge can no longer lose or duplicate an account. |
| **Per-IP code limit stored in Postgres** (sliding one-hour window). | Survives restarts and deploys, which previously reset it. |
| **Caddy** with automatic HTTPS for apex and www, www→apex redirect, HTTP/3, request size limit. It runs on the host network and overwrites `X-Forwarded-For`, so the app sees real visitor IPv4 *and* IPv6 addresses and visitors can't spoof them; optional Cloudflare mode. | Correct client IPs are what the rate limit depends on; Docker's port publishing would hide IPv6 clients' addresses. |
| **helmet security headers**: a strict Content-Security-Policy (inline scripts allowed only by hash; Firebase origins only when configured), HSTS, nosniff, frame protection, Referrer-Policy, Permissions-Policy (geolocation only for this site). | Defence against injected scripts and clickjacking on a high-profile site. |
| **Pre-compressed static assets**: the 8.7 MB of polling-unit JSON is Brotli/gzip-compressed once at build time (about 9 MB to 2.2 MB with Brotli) and cached by browsers for 7 days; pages revalidate cheaply with ETags so deploys show up immediately. | Much less bandwidth and CPU per visitor, faster on mobile data. |
| **Grid index for "near me"** instead of scanning all 163,000 units per request. | Same results (tested), a fraction of the CPU. |
| **Structured JSON logging** (pino) without cookies, codes or GPS query strings; capped Docker log files. | Searchable logs without leaking personal data, and no full disk. |
| **Graceful shutdown**, `/healthz` (alive) and `/readyz` (database reachable), Docker health checks, keep-alive tuned against the proxy. | Zero-error restarts and deploys, automatic recovery, no sporadic 502s. |
| **Docker hardening**: multi-stage image, runs as non-root with a read-only filesystem, no capabilities; Postgres not reachable from outside; the app port only on localhost. | Smaller attack surface. |
| **ZeptoMail** email provider added; overridable provider URLs (used by the tests). | ZeptoMail fits the domain's Zoho setup. |
| **Nodemailer 6 → 10**. | Version 6 has published security advisories. |
| Small fixes: malformed JSON returns 400 instead of 500; unknown `/api` routes return JSON 404. | Cleaner errors. |

`render.yaml` (Render Blueprint) was removed since the app now runs on the Linode.
