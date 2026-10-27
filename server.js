import 'dotenv/config';
import express from 'express';
import cookieParser from 'cookie-parser';
import compression from 'compression';
import { pinoHttp } from 'pino-http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './logger.js';
import { createPool, waitForDatabase, migrate } from './db.js';
import { createStore, PROFILE_FIELDS } from './store.js';
import { createMailer } from './mailer.js';
import { createSms } from './sms.js';
import { loadGeoIndex, nearest } from './geo.js';
import { securityHeaders } from './security.js';
import { staticFiles } from './static.js';
import { validateProfile, parseIdentifier, normalizePhone, isEmail, STATES, GENDERS, INTERESTS } from './validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const IS_PROD = process.env.NODE_ENV === 'production';

// ---- Tunables ---------------------------------------------------------------
const CODE_TTL_MS = 10 * 60 * 1000;          // a code is valid for 10 minutes
const CODE_MAX_ATTEMPTS = 5;                 // wrong guesses before the code is burned
const RESEND_COOLDOWN_MS = 60 * 1000;        // one new code per email/phone per minute
// Codes one IP address can request per hour (protects SMS credit). Stored in Postgres.
const IP_SEND_LIMIT = Number(process.env.OTP_IP_LIMIT_PER_HOUR || 10);
const IP_WINDOW_MS = 60 * 60 * 1000;
const COOKIE_NAME = 'sid';
// Browsers cap cookie lifetime at ~400 days, so the cookie is refreshed on visits.
// The session itself never expires: only logging out ends it.
const COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
// Number of reverse proxies in front of the app (Caddy = 1). req.ip comes from X-Forwarded-For.
const TRUST_PROXY = /^\d+$/.test(process.env.TRUST_PROXY || '1') ? Number(process.env.TRUST_PROXY || 1) : process.env.TRUST_PROXY;

const pool = createPool();
await waitForDatabase(pool);
if (process.env.MIGRATE_ON_START !== 'false') await migrate(pool);
const store = createStore(pool);
const mailer = createMailer();
const sms = createSms();
// Phone sign-in works in development (codes go to the log) and in production once an SMS provider is set.
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

