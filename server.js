import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, PROFILE_FIELDS } from './store.js';
import { createMailer } from './mailer.js';
import { createSms } from './sms.js';
import { validateProfile, parseIdentifier, normalizePhone, isEmail, STATES, GENDERS, INTERESTS } from './validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const IS_PROD = process.env.NODE_ENV === 'production';

// ---- Tunables ---------------------------------------------------------------
const CODE_TTL_MS = 10 * 60 * 1000;          // a code is valid for 10 minutes
const CODE_MAX_ATTEMPTS = 5;                 // wrong guesses before the code is burned
const RESEND_COOLDOWN_MS = 60 * 1000;        // one new code per email/phone per minute
const IP_SEND_LIMIT = 10;                    // codes one IP address can request per hour (protects SMS credit)
const COOKIE_NAME = 'sid';
// Browsers cap cookie lifetime at ~400 days, so the cookie is refreshed on visits.
// The session itself never expires: only logging out ends it.
const COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

const store = await createStore();
const mailer = createMailer();
const sms = createSms();
// Phone sign-in works in development (codes go to the console) and in production once an SMS provider is set.
// Google Firebase phone sign-in: Google sends the code (no Sender ID / CAC). The browser does the
// code step with Firebase, then hands us a signed ID token proving the number; we verify it here.
const FIREBASE = process.env.FIREBASE_API_KEY && process.env.FIREBASE_PROJECT_ID ? {
  apiKey: process.env.FIREBASE_API_KEY.trim(),
  projectId: process.env.FIREBASE_PROJECT_ID.trim(),
  authDomain: (process.env.FIREBASE_AUTH_DOMAIN || `${process.env.FIREBASE_PROJECT_ID.trim()}.firebaseapp.com`).trim(),
  sdk: (process.env.FIREBASE_SDK_URL || 'https://www.gstatic.com/firebasejs/10.12.2').replace(/\/+$/, ''),
} : null;
const firebaseKeys = FIREBASE && createRemoteJWKSet(new URL(process.env.FIREBASE_JWKS_URL
  || 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));
const SMS_ENABLED = Boolean(FIREBASE || sms.provider) || !IS_PROD;
// Optional Cloudflare Turnstile (bot check) on code requests: set both keys to switch it on.
const TURNSTILE = process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY
  ? { siteKey: process.env.TURNSTILE_SITE_KEY.trim(), secret: process.env.TURNSTILE_SECRET_KEY.trim() } : null;
async function turnstileOk(token, ip) {
  if (!TURNSTILE) return true;
  try {
    const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: TURNSTILE.secret, response: String(token || ''), remoteip: ip || '' }),
    });
    return Boolean((await r.json()).success);
  } catch (err) { console.error('Turnstile check failed:', err.message); return false; }
}
const CONSENT_ERROR = { error: 'Please tick the box to agree to the Privacy Policy and Terms.', field: 'consent' };

// When someone new comes in through "Log in" (no tick box there), we confirm their code first, then
// ask them to agree before creating the account. This short-lived signed note remembers which
// email/phone they just proved is theirs, so they don't need a second code.
const PENDING_KEY = crypto.randomBytes(32);
const PENDING_MS = 15 * 60 * 1000;
const signPending = (p) => crypto.createHmac('sha256', PENDING_KEY).update(p).digest('base64url');
function pendingToken(type, value) {
  const p = `${type}|${value}|${Date.now() + PENDING_MS}`;
  return `${Buffer.from(p).toString('base64url')}.${signPending(p)}`;
}
function readPending(token) {
  const [b, sig] = String(token || '').split('.');
  if (!b || !sig) return null;
  const p = Buffer.from(b, 'base64url').toString();
  if (!safeEqual(sig, signPending(p))) return null;
  const [type, value, exp] = p.split('|');
  if (!['email', 'phone'].includes(type) || !(Number(exp) > Date.now())) return null;
  return { type, value };
}

