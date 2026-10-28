// Volunteer area (logged in): My Ward, logging door-to-door visits, pledges, leaderboards,
// and the coordinator view. Coordinators only ever see their own state; national admins see all.
//
// Who is a national admin: anyone whose verified email/phone is listed in NATIONAL_ADMINS
// (comma-separated, e.g. "boss@example.com, 08031234567"), plus anyone a national admin appoints.
// National admins appoint state coordinators on the /coordinator page.

const DAY = 24 * 60 * 60 * 1000;
const clean = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const int = (v, max) => { const n = Math.floor(Number(v)); return Number.isFinite(n) && n >= 0 ? Math.min(n, max) : 0; };
// "Adaeze Okonkwo" -> "Adaeze O." so leaderboards don't expose full names.
const shortName = (n) => {
  const parts = String(n || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'A volunteer';
  return parts.length === 1 ? parts[0] : `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
};
const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;                       // stop spreadsheet formulas
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const toCsv = (cols, rows) => [cols.map(([, label]) => csvCell(label)).join(','),
  ...rows.map((r) => cols.map(([k]) => csvCell(typeof k === 'function' ? k(r) : r[k])).join(','))].join('\r\n');
const localPhone = (p) => (p ? String(p).replace(/^\+234/, '0') : '');
const lagosDate = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Africa/Lagos' });

export function mountVolunteer(app, { store, h, normalizePhone, STATES }) {
  const NATIONAL = new Set(String(process.env.NATIONAL_ADMINS || '').split(',')
    .map((x) => x.trim().toLowerCase()).filter(Boolean)
    .map((x) => (x.includes('@') ? x : normalizePhone(x) || x)));

  async function roleOf(m) {
    if ((m.email_verified && NATIONAL.has(String(m.email).toLowerCase())) || (m.phone_verified && NATIONAL.has(m.phone))) {
      return { role: 'national', state: '' };
    }
    const r = await store.getRole(m.id);
    return r ? { role: r.role, state: r.state } : { role: 'volunteer', state: '' };
  }

  const needMember = (req, res) => {
    if (!req.member) { res.status(401).json({ error: 'Please log in.' }); return null; }
    return req.member;
  };
  /** Coordinator check. Returns the state they may see ('' = every state) or null after replying. */
  async function coordScope(req, res) {
    const m = needMember(req, res); if (!m) return null;
    const r = await roleOf(m);
    if (r.role === 'national') {
      const want = clean(req.query.state, 60);
      return { role: r, state: STATES.includes(want) ? want : '' };
    }
    if (r.role === 'state') return { role: r, state: r.state };
    res.status(403).json({ error: 'Only coordinators can see this page.' });
    return null;
  }

  // ---- My Ward + my activity ----
  app.get('/api/volunteer', h(async (req, res) => {
    const m = needMember(req, res); if (!m) return;
    const since = Date.now() - 30 * DAY;
    const [counts, totals, visits, pledges, ward, wardPledges, coords, role] = await Promise.all([
      store.areaCounts(m), store.myTotals(m.id), store.myVisits(m.id), store.myPledges(m.id),
      store.wardActivity(m, since), store.wardPledges(m), m.state ? store.stateCoordinators(m.state) : [], roleOf(m),
    ]);
    res.set('Cache-Control', 'no-store').json({
      me: { name: m.full_name, state: m.state, lga: m.lga, ward: m.ward, pollingUnit: m.polling_unit, profileComplete: Boolean(m.consent_at) },
      area: { pollingUnit: counts.pu_count, ward: counts.ward_count, lga: counts.lga_count, state: counts.state_count },
      ward: { households30: ward.households, visits30: ward.visits, pledges: wardPledges.pledges },
      coordinators: coords.map((c) => c.full_name).filter(Boolean),
      totals, visits, pledges, role: role.role, roleState: role.state,
    });
  }));

  // ---- Log a visit (also used to send visits saved offline; clientId makes resending safe) ----
  app.post('/api/visits', h(async (req, res) => {
    const m = needMember(req, res); if (!m) return;
    const b = req.body || {};
    const clientId = clean(b.clientId, 64);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(b.date) ? b.date : lagosDate(Date.now());
    const v = { clientId, date, households: int(b.households, 300), people: int(b.people, 2000), area: clean(b.area, 120), notes: clean(b.notes, 500) };
    if (!/^[\w-]{8,64}$/.test(clientId)) return res.status(400).json({ error: 'Something went wrong. Please try again.' });
    if (!v.households) return res.status(400).json({ error: 'Enter how many households you visited.', field: 'households' });
    if (date > lagosDate(Date.now() + DAY)) return res.status(400).json({ error: "The date can't be in the future.", field: 'date' });
    await store.insertVisit(m, v, Date.now());
    res.json({ ok: true, totals: await store.myTotals(m.id) });
  }));

  // ---- Record a pledge (only with the person's agreement) ----
  app.post('/api/pledges', h(async (req, res) => {
    const m = needMember(req, res); if (!m) return;
    const b = req.body || {};
    const clientId = clean(b.clientId, 64);
    if (!/^[\w-]{8,64}$/.test(clientId)) return res.status(400).json({ error: 'Something went wrong. Please try again.' });
    const p = { clientId, name: clean(b.name, 100), phone: '', pollingUnit: clean(b.pollingUnit, 160), note: clean(b.note, 300) };
    if (p.name.length < 2) return res.status(400).json({ error: "Enter the person's name.", field: 'name' });
    if (String(b.phone || '').trim()) {
      p.phone = normalizePhone(b.phone);
      if (!p.phone) return res.status(400).json({ error: 'Enter a valid Nigerian phone number, or leave it blank.', field: 'phone' });
    }
    if (b.consent !== true) return res.status(400).json({ error: 'Only record a pledge if the person agrees. Tick the box to confirm they did.', field: 'consent' });
    await store.insertPledge(m, p, Date.now());
    res.json({ ok: true, totals: await store.myTotals(m.id) });
  }));

  // ---- Leaderboards: households visited in the last 30 days ----
  app.get('/api/leaderboard', h(async (req, res) => {
    const m = needMember(req, res); if (!m) return;
    const since = Date.now() - 30 * DAY;
    const scope = ['ward', 'state', 'national'].includes(req.query.scope) ? req.query.scope : 'state';
    const rows = scope === 'ward' ? await store.topVolunteers(since, m.state || '-', m.lga || '-', m.ward || '-')
      : scope === 'state' ? await store.topVolunteers(since, m.state || '-')
        : await store.topVolunteers(since);
    res.set('Cache-Control', 'no-store').json({
      scope,
      people: rows.map((r, i) => ({ rank: i + 1, name: shortName(r.full_name), ward: r.ward, state: r.state, households: r.households, visits: r.visits, me: r.id === m.id })),
      states: (await store.topStates(since)).map((r, i) => ({ rank: i + 1, ...r, mine: r.state === m.state })),
    });
  }));

  // ---- Coordinators ----
  app.get('/api/coord/overview', h(async (req, res) => {
    const c = await coordScope(req, res); if (!c) return;
    const byLga = await store.coordByLga(c.state, Date.now() - 30 * DAY);
    const sum = (k) => byLga.reduce((a, r) => a + (Number(r[k]) || 0), 0);
    res.set('Cache-Control', 'no-store').json({
      role: c.role.role, state: c.state, myState: c.role.state, states: c.role.role === 'national' ? STATES : [c.role.state],
      totals: { volunteers: sum('volunteers'), visits30: sum('visits'), households30: sum('households'), pledges: sum('pledges') },
      byLga: c.state ? byLga : [],                                   // LGA table only makes sense for one state
    });
  }));

  app.get('/api/coord/volunteers', h(async (req, res) => {
    const c = await coordScope(req, res); if (!c) return;
    const rows = await store.coordVolunteers(c.state);
    if (req.query.format === 'csv') {
      const cols = [['full_name', 'Name'], [(r) => localPhone(r.phone), 'Phone'], ['email', 'Email'], ['state', 'State'], ['lga', 'LGA'], ['ward', 'Ward'],
        ['polling_unit', 'Polling unit'], ['gender', 'Gender'], ['occupation', 'Occupation'], ['interests', 'Can help with'],
        [(r) => (r.sms_optin ? 'Yes' : 'No'), 'SMS/WhatsApp updates'], ['visits', 'Visits logged'], ['households', 'Households visited'],
        ['pledges', 'Pledges'], [(r) => lagosDate(r.created_at), 'Joined']];
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="volunteers-${(c.state || 'all-states').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv"`, 'Cache-Control': 'no-store' });
      return res.send(`﻿${toCsv(cols, rows)}`);
    }
    res.set('Cache-Control', 'no-store').json({ volunteers: rows.slice(0, 1000).map((r) => ({
      name: r.full_name, phone: r.phone || '', email: r.email || '', lga: r.lga, ward: r.ward, pollingUnit: r.polling_unit, state: r.state,
      visits: r.visits, households: r.households, pledges: r.pledges, joined: r.created_at,
    })), total: rows.length });
  }));

  app.get('/api/coord/pledges', h(async (req, res) => {
    const c = await coordScope(req, res); if (!c) return;
    const rows = await store.coordPledges(c.state);
    if (req.query.format === 'csv') {
      const cols = [['full_name', 'Name'], [(r) => localPhone(r.phone), 'Phone'], ['polling_unit', 'Polling unit'], ['note', 'Note'], ['state', 'State'],
        ['lga', 'LGA'], ['ward', 'Ward'], ['volunteer', 'Recorded by'], [(r) => lagosDate(r.created_at), 'Date']];
      res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="pledges-${(c.state || 'all-states').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.csv"`, 'Cache-Control': 'no-store' });
      return res.send(`﻿${toCsv(cols, rows)}`);
    }
    res.set('Cache-Control', 'no-store').json({ pledges: rows.slice(0, 500), total: rows.length });
  }));

  // ---- Appointing coordinators (national admins only) ----
  const needNational = async (req, res) => {
    const m = needMember(req, res); if (!m) return null;
    if ((await roleOf(m)).role !== 'national') { res.status(403).json({ error: 'Only national admins can appoint coordinators.' }); return null; }
    return m;
  };
  app.get('/api/coord/roles', h(async (req, res) => {
    if (!(await needNational(req, res))) return;
    res.set('Cache-Control', 'no-store').json({ roles: (await store.listRoles()).map((r) => ({
      name: r.full_name, email: r.email || '', phone: r.phone || '', role: r.role, state: r.state, memberId: r.member_id,
    })) });
  }));
  app.post('/api/coord/roles', h(async (req, res) => {
    const me = await needNational(req, res); if (!me) return;
    const b = req.body || {};
    const raw = clean(b.identifier, 120);
    const target = raw.includes('@') ? await store.memberByVerified('email', raw.toLowerCase())
      : normalizePhone(raw) ? await store.memberByVerified('phone', normalizePhone(raw)) : null;
    if (!target) return res.status(404).json({ error: 'No member signs in with that email or phone. Ask them to join first.', field: 'identifier' });
    if (b.role === 'none') { await store.deleteRole(target.id); return res.json({ ok: true }); }
    if (b.role === 'state' && !STATES.includes(b.state)) return res.status(400).json({ error: 'Choose a state.', field: 'state' });
    if (!['state', 'national'].includes(b.role)) return res.status(400).json({ error: 'Choose a role.' });
    await store.setRole(target.id, b.role, b.role === 'state' ? b.state : '', me.id, Date.now());
    res.json({ ok: true, name: target.full_name });
  }));

  return { roleOf };
}
