// PBAT DOOR TO DOOR: coordinator view. State coordinators see only their state; national admins choose any state.
import { $, api, setLoading, message, mountNav, mountFooter } from '/app.js';

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n || 0).toLocaleString('en-NG');
const phone = (p) => (p ? p.replace(/^\+234(\d{3})(\d{3})(\d{4})$/, '0$1 $2 $3') : '');
const day = (t) => new Date(t).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' });

let state = new URLSearchParams(location.search).get('state') || '';
const first = await api(`/api/coord/overview?state=${encodeURIComponent(state)}`);
if (first.status === 401) { location.replace('/login'); await new Promise(() => {}); }
mountNav(); mountFooter();
$('#boot').hidden = true; $('#content').hidden = false;
if (!first.ok) {
  $('#content').innerHTML = `<div class="card-lite"><h1>Coordinators only</h1><p class="muted">${esc(first.data.error || 'This page needs a connection.')}</p>
    <a class="btn" href="/volunteer">Go to the volunteer area</a></div>`;
  await new Promise(() => {});                                     // stop here
}
const national = first.data.role === 'national';

if (national) {
  $('#state-pick').hidden = false;
  $('#state').innerHTML = `<option value="">All states</option>${first.data.states.map((s) => `<option>${esc(s)}</option>`).join('')}`;
  $('#state').value = first.data.state;
  $('#state').addEventListener('change', () => {
    state = $('#state').value;
    history.replaceState(null, '', state ? `?state=${encodeURIComponent(state)}` : location.pathname);
    load();
  });
  $('#roles-card').hidden = false;
  $('#role-pick').innerHTML = `<optgroup label="State coordinator">${first.data.states.map((s) => `<option value="state:${esc(s)}">${esc(s)}</option>`).join('')}</optgroup>
    <option value="national:">National admin (sees everything)</option><option value="none:">Remove coordinator role</option>`;
  loadRoles();
}

let volunteers = [];
async function load(pre) {
  const ov = pre || await api(`/api/coord/overview?state=${encodeURIComponent(state)}`);
  if (!ov.ok) return;
  const d = ov.data; state = d.state;
  $('#title').textContent = d.state ? `${d.state} coordinator view` : 'All states';
  $('#scope-note').textContent = national ? 'You are a national admin: you can see every state.' : `You can see volunteers in ${d.state} only.`;
  $('#totals').innerHTML = [[d.totals.volunteers, 'volunteers'], [d.totals.households30, 'households visited (30 days)'],
    [d.totals.visits30, 'visits logged (30 days)'], [d.totals.pledges, 'pledges']].map(([n, l]) => `<div><b>${num(n)}</b><span>${l}</span></div>`).join('');
  $('#lga-card').hidden = !d.byLga.length;
  $('#lgas').innerHTML = `<thead><tr><th>LGA</th><th class="n">Volunteers</th><th class="n">Visits</th><th class="n">Households</th><th class="n">Pledges</th></tr></thead>
    <tbody>${d.byLga.map((r) => `<tr><td>${esc(r.lga) || '<span class="muted">Not set</span>'}</td><td class="n">${num(r.volunteers)}</td><td class="n">${num(r.visits)}</td>
    <td class="n">${num(r.households)}</td><td class="n">${num(r.pledges)}</td></tr>`).join('')}</tbody>`;
  const qs = `state=${encodeURIComponent(state)}&format=csv`;
  $('#vol-csv').href = `/api/coord/volunteers?${qs}`; $('#pl-csv').href = `/api/coord/pledges?${qs}`;

  const [v, p] = await Promise.all([api(`/api/coord/volunteers?state=${encodeURIComponent(state)}`), api(`/api/coord/pledges?state=${encodeURIComponent(state)}`)]);
  if (v.ok) { volunteers = v.data.volunteers; $('#vol-count').textContent = num(v.data.total); renderVols(); }
  $('#vol-more').hidden = !(v.ok && v.data.total > v.data.volunteers.length);
  $('#vol-more').textContent = 'Showing the first 1,000. Download the list to see everyone.';
  if (p.ok) {
    $('#pl-count').textContent = num(p.data.total);
    $('#pls').innerHTML = p.data.pledges.length ? `<thead><tr><th>Name</th><th>Phone</th><th>Polling unit</th><th>Ward / LGA</th><th>Recorded by</th><th>Date</th></tr></thead>
      <tbody>${p.data.pledges.map((r) => `<tr><td>${esc(r.full_name)}</td><td>${esc(phone(r.phone))}</td><td>${esc(r.polling_unit)}</td>
      <td>${esc([r.ward, r.lga, national && !state ? r.state : ''].filter(Boolean).join(', '))}</td><td>${esc(r.volunteer)}</td><td>${day(r.created_at)}</td></tr>`).join('')}</tbody>`
      : '<tbody><tr><td class="muted">No pledges recorded yet.</td></tr></tbody>';
  }
}