if (IS_PROD && !mailer.provider) {
  logger.warn('no email provider configured (BREVO_API_KEY, ZEPTOMAIL_TOKEN, RESEND_API_KEY, GMAIL_SCRIPT_URL or SMTP_HOST)');
}
if (IS_PROD && !sms.provider && !FIREBASE) {
  logger.info('no SMS provider or Firebase configured: phone sign-in is off, email still works');
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

// ---- App --------------------------------------------------------------------
const app = express();
app.set('trust proxy', TRUST_PROXY);
app.disable('x-powered-by');

app.get('/healthz', (req, res) => res.json({ ok: true }));
app.get('/readyz', async (req, res) => {
  try {
    await store.ping();
    res.json({ ok: true, db: 'up' });
  } catch (err) {
    logger.error({ err: err.message }, 'readiness check failed');
    res.status(503).json({ ok: false, db: 'down' });
  }
});

app.use(pinoHttp({
  logger,
  // API calls only; Caddy keeps the full access log. Query strings are dropped (they hold GPS positions).
  autoLogging: { ignore: (req) => !req.url.startsWith('/api/') },
  customProps: (req) => ({ ip: req.ip }),
  serializers: {
    req: (req) => ({ method: req.method, path: req.url.split('?')[0] }),
    res: (res) => ({ status: res.statusCode }),
  },
  customLogLevel: (req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
}));
app.use(securityHeaders({ publicDir: PUBLIC_DIR, isProd: IS_PROD, firebase: FIREBASE }));
app.use(compression());
app.use(express.json({ limit: '20kb' }));
app.use(cookieParser());

// Wrap async route handlers so errors reach the error handler.
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

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
// Static files don't need it, so it only runs for the API.
app.use('/api', h(async (req, res, next) => {
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
  if (!(await store.hit(`otp-ip:${req.ip}`, IP_SEND_LIMIT, IP_WINDOW_MS, now))) {
    req.log.warn({ ip: req.ip }, 'per-IP code limit reached');
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
    req.log.error({ err: err.message, channel: id.type }, 'code send failed');
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
async function checkCode(req, key, id, code) {
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
      req.log.error({ err: err.message }, 'SMS verify failed');
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
async function phoneFromFirebase(req, idToken) {
  if (!FIREBASE) return { fail: { status: 404, body: { error: 'Phone sign-in is not set up.' } } };
  let payload;
  try {
    ({ payload } = await jwtVerify(String(idToken || ''), firebaseKeys, {
      issuer: `https://securetoken.google.com/${FIREBASE.projectId}`, audience: FIREBASE.projectId,
    }));
  } catch (err) {
    req.log.warn({ err: err.code || err.message }, 'Firebase token rejected');
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

// Step 1 (sign up AND log in): email or phone -> code
app.post('/api/auth/start', h(async (req, res) => {
  const id = parseIdentifier(req.body.identifier);
  if (!id) {
    return res.status(400).json({ error: 'Enter a valid email address or Nigerian phone number (e.g. 0803 123 4567).' });
  }
  if (id.type === 'phone' && !SMS_ENABLED) {
    return res.status(503).json({ error: "Sign-in by phone isn't available yet. Please use your email address.", code: 'sms_off' });
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
  const fail = await checkCode(req, id.value, id, code);
  if (fail) return res.status(fail.status).json(fail.body);
  const { member, isNew } = await store.signInWith(id.type, id.value, Date.now());
  await startSession(req, res, member, isNew);
}));

// Phone sign-in finished in the browser with Firebase: check Google's signed token, then log in.
app.post('/api/auth/firebase', h(async (req, res) => {
  const { phone, fail } = await phoneFromFirebase(req, req.body.idToken);
  if (fail) return res.status(fail.status).json(fail.body);
  const { member, isNew } = await store.signInWith('phone', phone, Date.now());
  await startSession(req, res, member, isNew);
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
  const fail = await checkCode(req, linkKey(m, id), id, code);
  if (fail) return res.status(fail.status).json(fail.body);
  await finishLink(res, m, id.type, id.value);
}));

app.post('/api/me/link/firebase', h(async (req, res) => {
  const m = req.member;
  if (!m) return res.status(401).json({ error: 'Please log in.' });
  if (m.phone_verified) return res.status(400).json({ error: 'Your account already has a verified phone number.' });
  const { phone, fail } = await phoneFromFirebase(req, req.body.idToken);
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
let geo = { size: 0, cells: new Map() };
try {
  geo = loadGeoIndex(path.join(PUBLIC_DIR, 'geo'));
  logger.info({ units: geo.size }, 'loaded polling-unit locations');
} catch (err) {
  logger.warn({ err: err.message }, 'polling-unit data not loaded');
}

app.get('/api/geo/near', (req, res) => {
  const lat = Number(req.query.lat), lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return res.status(400).json({ error: 'Bad location.' });
  }
  res.set('Cache-Control', 'no-store').json({ results: geo.size ? nearest(geo, lat, lng) : [] });
});

// Unknown API routes get JSON, not the static 404 page.
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// One page handles both joining and logging in.
app.get(['/join', '/signup'], (req, res) => res.redirect(302, '/login'));
app.get('/welcome', (req, res) => res.redirect(302, '/account'));
app.use(staticFiles(PUBLIC_DIR));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
  (req.log || logger).error({ err }, 'unhandled error');
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
});

// Housekeeping: clear expired codes and old rate-limit entries every 15 minutes.
const housekeeping = setInterval(() => {
  const now = Date.now();
  store.purgeCodes(now).catch((err) => logger.warn({ err: err.message }, 'purging codes failed'));
  store.purgeHits(now - IP_WINDOW_MS).catch((err) => logger.warn({ err: err.message }, 'purging rate limits failed'));
}, 15 * 60 * 1000);
housekeeping.unref();

const server = app.listen(PORT, HOST, () => {
  logger.info({
    port: PORT, db: 'postgres', email: mailer.provider || 'log (dev)',
    sms: sms.provider || (FIREBASE ? 'firebase' : IS_PROD ? 'off' : 'log (dev)'),
    env: IS_PROD ? 'production' : 'development',
  }, 'PBAT DOOR TO DOOR is running');
});
// Keep idle connections from Caddy open longer than Caddy does, so it never reuses a socket
// Node has just closed (which would surface as a sporadic 502).
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;

// Graceful shutdown: stop accepting connections, let in-flight requests finish, close the pool.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  clearInterval(housekeeping);
  const force = setTimeout(() => { logger.error('forced exit after timeout'); process.exit(1); }, 10_000);
  force.unref();
  server.close(async () => {
    await pool.end().catch(() => {});
    logger.info('shutdown complete');
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled promise rejection'));
