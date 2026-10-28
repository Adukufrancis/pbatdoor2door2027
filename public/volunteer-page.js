// PBAT DOOR TO DOOR: volunteer area (My Ward, Log visit, Pledges, Leaderboard, Toolkit).
// Visits and pledges entered without signal are kept on the phone and sent automatically later.
import { $, $$, api, setLoading, message, toast, mountNav, mountFooter } from '/app.js';
import * as TK from '/toolkit.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('en-NG');
const local = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const CACHE = 'pbat-vol-cache', QUEUE = 'pbat-vol-queue';
const uid = () => (crypto.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`).replace(/[^\w-]/g, '');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });
const niceDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' });

// ---- Load (from the server, or the last copy saved on this phone when offline) ----
let data = null;
const res = await api('/api/volunteer');
if (res.status === 401) { location.replace('/login'); await new Promise(() => {}); }
if (res.ok) { data = res.data; local.set(CACHE, { at: Date.now(), data }); }
else {
  const saved = local.get(CACHE, null);
  if (saved) { data = saved.data; data.offlineSince = saved.at; }
}
mountNav(); mountFooter();
$('#boot').hidden = true; $('#content').hidden = false;

if (!data) {
  $('#content').innerHTML = `<div class="card-lite"><h1>You're offline</h1><p class="muted">Open the volunteer area once with signal, and it will work offline after that.</p>
    <button class="btn" onclick="location.reload()">Try again</button></div>`;
  await new Promise(() => {});                                     // stop here
}

// ---- Header ----
const me = data.me;
$('#hello').textContent = me.name ? `Hello, ${me.name.split(' ')[0]}` : 'Welcome';
$('#where').textContent = [me.ward && `${me.ward} ward`, me.lga, me.state].filter(Boolean).join(' · ');
$('#incomplete').hidden = Boolean(me.state && me.lga && me.ward);

// ---- Tabs (bottom bar on phones) ----
const TABS = ['ward', 'log', 'pledge', 'board', 'toolkit'];
function showTab() {
  const t = TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'ward';
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== t; });
  $$('#tabs a').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === t ? 'page' : 'false'));
  if (t === 'board') loadBoard();
  window.scrollTo({ top: 0 });
}
window.addEventListener('hashchange', showTab);

// ---- My Ward ----
function stat(n, label) { return `<div><b>${num(n)}</b><span>${label}</span></div>`; }
function renderWard() {
  $('#area').innerHTML = [['Polling unit', me.pollingUnit], ['Ward', me.ward], ['LGA', me.lga], ['State', me.state]]
    .map(([k, v]) => `<dt>${k}</dt><dd>${esc(v) || '<span class="muted">Not set</span>'}</dd>`).join('');
  $('#near').innerHTML = stat(data.area.pollingUnit, 'in your polling unit') + stat(data.area.ward, 'in your ward')
    + stat(data.area.lga, 'in your LGA') + stat(data.area.state, `in ${esc(me.state) || 'your state'}`);
  $('#wardstats').innerHTML = stat(data.ward.households30, 'households visited') + stat(data.ward.visits30, 'visits logged')
    + stat(data.ward.pledges, 'pledges (all time)');
  $('#coord').innerHTML = data.coordinators.length
    ? `<b>${data.coordinators.map(esc).join(', ')}</b><br><span class="muted">State coordinator for ${esc(me.state)}</span>`
    : `<span class="muted">No coordinator has been named for ${esc(me.state) || 'your state'} yet.</span>`;
  const queued = local.get(QUEUE, []).filter((x) => x.kind === 'visit');
  $('#mine').innerHTML = stat(data.totals.households + queued.reduce((a, x) => a + x.body.households, 0), 'households visited')
    + stat(data.totals.visits + queued.length, 'visits logged') + stat(data.totals.pledges, 'pledges');
  const rows = [...queued.map((x) => ({ ...x.body, waiting: true, visit_date: x.body.date })), ...data.visits];
  $('#visits').innerHTML = rows.length ? rows.slice(0, 10).map((v) => `<li><span><b>${num(v.households)} households</b>${v.area ? ` · ${esc(v.area)}` : ''}</span>
    <span class="muted">${v.waiting ? '<em class="pending">Waiting to send</em>' : niceDate(v.visit_date)}</span></li>`).join('')
    : '<li class="muted">No visits yet. Your first one is a tap away.</li>';
}

// ---- Pledges list ----
function renderPledges() {
  const queued = local.get(QUEUE, []).filter((x) => x.kind === 'pledge');
  const rows = [...queued.map((x) => ({ full_name: x.body.name, polling_unit: x.body.pollingUnit, waiting: true })), ...data.pledges];
  $('#pledge-count').textContent = num(data.totals.pledges + queued.length);
  $('#pledges').innerHTML = rows.length ? rows.slice(0, 20).map((p) => `<li><span><b>${esc(p.full_name)}</b>${p.polling_unit ? ` · ${esc(p.polling_unit)}` : ''}</span>
    <span class="muted">${p.waiting ? '<em class="pending">Waiting to send</em>' : new Date(p.created_at).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}</span></li>`).join('')
    : '<li class="muted">No pledges recorded yet.</li>';
}

// ---- Offline queue ----
function renderSync() {
  const q = local.get(QUEUE, []);
  const box = $('#sync');
  const lines = [];
  if (data.offlineSince) lines.push(`Offline: showing what was saved ${new Date(data.offlineSince).toLocaleString('en-NG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}`);
  if (q.length) lines.push(`${q.length} ${q.length === 1 ? 'entry' : 'entries'} saved on this phone, waiting to send <button type="button" class="linkish" id="send-now">Send now</button>`);
  box.hidden = !lines.length; box.innerHTML = lines.map((l) => `<span>${l}</span>`).join('');
  $('#send-now')?.addEventListener('click', () => flush(true));
}

let flushing = false;
async function flush(manual = false) {
  const q = local.get(QUEUE, []);
  if (!q.length || flushing) return;
  flushing = true;
  let sent = 0;
  for (const item of q) {
    const r = await api(item.kind === 'visit' ? '/api/visits' : '/api/pledges', item.body);
    if (r.status === 0 || r.status === 401 || r.status >= 500) break;           // still offline / logged out / server trouble: try later
    local.set(QUEUE, local.get(QUEUE, []).filter((x) => x.body.clientId !== item.body.clientId));
    if (r.ok) { sent++; data.totals = r.data.totals; }
  }
  flushing = false;
  if (sent) {
    toast(`✓ Sent ${sent} saved ${sent === 1 ? 'entry' : 'entries'}`);
    const fresh = await api('/api/volunteer');
    if (fresh.ok) { data = fresh.data; local.set(CACHE, { at: Date.now(), data }); }
  } else if (manual) toast('Still no connection. We\'ll keep trying.');
  renderWard(); renderPledges(); renderSync();
}
window.addEventListener('online', () => flush());
setInterval(() => { if (navigator.onLine) flush(); }, 60 * 1000);

/** Send to the server, or keep on the phone if there's no signal. */
async function submit(kind, body) {
  const r = await api(kind === 'visit' ? '/api/visits' : '/api/pledges', body);
  if (r.ok) { data.totals = r.data.totals; return { ok: true }; }
  if (r.status === 0) {
    local.set(QUEUE, [...local.get(QUEUE, []), { kind, body, at: Date.now() }]);
    return { queued: true };
  }
  return { error: r.data };
}
function fieldErrors(form, err) {
  $$('[data-f]', form).forEach((f) => { f.classList.remove('invalid'); const e = $('.err', f); if (e) e.textContent = ''; });
  if (err?.field) {
    const f = $(`[data-f="${err.field}"]`, form);
    if (f) { f.classList.add('invalid'); $('.err', f).textContent = err.error; f.querySelector('input,textarea')?.focus(); return true; }
  }
  return false;
}

// ---- Log a visit ----
const vf = $('#visit-form');
vf.date.value = today(); vf.date.max = today();
vf.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { clientId: uid(), date: vf.date.value || today(), households: Math.floor(Number(vf.households.value)),
    people: Math.floor(Number(vf.people.value) || 0), area: vf.area.value.trim(), notes: vf.notes.value.trim() };
  if (!(body.households >= 1)) return fieldErrors(vf, { field: 'households', error: 'Enter how many households you visited.' });
  if (body.households > 300) return fieldErrors(vf, { field: 'households', error: 'That looks too high for one visit. Check the number.' });
  fieldErrors(vf, null);
  const btn = $('button[type=submit]', vf); setLoading(btn, true);
  const r = await submit('visit', body);
  setLoading(btn, false);
  if (r.error) { if (!fieldErrors(vf, r.error)) message($('#visit-msg'), r.error.error || 'Something went wrong.'); return; }
  vf.reset(); vf.date.value = today();
  message($('#visit-msg'), r.queued ? 'Saved on your phone. It will send when you have signal.' : `✓ Saved. ${num(body.households)} households, well done!`, 'ok');
  if (!r.queued) { const f = await api('/api/volunteer'); if (f.ok) { data = f.data; local.set(CACHE, { at: Date.now(), data }); } }
  renderWard(); renderSync();
});

