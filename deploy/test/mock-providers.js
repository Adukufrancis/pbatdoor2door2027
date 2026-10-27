// Stand-in for Brevo (email) and DageSMS (SMS) during the stack tests, so the app runs with
// its production configuration and real provider code paths. Records each message; the tests
// read the latest code for an address from GET /codes?to=<email or +234…>.
import http from 'node:http';

const latest = new Map();

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  if (req.method === 'GET' && url.pathname === '/codes') {
    const code = latest.get(url.searchParams.get('to'));
    res.writeHead(code ? 200 : 404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ code: code || null }));
  }
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let j = {};
    try { j = JSON.parse(body); } catch {}
    let to = null, text = '';
    if (url.pathname === '/brevo' && req.headers['api-key']) { to = j.to?.[0]?.email; text = j.subject; }
    if (url.pathname === '/dagesms/v1/messages' && /^Bearer /.test(req.headers.authorization || '')) { to = j.to; text = j.body; }
    const code = String(text || '').match(/\b(\d{6})\b/)?.[1];
    if (!to || !code) { res.writeHead(400); return res.end('{"status":"error"}'); }
    latest.set(to, code);
    console.log(`mock: ${url.pathname} -> ${to}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'success', messageId: `m${Date.now()}` }));
  });
}).listen(8025, '0.0.0.0', () => console.log('mock providers on :8025'));
