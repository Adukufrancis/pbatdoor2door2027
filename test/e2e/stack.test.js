// End-to-end tests against the running docker compose stack (see scripts/test-stack.sh).
//   SITE        https://pbat.test        — through Caddy, like a visitor
//   APP_URL     http://127.0.0.1:3000    — the app's loopback port (used to simulate other IPs)
//   MOCK_URL    http://127.0.0.1:8025    — mock email/SMS provider that records the codes
//   PHASE       main | after-restart     — after-restart checks state survived a restart/restore
//   STATE_FILE  where phase "main" leaves data for later phases
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';

const SITE = process.env.SITE || 'https://pbat.test';
const WWW = SITE.replace('://', '://www.');
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:3000';
const MOCK_URL = process.env.MOCK_URL || 'http://127.0.0.1:8025';
const PHASE = process.env.PHASE || 'main';
const STATE_FILE = process.env.STATE_FILE || '/tmp/pbat-e2e-state.json';
const IP_LIMIT = Number(process.env.OTP_IP_LIMIT_PER_HOUR || 40);

const rnd = () => crypto.randomBytes(4).toString('hex');
const randomPhone = () => `080${String(crypto.randomInt(10_000_000, 99_999_999))}`;
const toE164 = (p) => `+234${p.slice(1)}`;

/** A browser-like client with its own cookie jar. */
function client(base = SITE, extraHeaders = {}) {
  let sid = null;
  const c = {
    lastSetCookie: null,
    get sid() { return sid; },
    set sid(v) { sid = v; },
    async req(method, path, body, headers = {}) {
      const res = await fetch(base + path, {
        method,
        redirect: 'manual',
        headers: {
          'User-Agent': 'pbat-e2e',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...(sid ? { Cookie: `sid=${sid}` } : {}),
          ...extraHeaders, ...headers,
        },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      });
      const set = res.headers.getSetCookie().find((h) => h.startsWith('sid='));
      if (set) {
        c.lastSetCookie = set;
        const v = set.slice(4, set.indexOf(';'));
        sid = v && !/Expires=Thu, 01 Jan 1970/i.test(set) ? v : null;
      }
      const text = await res.text();
      let data = null;
      try { data = JSON.parse(text); } catch {}
      return { status: res.status, data, text, headers: res.headers };
    },
    get: (p, h) => c.req('GET', p, undefined, h),
    post: (p, b = {}, h) => c.req('POST', p, b, h),
  };
  return c;
}

async function codeFor(to) {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`${MOCK_URL}/codes?to=${encodeURIComponent(to)}`);
    if (r.ok) return (await r.json()).code;
    await new Promise((r2) => setTimeout(r2, 100));
  }
  throw new Error(`no code delivered to ${to}`);
}

async function signIn(c, identifier, deliveredTo = identifier) {
  const start = await c.post('/api/auth/start', { identifier });
  assert.equal(start.status, 200, start.text);
  const verify = await c.post('/api/auth/verify', { identifier, code: await codeFor(deliveredTo) });
  assert.equal(verify.status, 200, verify.text);
  return verify.data;
}

const PROFILE = {
  full_name: 'Ada Test Obi', gender: 'Female', date_of_birth: '1990-05-17', state: 'Lagos', lga: 'Ikeja',
  ward: 'Ward A', polling_unit: 'PU 001', address: '1 Test Street', occupation: 'Engineer',
  interests: ['Social media', 'Door-to-door canvassing'], consent: true,
};