if (IS_PROD && store.kind !== 'postgres') {
  console.warn('WARNING: running in production without DATABASE_URL. On hosts with a temporary disk ' +
    '(like Render free), every restart will sign everyone out. Set DATABASE_URL to a Postgres database.');
}
if (IS_PROD && !mailer.provider) {
  console.warn('WARNING: no email provider configured (BREVO_API_KEY, GMAIL_SCRIPT_URL, RESEND_API_KEY or SMTP_HOST).');
}
if (IS_PROD && !sms.provider && !FIREBASE) {
  console.warn('NOTE: no SMS provider configured (TERMII_API_KEY or TWILIO_*). Phone sign-in is off; email still works.');
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const safeEqual = (a, b) =>
  a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const mask = (id) => (id.type === 'email'
  ? id.value.replace(/^(.)(.*)(@.*)$/, (_, a, b, c) => a + '•'.repeat(Math.min(b.length, 6)) + c)
  : id.value.replace(/^(\+234)(\d{3})\d{4}(\d{3})$/, '$1 $2 ••• •$3'));

const publicMember = (m) => {
  const out = {
    email: m.email || '', emailVerified: Boolean(m.email_verified),
    phone: m.phone || '', phoneVerified: Boolean(m.phone_verified),
    createdAt: m.created_at,
    profileComplete: Boolean(m.consent_at),
  };
  for (const f of PROFILE_FIELDS) out[f] = m[f];
  out.interests = m.interests ? m.interests.split(', ') : [];
  return out;
};

// Very small in-memory limiter: N code requests per IP per hour.
const ipHits = new Map();
function ipAllowed(ip) {
  const now = Date.now();
  const hits = (ipHits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (hits.length >= IP_SEND_LIMIT) { ipHits.set(ip, hits); return false; }
  hits.push(now); ipHits.set(ip, hits);
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, hits] of ipHits) if (!hits.some((t) => now - t < 60 * 60 * 1000)) ipHits.delete(ip);
}, 10 * 60 * 1000).unref();

// ---- App --------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);                   // Render (and most hosts) sit behind a proxy
app.disable('x-powered-by');
app.use(compression());
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());

// Wrap async route handlers so errors reach the error handler.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/healthz', (req, res) => res.json({ ok: true }));

// Basic CSRF defence: state-changing API calls must be JSON (forms can't send that
// cross-site without a CORS preflight) and the session cookie is SameSite=Lax.
app.use('/api', (req, res, next) => {
  if (req.method === 'POST' && !req.is('application/json')) {
    return res.status(415).json({ error: 'Expected JSON.' });
  }
  res.set('Cache-Control', 'no-store');
  next();
});

function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    secure: IS_PROD,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  });
}

// Loads the member from the session cookie (if any) and keeps the cookie fresh.
app.use(h(async (req, res, next) => {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return next();
  const s = await store.getSession(sha256(token));
  const member = s && (await store.memberById(s.member_id));
  if (!member) {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    return next();
  }
  req.member = member;
  req.sessionHash = s.token_hash;
  // Refresh at most once an hour to avoid a write per request.
  if (Date.now() - s.last_seen > 60 * 60 * 1000) {
    await store.touchSession(s.token_hash, Date.now());
    setSessionCookie(res, token);
  }
  next();
}));

// Options for the forms, so the browser and server use the same lists.
app.get('/api/options', (req, res) =>
  res.json({
    states: STATES, genders: GENDERS, interests: INTERESTS, sms: SMS_ENABLED,
    phoneVia: FIREBASE && !sms.provider ? 'firebase' : 'server',
    turnstile: TURNSTILE ? TURNSTILE.siteKey : null,
    firebase: FIREBASE ? { apiKey: FIREBASE.apiKey, authDomain: FIREBASE.authDomain, projectId: FIREBASE.projectId, sdk: FIREBASE.sdk } : null,
  }));