// ---- Pledges ----
const pf = $('#pledge-form');
pf.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { clientId: uid(), name: pf.name.value.trim(), phone: pf.phone.value.trim(), pollingUnit: pf.pollingUnit.value.trim(),
    note: pf.note.value.trim(), consent: pf.consent.checked };
  if (body.name.length < 2) return fieldErrors(pf, { field: 'name', error: "Enter the person's name." });
  if (body.phone && !/^(\+?234|0)[789]\d{9}$/.test(body.phone.replace(/[\s\-()]/g, ''))) return fieldErrors(pf, { field: 'phone', error: 'Enter a valid Nigerian phone number, or leave it blank.' });
  if (!body.consent) return fieldErrors(pf, { field: 'consent', error: 'Only record a pledge if the person agrees. Tick the box to confirm they did.' });
  fieldErrors(pf, null);
  const btn = $('button[type=submit]', pf); setLoading(btn, true);
  const r = await submit('pledge', body);
  setLoading(btn, false);
  if (r.error) { if (!fieldErrors(pf, r.error)) message($('#pledge-msg'), r.error.error || 'Something went wrong.'); return; }
  pf.reset();
  message($('#pledge-msg'), r.queued ? 'Saved on your phone. It will send when you have signal.' : `✓ Pledge from ${body.name} saved.`, 'ok');
  if (!r.queued) { const f = await api('/api/volunteer'); if (f.ok) { data = f.data; local.set(CACHE, { at: Date.now(), data }); } }
  renderPledges(); renderWard(); renderSync();
});