function renderVols() {
  const q = $('#q').value.trim().toLowerCase();
  const rows = q ? volunteers.filter((r) => [r.name, r.lga, r.ward, r.pollingUnit, r.phone, r.email, r.state].join(' ').toLowerCase().includes(q)) : volunteers;
  $('#vols').innerHTML = rows.length ? `<thead><tr><th>Name</th><th>Contact</th><th>LGA / ward</th><th>Polling unit</th><th class="n">Households</th><th class="n">Pledges</th></tr></thead>
    <tbody>${rows.slice(0, 300).map((r) => `<tr><td><b>${esc(r.name) || '<span class="muted">No name yet</span>'}</b>${national && !state ? `<br><small class="muted">${esc(r.state)}</small>` : ''}</td>
    <td>${esc(phone(r.phone))}${r.phone && r.email ? '<br>' : ''}<small>${esc(r.email)}</small></td><td>${esc(r.lga)}<br><small class="muted">${esc(r.ward)}</small></td>
    <td><small>${esc(r.pollingUnit)}</small></td><td class="n">${num(r.households)}</td><td class="n">${num(r.pledges)}</td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="muted">No volunteers match.</td></tr></tbody>';
}
$('#q').addEventListener('input', renderVols);

async function loadRoles() {
  const r = await api('/api/coord/roles');
  if (!r.ok) return;
  $('#roles').innerHTML = r.data.roles.length ? `<thead><tr><th>Name</th><th>Contact</th><th>Role</th></tr></thead><tbody>${r.data.roles.map((x) => `<tr>
    <td>${esc(x.name) || '<span class="muted">No name yet</span>'}</td><td>${esc(x.email || phone(x.phone))}</td>
    <td><span class="tag-role">${x.role === 'national' ? 'National admin' : `${esc(x.state)} coordinator`}</span></td></tr>`).join('')}</tbody>`
    : '<tbody><tr><td class="muted">No coordinators appointed yet.</td></tr></tbody>';
}
$('#role-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target; const [role, st] = f.pick.value.split(':');
  const box = f.querySelector('[data-f="identifier"]'); box.classList.remove('invalid'); message($('#role-msg'), '');
  const btn = f.querySelector('button[type=submit]'); setLoading(btn, true);
  const r = await api('/api/coord/roles', { identifier: f.identifier.value.trim(), role, state: st });
  setLoading(btn, false);
  if (!r.ok) {
    if (r.data.field === 'identifier') { box.classList.add('invalid'); box.querySelector('.err').textContent = r.data.error; return; }
    return message($('#role-msg'), r.data.error || 'Something went wrong.');
  }
  message($('#role-msg'), role === 'none' ? '✓ Role removed.' : `✓ ${r.data.name || 'They'} ${role === 'national' ? 'can now see every state' : `can now see ${st}`}.`, 'ok');
  f.identifier.value = ''; loadRoles();
});

load(first);