// ---- Sending and checking 6-digit codes (used for sign-in and for linking a contact) ----
// `key` is where the code is stored: the email/phone itself for sign-in, `link:<member>:<value>` for linking.
async function sendCode(req, key, id) {
  const existing = await store.getCode(key);
  const now = Date.now();
  if (existing && now - existing.sent_at < RESEND_COOLDOWN_MS) {
    const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - existing.sent_at)) / 1000);
    return { status: 429, body: { error: `Please wait ${wait}s before requesting another code.`, retryAfter: wait } };
  }
  if (!ipAllowed(req.ip)) {
    return { status: 429, body: { error: 'Too many codes requested from this connection. Try again in an hour.' } };
  }
  const code = crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
  const managed = id.type === 'phone' && sms.managed;     // provider creates and checks the code itself
  try {
    if (managed) {
      const ref = await sms.start(id.value);              // remember the provider's reference, not a code hash
      await store.upsertCode(key, id.type, `ext:${ref}`, now + CODE_TTL_MS, now);
    } else {
      await store.upsertCode(key, id.type, sha256(`${key}:${code}`), now + CODE_TTL_MS, now);
      if (id.type === 'email') await mailer.send(id.value, code);
      else await sms.send(id.value, code);
    }
  } catch (err) {
    console.error(`${id.type === 'email' ? 'Email' : 'SMS'} send failed:`, err.message);
    await store.deleteCode(key);
    return { status: 502, body: { error: id.type === 'email'
      ? "We couldn't send the email. Check the address and try again shortly."
      : "We couldn't send the text message. Check the number, or use your email instead." } };
  }
  const body = {
    ok: true, type: id.type, identifier: id.value, sentTo: mask(id), cooldown: RESEND_COOLDOWN_MS / 1000,
    via: id.type === 'email' ? 'email' : (sms.via || 'sms'),
    expiresMinutes: managed ? null : CODE_TTL_MS / 60000,
  };
  // Without a provider in development, hand the code to the UI so the flow can be tested.
  const noProvider = id.type === 'email' ? !mailer.provider : !sms.provider;
  if (noProvider && !IS_PROD) body.devCode = code;
  return { status: 200, body };
}

/** Returns null when the code is right (and burns it), otherwise { status, body } to send back. */
async function checkCode(key, id, code) {
  const row = await store.getCode(key);
  if (!row || row.expires_at < Date.now()) {
    if (row) await store.deleteCode(key);
    return { status: 400, body: { error: 'That code has expired. Request a new one.', expired: true } };
  }
  if (row.attempts >= CODE_MAX_ATTEMPTS) {
    await store.deleteCode(key);
    return { status: 429, body: { error: 'Too many wrong attempts. Request a new code.', expired: true } };
  }
  let result;
  if (row.code_hash.startsWith('ext:')) {
    try { result = await sms.check(id.value, row.code_hash.slice(4), code); }
    catch (err) {
      console.error('SMS verify failed:', err.message);
      return { status: 502, body: { error: "We couldn't check the code right now. Please try again in a moment." } };
    }
    if (result === 'expired') {
      await store.deleteCode(key);
      return { status: 400, body: { error: 'That code has expired. Request a new one.', expired: true } };
    }
  } else {
    result = safeEqual(sha256(`${key}:${code}`), row.code_hash) ? 'ok' : 'wrong';
  }
  if (result !== 'ok') {
    await store.bumpAttempts(key);
    const left = CODE_MAX_ATTEMPTS - row.attempts - 1;
    return { status: 400, body: {
      error: left > 0 ? `Incorrect code. ${left} attempt${left === 1 ? '' : 's'} left.` : 'Too many wrong attempts. Request a new code.',
      expired: left <= 0,
    } };
  }
  await store.deleteCode(key);                            // single use
  return null;
}

