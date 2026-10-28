# PBAT DOOR TO DOOR

A volunteer website with:
- **Landing page** (`/`): the movement and its Founder & Convener, Tompolo; the President's photo, a short bio timeline, and the administration's works, each linked to its source.
- **Join or log in** (`/login`, `/join`): one box. Type an email **or** Nigerian phone number, enter the 6-digit code, and you're straight into your account. The first time creates it.
- **My account** (`/account`): new members see a "Complete your profile" prompt. Only **full name, state and LGA** are required; everything else is optional. Edit details, see logged-in devices, log out. People stay logged in until they log out.

### Polling units
State → LGA → ward → polling unit are searchable lists built from INEC's data (176,846 polling units, 8,810 wards, 774 LGAs) in `public/geo/`. **Find polling units near me** uses the phone's location to suggest the closest polling units (INEC has GPS for about 163,000 of them) and fills in state, LGA, ward and unit in one tap. INEC's coordinates are occasionally wrong, so each suggestion shows its ward and LGA.

### Sign-in by phone (SMS)
Texting codes costs money with every provider. The app supports:
- **Google Firebase** (recommended, no Sender ID or CAC): set `FIREBASE_API_KEY` and `FIREBASE_PROJECT_ID`. The browser does the code step with Firebase (with an invisible reCAPTCHA) and sends the server a Google-signed token, which the server verifies before logging the member in. Add your site's domain under Firebase Authentication > Settings > Authorized domains.
- **Message Central VerifyNow** (no Sender ID or CAC needed): set `MC_CUSTOMER_ID` and `MC_PASSWORD` from console.messagecentral.com. New accounts get free test credits; Nigeria is listed from about $0.005–$0.009 per code. Set `MC_FLOW=WHATSAPP` to send codes by WhatsApp instead of SMS. Message Central creates and checks the code; the site never sees it.
- **DageSMS** (no CAC, Naira, no subscription): set `DAGESMS_API_KEY` (and `DAGESMS_SENDER` if they give you a shared sender name other than `DageSMS`). Uses the corporate route so codes reach DND numbers.
- **Termii** (Nigerian): set `TERMII_API_KEY` and `TERMII_SENDER_ID` (request a Sender ID in the Termii dashboard under *Sender IDs*). Uses the `dnd` channel by default so codes reach numbers on Do-Not-Disturb.
- **Twilio**: set `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM`.

Without an SMS provider, the site runs email-only and the sign-in box says phone sign-in is coming soon. Each connection can request at most 10 codes per hour, to protect SMS credit.

## Editing the content
- **His works:** edit the `WORKS` list near the bottom of `public/index.html`.
- **Photos:** add your own to `public/images/` (`hero.jpg`, `gallery-1.jpg` … `gallery-5.jpg`) and they replace the default Wikimedia Commons photos automatically. Only use photos you have the right to use.
- **Sign-up options** (states, help areas): `validate.js`.

## Run it locally

```bash
npm install
npm start                # http://localhost:3000
```

Needs Node.js 22.13 or newer. Locally you don't need any configuration. The code is printed in the terminal and shown on the page, and data goes into a local SQLite file. Copy `.env.example` to `.env` if you want to try real email or Postgres locally.

## Deploy on Render (free plan)

The Render free plan has two limits that affect this app, and the app handles both:

| Limit on Render free | What this app does instead |
|---|---|
| Outbound SMTP (ports 25/465/587) is blocked | Sends email through **Brevo's HTTPS API** (port 443) |
| The disk is wiped on every deploy/restart/spin-down | Stores users and sessions in **Postgres** (`DATABASE_URL`) |

### 1. Get a Postgres database
Use any Postgres provider and copy its connection string (`postgres://…`). Two options:
- **Neon** or **Supabase**: both have free plans.
- **Render Postgres**: easy to set up, but free Render databases expire after 30 days, so upgrade it or move off it before then.

The tables are created automatically on first start.

### 2. Set up email (pick one, both free)

**Option A: your own Gmail (simplest, about 100 emails/day).** Follow the steps at the top of `apps-script/Code.gs`, then set `GMAIL_SCRIPT_URL` and `GMAIL_SCRIPT_SECRET` on Render. You don't need `MAIL_FROM`.

**Option B: Brevo (300 emails/day, free plan, no card).**
1. Create a free account at brevo.com. The free plan allows 300 emails per day.
2. Go to **Senders, Domains & Dedicated IPs** → **Senders** → add and verify the email address you'll send from (a Gmail address works).
3. Go to **SMTP & API** → **API Keys** → create a key (it starts with `xkeysib-`).

