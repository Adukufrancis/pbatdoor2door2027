import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createMailer } from '../../mailer.js';
import { inlineScriptHashes } from '../../security.js';

async function capture(fn) {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { seen.push({ headers: req.headers, body: JSON.parse(body) }); res.end('{}'); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}/send`); } finally { server.close(); }
  return seen;
}

test('Brevo request shape', async () => {
  const [req] = await capture((url) =>
    createMailer({ BREVO_API_KEY: 'k', BREVO_API_URL: url, MAIL_FROM: 'PBAT <no-reply@x.org>' }).send('a@b.co', '123456'));
  assert.equal(req.headers['api-key'], 'k');
  assert.deepEqual(req.body.sender, { email: 'no-reply@x.org', name: 'PBAT' });
  assert.deepEqual(req.body.to, [{ email: 'a@b.co' }]);
  assert.match(req.body.subject, /123456/);
});

test('ZeptoMail request shape (token with or without the Zoho-enczapikey prefix)', async () => {
  for (const token of ['tok', 'Zoho-enczapikey tok']) {
    const mailer = createMailer({ ZEPTOMAIL_TOKEN: token, MAIL_FROM: 'no-reply@x.org' });
    assert.equal(mailer.provider, 'zeptomail');
    const [req] = await capture((url) =>
      createMailer({ ZEPTOMAIL_TOKEN: token, ZEPTOMAIL_API_URL: url, MAIL_FROM: 'no-reply@x.org' }).send('a@b.co', '654321'));
    assert.equal(req.headers.authorization, 'Zoho-enczapikey tok');
    assert.deepEqual(req.body.from, { address: 'no-reply@x.org', name: 'PBAT DOOR TO DOOR' });
    assert.deepEqual(req.body.to, [{ email_address: { address: 'a@b.co' } }]);
    assert.match(req.body.htmlbody, /654321/);
  }
});

test('provider order: Brevo wins over ZeptoMail, which wins over Resend', () => {
  assert.equal(createMailer({ BREVO_API_KEY: 'a', ZEPTOMAIL_TOKEN: 'b' }).provider, 'brevo');
  assert.equal(createMailer({ ZEPTOMAIL_TOKEN: 'b', RESEND_API_KEY: 'c' }).provider, 'zeptomail');
  assert.equal(createMailer({}).provider, null);
});

test('CSP hashes match every inline script in the pages', () => {
  const pub = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
  const hashes = inlineScriptHashes(pub);
  const found = [];
  for (const file of fs.readdirSync(pub).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(pub, file), 'utf8');
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (!m[1].trim()) continue;
      const hash = `'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`;
      found.push(hash);
      assert.ok(hashes.includes(hash), `${file} inline script is missing from CSP`);
    }
  }
  assert.ok(found.length >= 3);
  assert.equal(hashes.length, new Set(found).size);
});