/** Google-signed Firebase token -> verified Nigerian phone number, or { status, body } on failure. */
async function phoneFromFirebase(idToken) {
  if (!FIREBASE) return { fail: { status: 404, body: { error: 'Phone sign-in is not set up.' } } };
  let payload;
  try {
    ({ payload } = await jwtVerify(String(idToken || ''), firebaseKeys, {
      issuer: `https://securetoken.google.com/${FIREBASE.projectId}`, audience: FIREBASE.projectId,
    }));
  } catch (err) {
    console.error('Firebase token rejected:', err.code || err.message);
    return { fail: { status: 401, body: { error: "We couldn't confirm your phone number. Please try again." } } };
  }
  const phone = normalizePhone(payload.phone_number);
  if (!phone || payload.firebase?.sign_in_provider !== 'phone') {
    return { fail: { status: 400, body: { error: 'Please use a Nigerian phone number.' } } };
  }
  return { phone };
}

async function startSession(req, res, member, isNew) {
  const now = Date.now();
  const token = crypto.randomBytes(32).toString('base64url');
  await store.insertSession(sha256(token), member.id, now, String(req.get('user-agent') || '').slice(0, 200));
  setSessionCookie(res, token);
  res.json({ member: publicMember(member), isNew, needsProfile: !member.consent_at });
}

/**
 * Code confirmed: log in. Members who already have an account don't need to tick anything again.
 * Someone new must agree first, so if they haven't (they came through "Log in"), ask them.
 */
async function finishSignIn(req, res, type, value) {
  const agreed = req.body.consent === true;
  if (!agreed && !(await store.memberByVerified(type, value))) {
    return res.json({ needsConsent: true, pending: pendingToken(type, value) });
  }
  const now = Date.now();
  const { member, isNew } = await store.signInWith(type, value, now);
  if (agreed) await store.recordConsent(member.id, now, req.body.sms === true);
  await startSession(req, res, member, isNew);
}

// Step 1 (sign up AND log in): email or phone -> code
app.post('/api/auth/start', h(async (req, res) => {
  const id = parseIdentifier(req.body.identifier);
  if (!id) {
    return res.status(400).json({ error: 'Enter a valid email address or Nigerian phone number (e.g. 0803 123 4567).' });
  }
  if (id.type === 'phone' && !SMS_ENABLED) {
    return res.status(503).json({ error: "Sign-in by phone isn't available yet. Please use your email address.", code: 'sms_off' });
  }
  if (!(await turnstileOk(req.body.turnstile, req.ip))) {
    return res.status(400).json({ error: 'Please complete the security check and try again.', code: 'turnstile' });
  }
  const { status, body } = await sendCode(req, id.value, id);
  res.status(status).json(body);
}));

// Step 2: confirm the code -> log in (creating the account the first time)
app.post('/api/auth/verify', h(async (req, res) => {
  const id = parseIdentifier(req.body.identifier);
  const code = String(req.body.code || '').replace(/\D/g, '');
  if (!id || code.length !== 6) {
    return res.status(400).json({ error: 'Enter the 6-digit code we sent you.' });
  }
  const fail = await checkCode(id.value, id, code);
  if (fail) return res.status(fail.status).json(fail.body);
  await finishSignIn(req, res, id.type, id.value);
}));

// Phone sign-in finished in the browser with Firebase: check Google's signed token, then log in.
app.post('/api/auth/firebase', h(async (req, res) => {
  const { phone, fail } = await phoneFromFirebase(req.body.idToken);
  if (fail) return res.status(fail.status).json(fail.body);
  await finishSignIn(req, res, 'phone', phone);
}));

// A new person who came in through "Log in" has proved their email/phone and now ticked the box.
app.post('/api/auth/join', h(async (req, res) => {
  const p = readPending(req.body.pending);
  if (!p) return res.status(400).json({ error: 'That took too long. Please start again.', restart: true });
  if (req.body.consent !== true) return res.status(400).json(CONSENT_ERROR);
  await finishSignIn(req, res, p.type, p.value);
}));

// Who am I?
app.get('/api/me', h(async (req, res) => {
  if (!req.member) return res.status(401).json({ member: null });
  const sessions = (await store.listSessions(req.member.id)).map((s) => ({
    createdAt: s.created_at,
    lastSeen: s.last_seen,
    userAgent: s.user_agent,
    current: s.token_hash === req.sessionHash,
  }));
  res.json({ member: publicMember(req.member), sessions });
}));