// ---- Leaderboard ----
let scope = 'state';
async function loadBoard() {
  $$('#scope button').forEach((b) => b.classList.toggle('on', b.dataset.scope === scope));
  $('#board').innerHTML = '<li class="muted">Loading…</li>';
  const r = await api(`/api/leaderboard?scope=${scope}`);
  if (!r.ok) { $('#board').innerHTML = `<li class="muted">${r.status === 0 ? 'The leaderboard needs a connection.' : 'Could not load the leaderboard.'}</li>`; $('#states').innerHTML = ''; return; }
  const medal = (n) => (n <= 3 ? `<i class="medal m${n}">${n}</i>` : `<i>${n}</i>`);
  $('#board').innerHTML = r.data.people.length ? r.data.people.map((p) => `<li class="${p.me ? 'me' : ''}">${medal(p.rank)}
      <span><b>${esc(p.name)}${p.me ? ' (you)' : ''}</b><small>${esc([p.ward, scope === 'national' ? p.state : ''].filter(Boolean).join(' · '))}</small></span>
      <strong>${num(p.households)}</strong></li>`).join('')
    : '<li class="muted">No visits logged here in the last 30 days. Be the first!</li>';
  $('#states').innerHTML = r.data.states.length ? r.data.states.map((s) => `<li class="${s.mine ? 'me' : ''}">${medal(s.rank)}
      <span><b>${esc(s.state)}</b><small>${num(s.volunteers)} active volunteers</small></span><strong>${num(s.households)}</strong></li>`).join('')
    : '<li class="muted">No visits logged in the last 30 days yet.</li>';
}
$('#scope').addEventListener('click', (e) => { const b = e.target.closest('[data-scope]'); if (!b) return; scope = b.dataset.scope; loadBoard(); });

// ---- Toolkit (stored in toolkit.js, works offline) ----
$('#tk-draft').hidden = TK.APPROVED;
const wa = (text) => `https://wa.me/?text=${encodeURIComponent(text)}`;
$('#tk-points').innerHTML = TK.TALKING_POINTS.map((p) => `<li><b>${esc(p.title)}.</b> ${esc(p.text)}
  <a class="share-wa" href="${wa(`${p.title}. ${p.text}\n\nJoin us: https://pbatdoor2door2027.org/join`)}" target="_blank" rel="noopener">Share on WhatsApp</a></li>`).join('');
$('#tk-facts').innerHTML = TK.FACT_SHEET.map((s) => `<h3 class="sub-h">${esc(s.area)}</h3><ul class="fact-list">${s.facts.map(([t, d, src, url]) =>
  `<li><b>${esc(t)}</b><span>${esc(d)}</span><a href="${esc(url)}" target="_blank" rel="noopener">Source: ${esc(src)} ↗</a></li>`).join('')}</ul>`).join('');
$('#tk-qa').innerHTML = TK.HARD_QUESTIONS.map((x) => `<details class="qa"><summary>${esc(x.q)}</summary><p>${esc(x.a)}</p></details>`).join('');
$('#tk-conduct').innerHTML = TK.CONDUCT.map((c) => `<li>${esc(c)}</li>`).join('');
$('#tk-voter').innerHTML = TK.VOTER_BASICS.map(([t, d, url]) => `<li><span><b>${esc(t)}</b><br><span class="muted">${esc(d)}</span></span>
  <a href="${esc(url)}" ${url.startsWith('http') ? 'target="_blank" rel="noopener"' : ''}>Open ↗</a></li>`).join('');

renderWard(); renderPledges(); renderSync(); showTab();
if (res.ok) flush();