### 3. Create the service on Render
**Option A, Blueprint (fastest):** Dashboard → **New** → **Blueprint** → pick this repo. Render reads `render.yaml` and asks for the three secrets below.

**Option B, manual:** **New** → **Web Service** → pick this repo, then use:
- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/healthz`
- Environment variables:

| Key | Value |
|---|---|
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `22` |
| `DATABASE_URL` | your Postgres connection string |
| `BREVO_API_KEY` | your Brevo key |
| `MAIL_FROM` | `PBAT DOOR TO DOOR <the-email-you-verified@gmail.com>` |

After it deploys, open the `onrender.com` URL and sign in. The logs show `db: postgres, email: brevo` when everything is set up correctly.

> Free Render services go to sleep after a period of inactivity, so the first visit after a quiet spell can take up to a minute. Thanks to Postgres, everyone stays signed in through that.

## How it works

| Step | Endpoint | What happens |
|---|---|---|
| 1 | `POST /api/auth/start` | Takes an email or phone, sends a 6-digit code by email or SMS (only its hash is stored, valid 10 minutes). |
| 2 | `POST /api/auth/verify` | Checks the code, deletes it so it can't be reused, creates the member the first time, and starts a session. |
| — | `POST /api/me` | Saves the welcome questions / later edits. The contact used to sign in is verified and locked. |
| — | `GET /api/options` | States, genders, and help areas for the form. |
| — | `GET /api/me` | Returns the signed-in user and their signed-in devices. |
| — | `POST /api/auth/logout` | Ends this device's session. |
| — | `POST /api/auth/logout-all` | Ends every session for the account. |
| — | `GET /healthz` | Health check for Render. |

### "Stay signed in until logout"
- Sessions are stored in the database with **no expiry**. Only logging out deletes them.
- The cookie is `HttpOnly`, `SameSite=Lax`, and `Secure` in production. Its lifetime is set to the browser maximum (about 400 days) and refreshed on visits, so active users are never logged out.
- The cookie holds a random 256-bit token, and the database stores only its hash.

### Security
- Codes expire after 10 minutes, work only once, and stop working after 5 wrong guesses.
- You can request one new code per email per minute.
- POST requests must be JSON, which together with SameSite cookies gives basic CSRF protection.
- In production, codes are never shown on the page.

### Email providers
The app uses the first provider that's configured: `BREVO_API_KEY` → `RESEND_API_KEY` → `GMAIL_SCRIPT_URL` (needs your own domain) → `SMTP_HOST` (only works on paid Render plans or other hosts) → console output (development only).

## Volunteer area and coordinators
- **/volunteer** (any logged-in member): My Ward, Log a visit, Pledges, Leaderboard and the Doorstep toolkit.
  Visits and pledges entered without signal are saved on the phone and sent automatically when the signal returns.
- **/coordinator**: state coordinators see only their own state's volunteers, visits and pledges, and can download them.
  National admins see every state and appoint coordinators on the same page.
- **Who is a national admin:** set `NATIONAL_ADMINS` to the email(s) or phone number(s) they log in with, comma-separated,
  e.g. `NATIONAL_ADMINS=boss@example.com, 08031234567`. Restart the app after changing it.
- **Toolkit wording** lives in `public/toolkit.js`. Set `APPROVED = true` there once the movement has approved it.

## Offline
`public/sw.js` (a service worker) saves pages, styles, photos and polling-unit lists on the phone, so the site keeps working
with poor or no signal; pages never opened before show `public/offline.html`. When you change the list of files in `sw.js`,
bump its `VERSION`.

## Files
```
server.js          Express routes, sessions, cookies
validate.js        Form rules (email/phone parsing, age 18+, states…)
sms.js             SMS sending: Termii / Twilio / console
start.js           Lets Render's default `node start` run the server
store.js           Database layer: Postgres if DATABASE_URL is set, otherwise SQLite
mailer.js          Email sending: Brevo / Resend / SMTP / console
public/index.html  Landing page (photos, bio, works)
public/login.html  Join or log in (email or phone)
public/geo/         INEC polling-unit lists, one file per state
public/account.html  Member area
public/volunteer.html, volunteer-page.js  Volunteer area (offline-capable)
public/coordinator.html, coordinator-page.js  Coordinator view
public/toolkit.js  Doorstep toolkit wording (talking points, facts, hard questions)
volunteer.js       Volunteer/coordinator API (visits, pledges, leaderboards, roles)
public/sw.js, offline.html  Offline support
public/app.js, styles.css  Shared code and styles
public/images/     Your own photos (optional)
render.yaml        Render Blueprint
.env.example       Configuration template
```