// Save my details (first time after sign-in, and later edits).
// The contact used to sign in is verified and can't be changed here; the other one is optional
// for email and required for phone.
app.post('/api/me', h(async (req, res) => {
  const m = req.member;
  if (!m) return res.status(401).json({ error: 'Please log in.' });

  const firstTime = !m.consent_at;
  const { profile, errors = {} } = validateProfile(req.body, { requireConsent: firstTime });

  let phone = null, email = null;
  if (!m.phone_verified) {
    const raw = String(req.body.phone || '').trim();
    phone = raw ? normalizePhone(raw) : null;
    if (raw && !phone) errors.phone = 'Enter a valid Nigerian phone number (e.g. 0803 123 4567), or leave it blank.';
  }
  if (!m.email_verified) {
    const raw = String(req.body.email || '').trim().toLowerCase();
    if (raw && !isEmail(raw)) errors.email = 'Enter a valid email address, or leave it blank.';
    else email = raw || null;
  }
  if (Object.keys(errors).length) return res.status(400).json({ error: 'Please fix the highlighted fields.', fields: errors });

  if (!m.phone_verified && phone !== (m.phone || null)) {
    if (phone && !(await store.setContact(m.id, 'phone', phone))) {
      return res.status(409).json({ error: 'Please fix the highlighted fields.', fields: { phone: 'This number already has its own account. Use "Link" under Sign-in methods to prove it\'s yours and join the two accounts.' } });
    }
    if (!phone) await store.setContact(m.id, 'phone', null);
  }
  if (!m.email_verified && email !== (m.email || null)) {
    if (email && !(await store.setContact(m.id, 'email', email))) {
      return res.status(409).json({ error: 'Please fix the highlighted fields.', fields: { email: 'This email already has its own account. Use "Link" under Sign-in methods to prove it\'s yours and join the two accounts.' } });
    }
    if (!email) await store.setContact(m.id, 'email', null);
  }

  await store.updateProfile(m.id, profile, Date.now());
  res.json({ member: publicMember(await store.memberById(m.id)) });
}));

// ---- Linking a second email/phone to my account ------------------------------
// The member proves they own the contact with a code. If it already belongs to another
// account (e.g. they joined once by phone and once by email), the two accounts are merged.
async function finishLink(res, m, type, value) {
  const r = await store.linkContact(m.id, type, value);
  if (r.conflict) {
    return res.status(409).json({ error: `That ${type === 'email' ? 'email' : 'number'} belongs to an account that already has a different ${type === 'email' ? 'phone number' : 'email'}. Log in with it instead, or contact the team to merge.` });
  }
  res.json({ member: publicMember(await store.memberById(r.memberId)), merged: r.merged });
}
const linkKey = (m, id) => `link:${m.id}:${id.value}`;

app.post('/api/me/link/start', h(async (req, res) => {
  const m = req.member;
  if (!m) return res.status(401).json({ error: 'Please log in.' });
  const id = parseIdentifier(req.body.identifier);
  if (!id) return res.status(400).json({ error: 'Enter a valid email address or Nigerian phone number.' });
  if ((id.type === 'email' && m.email_verified) || (id.type === 'phone' && m.phone_verified)) {
    return res.status(400).json({ error: `Your account already has a verified ${id.type === 'email' ? 'email' : 'phone number'}.` });
  }
  if (id.type === 'phone' && !SMS_ENABLED) return res.status(503).json({ error: "Phone codes aren't available yet." });
  const { status, body } = await sendCode(req, linkKey(m, id), id);
  res.status(status).json(body);
}));

app.post('/api/me/link/verify', h(async (req, res) => {
  const m = req.member;
  if (!m) return res.status(401).json({ error: 'Please log in.' });
  const id = parseIdentifier(req.body.identifier);
  const code = String(req.body.code || '').replace(/\D/g, '');
  if (!id || code.length !== 6) return res.status(400).json({ error: 'Enter the 6-digit code we sent you.' });
  const fail = await checkCode(linkKey(m, id), id, code);
  if (fail) return res.status(fail.status).json(fail.body);
  await finishLink(res, m, id.type, id.value);
}));