if (PHASE === 'main') {
  const state = {};

  test('health and readiness through Caddy', async () => {
    const c = client();
    assert.deepEqual((await c.get('/healthz')).data, { ok: true });
    assert.deepEqual((await c.get('/readyz')).data, { ok: true, db: 'up' });
  });

  test('HTTP redirects to HTTPS, www redirects to the apex', async () => {
    const http = await fetch(SITE.replace('https:', 'http:') + '/login?x=1', { redirect: 'manual' });
    assert.ok([301, 308].includes(http.status), `got ${http.status}`);
    assert.equal(http.headers.get('location'), `${SITE}/login?x=1`);
    const www = await fetch(`${WWW}/account?y=2`, { redirect: 'manual' });
    assert.equal(www.status, 301);
    assert.equal(www.headers.get('location'), `${SITE}/account?y=2`);
  });

  test('pages and legacy redirects', async () => {
    const c = client();
    for (const p of ['/', '/login', '/account']) {
      const r = await c.get(p);
      assert.equal(r.status, 200, p);
      assert.match(r.headers.get('content-type'), /text\/html/);
      assert.equal(r.headers.get('cache-control'), 'no-cache');
    }
    for (const [from, to] of [['/join', '/login'], ['/signup', '/login'], ['/welcome', '/account']]) {
      const r = await c.get(from);
      assert.equal(r.status, 302, from);
      assert.equal(r.headers.get('location'), to);
    }
    assert.equal((await c.get('/api/nope')).status, 404);
  });

  test('security headers', async () => {
    const r = await client().get('/');
    const csp = r.headers.get('content-security-policy');
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /script-src 'self' 'sha256-/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
    assert.match(r.headers.get('strict-transport-security'), /max-age=31536000/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.match(r.headers.get('permissions-policy'), /geolocation=\(self\)/);
    assert.equal(r.headers.get('x-powered-by'), null);
    assert.equal(r.headers.get('server'), null);
  });

  test('polling-unit JSON is served pre-compressed with long caching', async () => {
    const r = await fetch(`${SITE}/geo/lagos.json`, { headers: { 'Accept-Encoding': 'br, gzip' } });
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-encoding'), 'br');
    assert.match(r.headers.get('cache-control'), /max-age=604800/);
    const data = await r.json();
    assert.equal(data.state, 'Lagos');
    const gz = await fetch(`${SITE}/geo/index.json`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.ok((await gz.json()).Lagos);
  });

  test('options', async () => {
    const { data } = await client().get('/api/options');
    assert.equal(data.states.length, 37);
    assert.equal(data.sms, true);
    assert.equal(data.phoneVia, 'server');
    assert.equal(data.firebase, null);
  });

  test('API input checks', async () => {
    const c = client();
    assert.equal((await c.req('POST', '/api/auth/start', 'identifier=x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.equal((await c.req('POST', '/api/auth/start', '{bad json')).status, 400);
    assert.equal((await c.post('/api/auth/start', { identifier: 'nonsense' })).status, 400);
    assert.equal((await c.get('/api/me')).status, 401);
    assert.equal((await c.post('/api/me', PROFILE)).status, 401);
  });

  const emailA = `ada-${rnd()}@example.com`;
  const phoneB = randomPhone();
  const devA1 = client(), devA2 = client(), devB = client();

  test('email sign-in: send code, cooldown, wrong code, verify, session cookie', async () => {
    const start = await devA1.post('/api/auth/start', { identifier: emailA.toUpperCase() });
    assert.equal(start.status, 200, start.text);
    assert.equal(start.data.identifier, emailA);
    assert.equal(start.data.devCode, undefined, 'production must never reveal codes');
    assert.match(start.data.sentTo, /•/);

    const again = await devA1.post('/api/auth/start', { identifier: emailA });
    assert.equal(again.status, 429);
    assert.ok(again.data.retryAfter > 0);

    const wrong = await devA1.post('/api/auth/verify', { identifier: emailA, code: '000000' === (await codeFor(emailA)) ? '111111' : '000000' });
    assert.equal(wrong.status, 400);
    assert.match(wrong.data.error, /4 attempts left/);

    const ok = await devA1.post('/api/auth/verify', { identifier: emailA, code: await codeFor(emailA) });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.data.isNew, true);
    assert.equal(ok.data.needsProfile, true);
    assert.match(devA1.lastSetCookie, /HttpOnly/i);
    assert.match(devA1.lastSetCookie, /Secure/i);
    assert.match(devA1.lastSetCookie, /SameSite=Lax/i);

    const reuse = await client().post('/api/auth/verify', { identifier: emailA, code: await codeFor(emailA) });
    assert.equal(reuse.status, 400, 'a code is single-use');

    const me = await devA1.get('/api/me');
    assert.equal(me.status, 200);
    assert.equal(me.data.member.email, emailA);
    assert.equal(me.data.member.emailVerified, true);
    assert.equal(me.data.member.profileComplete, false);
    assert.equal(me.data.sessions.length, 1);
    assert.equal(me.data.sessions[0].current, true);
    assert.equal(me.data.sessions[0].userAgent, 'pbat-e2e');
  });

  test('profile save: validation, first save with consent, later edit', async () => {
    const bad = await devA1.post('/api/me', { full_name: 'Ada', state: 'Nowhere', lga: '' });
    assert.equal(bad.status, 400);
    assert.deepEqual(Object.keys(bad.data.fields).sort(), ['consent', 'full_name', 'lga', 'state']);

    const saved = await devA1.post('/api/me', PROFILE);
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.data.member.profileComplete, true);
    assert.equal(saved.data.member.full_name, 'Ada Test Obi');
    assert.deepEqual(saved.data.member.interests, ['Social media', 'Door-to-door canvassing']);

    const edit = await devA1.post('/api/me', { ...PROFILE, consent: undefined, occupation: 'Teacher' });
    assert.equal(edit.status, 200, edit.text);
    assert.equal(edit.data.member.occupation, 'Teacher');
  });

  test('second device signs in to the same account', async () => {
    const r = await signIn(devA2, emailA);
    assert.equal(r.isNew, false);
    assert.equal(r.needsProfile, false);
    const me = await devA1.get('/api/me');
    assert.equal(me.data.sessions.length, 2);
  });

  test('phone sign-in through the SMS provider', async () => {
    const r = await signIn(devB, phoneB, toE164(phoneB));
    assert.equal(r.isNew, true);
    assert.equal(r.member.phone, toE164(phoneB));
    const saved = await devB.post('/api/me', { ...PROFILE, full_name: 'Bayo Test', occupation: 'Trader', email: '' });
    assert.equal(saved.status, 200, saved.text);
  });

  test('account linking: proving a phone that has its own account merges the two', async () => {
    const already = await devA1.post('/api/me/link/start', { identifier: `other-${rnd()}@example.com` });
    assert.equal(already.status, 400, 'account already has a verified email');

    const start = await devA1.post('/api/me/link/start', { identifier: phoneB });
    assert.equal(start.status, 200, start.text);
    const bad = await devA1.post('/api/me/link/verify', { identifier: phoneB, code: '12345' });
    assert.equal(bad.status, 400);
    const ok = await devA1.post('/api/me/link/verify', { identifier: phoneB, code: await codeFor(toE164(phoneB)) });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.data.merged, true);
    const m = ok.data.member;
    assert.equal(m.email, emailA);
    assert.equal(m.phone, toE164(phoneB));
    assert.ok(m.emailVerified && m.phoneVerified);
    assert.equal(m.full_name, 'Ada Test Obi', 'the older account keeps its details');

    // B's device is now signed in to the merged account, and the phone signs in to it too.
    const meB = await devB.get('/api/me');
    assert.equal(meB.status, 200);
    assert.equal(meB.data.member.email, emailA);
    const viaPhone = await signIn(client(), phoneB, toE164(phoneB));
    assert.equal(viaPhone.member.email, emailA);
    assert.equal((await devA1.get('/api/me')).data.sessions.length, 4);
  });

  test('logout this device, then log out everywhere', async () => {
    assert.equal((await devA2.post('/api/auth/logout')).status, 200);
    assert.equal(devA2.sid, null);
    assert.equal((await devA2.get('/api/me')).status, 401);
    assert.equal((await devA1.get('/api/me')).status, 200);

    assert.equal((await devA1.post('/api/auth/logout-all')).status, 200);
    assert.equal((await devA1.get('/api/me')).status, 401);
    const stale = client(); stale.sid = devB.sid;
    assert.equal((await stale.get('/api/me')).status, 401, 'other devices are signed out too');
  });

  test('polling units near a location', async () => {
    const c = client();
    const lagos = await c.get('/api/geo/near?lat=6.5244&lng=3.3792');
    assert.equal(lagos.status, 200);
    const r = lagos.data.results;
    assert.ok(r.length >= 1 && r.length <= 6);
    for (let i = 1; i < r.length; i++) assert.ok(r[i - 1].metres <= r[i].metres);
    assert.ok(r.every((u) => u.state === 'Lagos' && u.metres < 25000 && u.name && u.code && u.lga && u.ward));
    assert.equal(lagos.headers.get('cache-control'), 'no-store');
    assert.deepEqual((await c.get('/api/geo/near?lat=0&lng=0')).data.results, []);
    assert.equal((await c.get('/api/geo/near?lat=abc&lng=3')).status, 400);
    assert.equal((await c.get('/api/geo/near?lat=95&lng=3')).status, 400);
  });

  test('per-IP code limit is enforced, and X-Forwarded-For from visitors is ignored by Caddy', async () => {
    const ip = `198.51.100.${crypto.randomInt(1, 254)}`;
    const direct = client(APP_URL, { 'X-Forwarded-For': ip });
    for (let i = 0; i < IP_LIMIT; i++) {
      const r = await direct.post('/api/auth/start', { identifier: `limit-${rnd()}@example.com` });
      assert.equal(r.status, 200, `request ${i + 1}: ${r.text}`);
    }
    const blocked = await direct.post('/api/auth/start', { identifier: `limit-${rnd()}@example.com` });
    assert.equal(blocked.status, 429);
    assert.match(blocked.data.error, /Too many codes/);

    // A visitor claiming to be that IP through Caddy is not affected (Caddy replaces the header).
    const spoof = client(SITE, { 'X-Forwarded-For': ip });
    assert.equal((await spoof.post('/api/auth/start', { identifier: `spoof-${rnd()}@example.com` })).status, 200);
    state.blockedIp = ip;
  });

  test('leave a signed-in session for the restart phase', async () => {
    const c = client();
    const email = `keeper-${rnd()}@example.com`;
    await signIn(c, email);
    assert.equal((await c.post('/api/me', PROFILE)).status, 200);
    state.sid = c.sid;
    state.email = email;
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  });
}

if (PHASE === 'after-restart') {
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

  test('sessions and profiles survive an app restart / database restore', async () => {
    const c = client(); c.sid = state.sid;
    const me = await c.get('/api/me');
    assert.equal(me.status, 200, me.text);
    assert.equal(me.data.member.email, state.email);
    assert.equal(me.data.member.full_name, 'Ada Test Obi');
  });

  test('the per-IP limit survives a restart (stored in Postgres)', async () => {
    const direct = client(APP_URL, { 'X-Forwarded-For': state.blockedIp });
    const r = await direct.post('/api/auth/start', { identifier: `limit-${rnd()}@example.com` });
    assert.equal(r.status, 429);
  });
}