app.post('/api/me/link/firebase', h(async (req, res) => {
  const m = req.member;
  if (!m) return res.status(401).json({ error: 'Please log in.' });
  if (m.phone_verified) return res.status(400).json({ error: 'Your account already has a verified phone number.' });
  const { phone, fail } = await phoneFromFirebase(req.body.idToken);
  if (fail) return res.status(fail.status).json(fail.body);
  await finishLink(res, m, 'phone', phone);
}));

// Log out this device
app.post('/api/auth/logout', h(async (req, res) => {
  if (req.sessionHash) await store.deleteSession(req.sessionHash);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}));

// Log out every device
app.post('/api/auth/logout-all', h(async (req, res) => {
  if (req.member) await store.deleteMemberSessions(req.member.id);
  res.clearCookie(COOKIE_NAME, { path: '/' });
  res.json({ ok: true });
}));

// ---- Polling units near a location --------------------------------------------
// public/geo/<state>.json holds INEC's state > LGA > ward > polling unit lists, with GPS where known.
const GEO_DIR = path.join(__dirname, 'public', 'geo');
const near = { lat: [], lng: [], ref: [] };
try {
  const index = JSON.parse(fs.readFileSync(path.join(GEO_DIR, 'index.json'), 'utf8'));
  for (const [state, slug] of Object.entries(index)) {
    const data = JSON.parse(fs.readFileSync(path.join(GEO_DIR, `${slug}.json`), 'utf8'));
    for (const L of data.lgas) for (const W of L.w) for (const P of W.p) {
      if (P.length < 4) continue;
      near.lat.push(P[2]); near.lng.push(P[3]); near.ref.push([state, L.n, W.n, P[0], P[1]]);
    }
  }
  near.lat = Float64Array.from(near.lat); near.lng = Float64Array.from(near.lng);
  console.log(`Loaded ${near.ref.length.toLocaleString()} polling-unit locations`);
} catch (err) {
  console.warn('Polling-unit data not loaded:', err.message);
}

app.get('/api/geo/near', (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'Bad location.' });
  }
  const k = Math.cos((lat * Math.PI) / 180);
  const best = [];                                   // keep the 6 closest
  for (let i = 0; i < near.lat.length; i++) {
    const dy = near.lat[i] - lat, dx = (near.lng[i] - lng) * k, d = dy * dy + dx * dx;
    if (best.length < 6 || d < best[best.length - 1][0]) {
      best.push([d, i]); best.sort((a, b) => a[0] - b[0]); if (best.length > 6) best.pop();
    }
  }
  const results = best.map(([d, i]) => {
    const [state, lga, ward, name, code] = near.ref[i];
    return { state, lga, ward, name, code, metres: Math.round(Math.sqrt(d) * 111320) };
  }).filter((r) => r.metres < 25000);
  res.set('Cache-Control', 'no-store').json({ results });
});

// One page handles both joining and logging in.
// /join is the one sign-up address used on every button; it shows the same screen as /login.
app.get(['/join', '/signup'], (req, res) => res.sendFile(path.join(__dirname, 'public', 'login.html')));
app.get('/welcome', (req, res) => res.redirect(302, '/account'));
app.use('/geo', express.static(GEO_DIR, { maxAge: '7d' }));
// Photos and icons: let browsers keep them for a day instead of downloading them on every visit.
app.use('/images', express.static(path.join(__dirname, 'public', 'images'), { maxAge: '1d' }));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

// Housekeeping: clear expired codes every 15 minutes.
setInterval(() => store.purgeCodes(Date.now()).catch(() => {}), 15 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`Running at http://localhost:${PORT}  (db: ${store.kind}, email: ${mailer.provider || 'console (dev)'}, sms: ${sms.provider || (FIREBASE ? 'firebase' : IS_PROD ? 'off' : 'console (dev)')})`);
});
