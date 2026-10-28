// Data layer. Uses Postgres when DATABASE_URL is set (production, e.g. Neon on Render),
// otherwise a local SQLite file (development). Both expose the same async API.
//
// Members sign in with an email OR a phone number. A contact is "verified" once the
// person has entered a code sent to it; only verified contacts can be used to log in,
// and each verified email/phone belongs to at most one member.
import path from 'node:path';

// Profile questions asked after the first login (all stored as text).
export const PROFILE_FIELDS = [
  'full_name', 'gender', 'date_of_birth', 'state', 'lga', 'ward',
  'polling_unit', 'address', 'occupation', 'interests',
];

const SCHEMA = (big, idDef) => `
  CREATE TABLE IF NOT EXISTS members (
    id              ${idDef},
    email           TEXT,
    email_verified  INTEGER NOT NULL DEFAULT 0,
    phone           TEXT,
    phone_verified  INTEGER NOT NULL DEFAULT 0,
    full_name       TEXT NOT NULL DEFAULT '',
    gender          TEXT NOT NULL DEFAULT '',
    date_of_birth   TEXT NOT NULL DEFAULT '',
    state           TEXT NOT NULL DEFAULT '',
    lga             TEXT NOT NULL DEFAULT '',
    ward            TEXT NOT NULL DEFAULT '',
    polling_unit    TEXT NOT NULL DEFAULT '',
    address         TEXT NOT NULL DEFAULT '',
    occupation      TEXT NOT NULL DEFAULT '',
    interests       TEXT NOT NULL DEFAULT '',
    consent_at      ${big},
    created_at      ${big} NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS members_email_verified_uq ON members(email) WHERE email_verified = 1;
  CREATE UNIQUE INDEX IF NOT EXISTS members_phone_verified_uq ON members(phone) WHERE phone_verified = 1;
  CREATE INDEX IF NOT EXISTS members_email_idx ON members(email);
  CREATE INDEX IF NOT EXISTS members_phone_idx ON members(phone);

  CREATE TABLE IF NOT EXISTS otp_codes (
    identifier  TEXT PRIMARY KEY,
    channel     TEXT NOT NULL,
    code_hash   TEXT NOT NULL,
    expires_at  ${big} NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    sent_at     ${big} NOT NULL
  );

  CREATE TABLE IF NOT EXISTS member_sessions (
    token_hash  TEXT PRIMARY KEY,
    member_id   INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    created_at  ${big} NOT NULL,
    last_seen   ${big} NOT NULL,
    user_agent  TEXT
  );
  CREATE INDEX IF NOT EXISTS member_sessions_member_idx ON member_sessions(member_id);

  -- Volunteer area: door-to-door visits a volunteer logs (client_id stops the same offline entry being saved twice).
  -- The volunteer's state/LGA/ward are copied onto each row so coordinators can see activity by area.
  CREATE TABLE IF NOT EXISTS visits (
    id            ${idDef},
    member_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    client_id     TEXT NOT NULL UNIQUE,
    visit_date    TEXT NOT NULL,
    households    INTEGER NOT NULL DEFAULT 0,
    people        INTEGER NOT NULL DEFAULT 0,
    area          TEXT NOT NULL DEFAULT '',
    notes         TEXT NOT NULL DEFAULT '',
    state         TEXT NOT NULL DEFAULT '',
    lga           TEXT NOT NULL DEFAULT '',
    ward          TEXT NOT NULL DEFAULT '',
    created_at    ${big} NOT NULL
  );
  CREATE INDEX IF NOT EXISTS visits_member_idx ON visits(member_id);
  CREATE INDEX IF NOT EXISTS visits_state_idx ON visits(state, created_at);

  -- Pledges of support a volunteer records at the door, only with the person's consent.
  CREATE TABLE IF NOT EXISTS pledges (
    id            ${idDef},
    member_id     INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    client_id     TEXT NOT NULL UNIQUE,
    full_name     TEXT NOT NULL,
    phone         TEXT NOT NULL DEFAULT '',
    polling_unit  TEXT NOT NULL DEFAULT '',
    note          TEXT NOT NULL DEFAULT '',
    consent_at    ${big} NOT NULL,
    state         TEXT NOT NULL DEFAULT '',
    lga           TEXT NOT NULL DEFAULT '',
    ward          TEXT NOT NULL DEFAULT '',
    created_at    ${big} NOT NULL
  );
  CREATE INDEX IF NOT EXISTS pledges_member_idx ON pledges(member_id);
  CREATE INDEX IF NOT EXISTS pledges_state_idx ON pledges(state, created_at);

  -- Coordinators: 'state' (sees only their state) or 'national' (sees everything, appoints coordinators).
  CREATE TABLE IF NOT EXISTS roles (
    member_id     INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    role          TEXT NOT NULL,
    state         TEXT NOT NULL DEFAULT '',
    assigned_by   INTEGER,
    assigned_at   ${big} NOT NULL
  );
`;

const MEMBER_COLS = `id, email, email_verified, phone, phone_verified, ${PROFILE_FIELDS.join(', ')}, consent_at, created_at`;

// Every query is written once with $1, $2… placeholders.
const QUERIES = {
  getCode: 'SELECT * FROM otp_codes WHERE identifier = $1',
  upsertCode: `INSERT INTO otp_codes (identifier, channel, code_hash, expires_at, attempts, sent_at)
               VALUES ($1, $2, $3, $4, 0, $5)
               ON CONFLICT (identifier) DO UPDATE SET channel = EXCLUDED.channel, code_hash = EXCLUDED.code_hash,
                 expires_at = EXCLUDED.expires_at, attempts = 0, sent_at = EXCLUDED.sent_at`,
  bumpAttempts: 'UPDATE otp_codes SET attempts = attempts + 1 WHERE identifier = $1',
  deleteCode: 'DELETE FROM otp_codes WHERE identifier = $1',
  purgeCodes: 'DELETE FROM otp_codes WHERE expires_at < $1',

  memberByVerifiedEmail: `SELECT ${MEMBER_COLS} FROM members WHERE email = $1 AND email_verified = 1`,
  memberByVerifiedPhone: `SELECT ${MEMBER_COLS} FROM members WHERE phone = $1 AND phone_verified = 1`,
  memberById: `SELECT ${MEMBER_COLS} FROM members WHERE id = $1`,
  // When someone proves they own a contact, remove it from any account that only typed it in.
  releaseUnverifiedEmail: 'UPDATE members SET email = NULL WHERE email = $1 AND email_verified = 0',
  releaseUnverifiedPhone: 'UPDATE members SET phone = NULL WHERE phone = $1 AND phone_verified = 0',
  insertByEmail: 'INSERT INTO members (email, email_verified, created_at) VALUES ($1, 1, $2)',
  insertByPhone: 'INSERT INTO members (phone, phone_verified, created_at) VALUES ($1, 1, $2)',
  verifyEmail: 'UPDATE members SET email_verified = 1 WHERE id = $1 AND email = $2',
  verifyPhone: 'UPDATE members SET phone_verified = 1 WHERE id = $1 AND phone = $2',
  setEmail: 'UPDATE members SET email = $2, email_verified = 0 WHERE id = $1 AND email_verified = 0',
  setPhone: 'UPDATE members SET phone = $2, phone_verified = 0 WHERE id = $1 AND phone_verified = 0',
  linkEmail: 'UPDATE members SET email = $2, email_verified = 1 WHERE id = $1',
  linkPhone: 'UPDATE members SET phone = $2, phone_verified = 1 WHERE id = $1',
  moveSessions: 'UPDATE member_sessions SET member_id = $2 WHERE member_id = $1',
  deleteMember: 'DELETE FROM members WHERE id = $1',
  moveVisits: 'UPDATE visits SET member_id = $2 WHERE member_id = $1',
  movePledges: 'UPDATE pledges SET member_id = $2 WHERE member_id = $1',
  moveRole: 'UPDATE roles SET member_id = $2 WHERE member_id = $1 AND NOT EXISTS (SELECT 1 FROM roles r2 WHERE r2.member_id = $2)',
  mergeInto: `UPDATE members SET email = $2, email_verified = $3, phone = $4, phone_verified = $5,
                ${PROFILE_FIELDS.map((f, i) => `${f} = $${i + 6}`).join(', ')},
                consent_at = $${PROFILE_FIELDS.length + 6}, created_at = $${PROFILE_FIELDS.length + 7} WHERE id = $1`,
  updateProfile: `UPDATE members SET ${PROFILE_FIELDS.map((f, i) => `${f} = $${i + 2}`).join(', ')},
                    consent_at = COALESCE(consent_at, $${PROFILE_FIELDS.length + 2}) WHERE id = $1`,

  insertSession: `INSERT INTO member_sessions (token_hash, member_id, created_at, last_seen, user_agent)
                  VALUES ($1, $2, $3, $4, $5)`,
  getSession: 'SELECT token_hash, member_id, last_seen FROM member_sessions WHERE token_hash = $1',
  touchSession: 'UPDATE member_sessions SET last_seen = $1 WHERE token_hash = $2',
  listSessions: `SELECT token_hash, created_at, last_seen, user_agent FROM member_sessions
                  WHERE member_id = $1 ORDER BY last_seen DESC`,
  deleteSession: 'DELETE FROM member_sessions WHERE token_hash = $1',
  deleteMemberSessions: 'DELETE FROM member_sessions WHERE member_id = $1',
  // Consent given on the sign-up screen (timestamped). Unticking SMS later doesn't happen here.
  recordConsent: `UPDATE members SET join_consent_at = COALESCE(join_consent_at, $2),
                    sms_optin = CASE WHEN $3 = 1 THEN 1 ELSE sms_optin END,
                    sms_consent_at = CASE WHEN $3 = 1 THEN COALESCE(sms_consent_at, $2) ELSE sms_consent_at END
                  WHERE id = $1`,

  // ---- Volunteer area ----
  insertVisit: `INSERT INTO visits (member_id, client_id, visit_date, households, people, area, notes, state, lga, ward, created_at)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (client_id) DO NOTHING`,
  insertPledge: `INSERT INTO pledges (member_id, client_id, full_name, phone, polling_unit, note, consent_at, state, lga, ward, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (client_id) DO NOTHING`,
  myVisits: `SELECT client_id, visit_date, households, people, area, notes, created_at FROM visits
             WHERE member_id = $1 ORDER BY visit_date DESC, created_at DESC LIMIT 20`,
  myPledges: `SELECT client_id, full_name, polling_unit, created_at FROM pledges WHERE member_id = $1 ORDER BY created_at DESC LIMIT 20`,
  myTotals: `SELECT (SELECT COUNT(*) FROM visits WHERE member_id = $1) AS visits,
                    (SELECT COALESCE(SUM(households), 0) FROM visits WHERE member_id = $1) AS households,
                    (SELECT COALESCE(SUM(people), 0) FROM visits WHERE member_id = $1) AS people,
                    (SELECT COUNT(*) FROM pledges WHERE member_id = $1) AS pledges`,
  // How many members share my polling unit / ward / LGA / state.
  areaCounts: `SELECT
      (SELECT COUNT(*) FROM members WHERE consent_at IS NOT NULL AND state = $1 AND lga = $2 AND ward = $3 AND polling_unit = $4 AND polling_unit <> '') AS pu_count,
      (SELECT COUNT(*) FROM members WHERE consent_at IS NOT NULL AND state = $1 AND lga = $2 AND ward = $3 AND ward <> '') AS ward_count,
      (SELECT COUNT(*) FROM members WHERE consent_at IS NOT NULL AND state = $1 AND lga = $2 AND lga <> '') AS lga_count,
      (SELECT COUNT(*) FROM members WHERE consent_at IS NOT NULL AND state = $1 AND state <> '') AS state_count`,
  wardActivity: `SELECT COALESCE(SUM(households), 0) AS households, COUNT(*) AS visits FROM visits
                 WHERE state = $1 AND lga = $2 AND ward = $3 AND created_at >= $4`,
  wardPledges: 'SELECT COUNT(*) AS pledges FROM pledges WHERE state = $1 AND lga = $2 AND ward = $3',
  stateCoordinators: `SELECT m.full_name FROM roles r JOIN members m ON m.id = r.member_id
                      WHERE r.role = 'state' AND r.state = $1 ORDER BY m.full_name`,
  // Leaderboards: households visited since $1, optionally narrowed to a state / LGA / ward ('' = any).
  topVolunteers: `SELECT m.id, m.full_name, m.state, m.ward, SUM(v.households) AS households, COUNT(*) AS visits
                  FROM visits v JOIN members m ON m.id = v.member_id
                  WHERE v.created_at >= $1 AND ($2 = '' OR v.state = $2) AND ($3 = '' OR v.lga = $3) AND ($4 = '' OR v.ward = $4)
                  GROUP BY m.id, m.full_name, m.state, m.ward ORDER BY households DESC, visits DESC LIMIT 20`,
  topStates: `SELECT state, SUM(households) AS households, COUNT(*) AS visits, COUNT(DISTINCT member_id) AS volunteers
              FROM visits WHERE created_at >= $1 AND state <> '' GROUP BY state ORDER BY households DESC LIMIT 37`,

  // ---- Coordinators ('' state = all states, national only) ----
  getRole: 'SELECT member_id, role, state FROM roles WHERE member_id = $1',
  setRole: `INSERT INTO roles (member_id, role, state, assigned_by, assigned_at) VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (member_id) DO UPDATE SET role = EXCLUDED.role, state = EXCLUDED.state,
              assigned_by = EXCLUDED.assigned_by, assigned_at = EXCLUDED.assigned_at`,
  deleteRole: 'DELETE FROM roles WHERE member_id = $1',
  listRoles: `SELECT r.member_id, r.role, r.state, r.assigned_at, m.full_name, m.email, m.phone FROM roles r
              JOIN members m ON m.id = r.member_id ORDER BY r.role, r.state, m.full_name`,
  coordVolunteers: `SELECT m.id, m.full_name, m.email, m.phone, m.gender, m.state, m.lga, m.ward, m.polling_unit, m.occupation,
                      m.interests, m.sms_optin, m.created_at,
                      (SELECT COUNT(*) FROM visits v WHERE v.member_id = m.id) AS visits,
                      (SELECT COALESCE(SUM(households), 0) FROM visits v WHERE v.member_id = m.id) AS households,
                      (SELECT COUNT(*) FROM pledges p WHERE p.member_id = m.id) AS pledges
                    FROM members m WHERE m.consent_at IS NOT NULL AND ($1 = '' OR m.state = $1)
                    ORDER BY m.state, m.lga, m.ward, m.full_name LIMIT 5000`,
  coordPledges: `SELECT p.full_name, p.phone, p.polling_unit, p.note, p.state, p.lga, p.ward, p.created_at, m.full_name AS volunteer
                 FROM pledges p JOIN members m ON m.id = p.member_id WHERE ($1 = '' OR p.state = $1)
                 ORDER BY p.created_at DESC LIMIT 5000`,
  coordByLgaMembers: `SELECT lga, COUNT(*) AS volunteers FROM members WHERE consent_at IS NOT NULL AND ($1 = '' OR state = $1)
                      GROUP BY lga`,
  coordByLgaVisits: `SELECT lga, COUNT(*) AS visits, COALESCE(SUM(households), 0) AS households FROM visits
                     WHERE ($1 = '' OR state = $1) AND created_at >= $2 GROUP BY lga`,
  coordByLgaPledges: 'SELECT lga, COUNT(*) AS pledges FROM pledges WHERE ($1 = \'\' OR state = $1) GROUP BY lga',
};

// Columns added after the first release (added to existing databases on start-up).
const ADDED_COLUMNS = [
  ['join_consent_at', 'BIGINT', 'INTEGER'],
  ['sms_optin', 'INTEGER NOT NULL DEFAULT 0', 'INTEGER NOT NULL DEFAULT 0'],
  ['sms_consent_at', 'BIGINT', 'INTEGER'],
];

// Postgres returns BIGINT as strings; turn numeric columns back into numbers.
const NUMERIC = new Set(['id', 'member_id', 'created_at', 'expires_at', 'sent_at', 'last_seen', 'attempts',
  'consent_at', 'email_verified', 'phone_verified', 'visits', 'households', 'people', 'pledges', 'volunteers',
  'pu_count', 'ward_count', 'lga_count', 'state_count', 'assigned_at', 'assigned_by', 'sms_optin']);
const fixRow = (r) => {
  if (!r) return r;
  for (const k of Object.keys(r)) if (NUMERIC.has(k) && r[k] != null) r[k] = Number(r[k]);
  return r;
};

async function createPostgres(url) {
  const { default: pg } = await import('pg');
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    ssl: local || /sslmode=disable/.test(url) ? false : { rejectUnauthorized: false },
    max: 5,
  });
  await pool.query(SCHEMA('BIGINT', 'SERIAL PRIMARY KEY'));
  for (const [col, pgType] of ADDED_COLUMNS) await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS ${col} ${pgType}`);
  const q = async (name, params = []) => (await pool.query(QUERIES[name], params)).rows.map(fixRow);
  return { kind: 'postgres', q, close: () => pool.end() };
}

async function createSqlite(file) {
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA('INTEGER', 'INTEGER PRIMARY KEY AUTOINCREMENT'));
  for (const [col, , liteType] of ADDED_COLUMNS) { try { db.exec(`ALTER TABLE members ADD COLUMN ${col} ${liteType}`); } catch {} }
  const stmts = {};
  const q = async (name, params = []) => {
    const sql = QUERIES[name].replace(/\$(\d+)/g, '?$1');
    const stmt = (stmts[name] ??= db.prepare(sql));
    return /^\s*SELECT/i.test(sql) ? stmt.all(...params).map((r) => ({ ...r })) : (stmt.run(...params), []);
  };
  return { kind: 'sqlite', q, close: () => db.close() };
}

export async function createStore() {
  const raw = process.env.DATABASE_URL ? await createPostgres(process.env.DATABASE_URL)
    : await createSqlite(process.env.DB_PATH || path.join(process.cwd(), 'data.db'));
  const one = async (name, params) => (await raw.q(name, params))[0];
  const byVerified = (type, value) => one(type === 'email' ? 'memberByVerifiedEmail' : 'memberByVerifiedPhone', [value]);

  return {
    kind: raw.kind,
    close: raw.close,

    getCode: (id) => one('getCode', [id]),
    upsertCode: (id, channel, hash, expiresAt, sentAt) => raw.q('upsertCode', [id, channel, hash, expiresAt, sentAt]),
    bumpAttempts: (id) => raw.q('bumpAttempts', [id]),
    deleteCode: (id) => raw.q('deleteCode', [id]),
    purgeCodes: (now) => raw.q('purgeCodes', [now]),

    memberById: (id) => one('memberById', [id]),
    memberByVerified: byVerified,

    /** The person proved they own this email/phone: return their member, creating one if new. */
    async signInWith(type, value, now) {
      const existing = await byVerified(type, value);
      if (existing) return { member: existing, isNew: false };
      await raw.q(type === 'email' ? 'releaseUnverifiedEmail' : 'releaseUnverifiedPhone', [value]);
      try {
        await raw.q(type === 'email' ? 'insertByEmail' : 'insertByPhone', [value, now]);
      } catch (err) {
        // Two sign-ins racing for the same new contact: the other one won, use it.
        const winner = await byVerified(type, value);
        if (winner) return { member: winner, isNew: false };
        throw err;
      }
      return { member: await byVerified(type, value), isNew: true };
    },

    /** Store a contact the member typed in (not verified yet). Returns false if someone else has it verified. */
    async setContact(memberId, type, value) {
      const owner = await byVerified(type, value);
      if (owner && owner.id !== memberId) return false;
      if (owner && owner.id === memberId) return true;
      await raw.q(type === 'email' ? 'setEmail' : 'setPhone', [memberId, value]);
      return true;
    },

    /**
     * The member proved they own this email/phone. Attach it to their account; if another account
     * already signs in with it, merge the two (the older account is kept, sessions move with it).
     */
    async linkContact(memberId, type, value) {
      const owner = await byVerified(type, value);
      if (owner && owner.id === memberId) return { memberId, merged: false };
      if (!owner) {
        await raw.q(type === 'email' ? 'releaseUnverifiedEmail' : 'releaseUnverifiedPhone', [value]);
        await raw.q(type === 'email' ? 'linkEmail' : 'linkPhone', [memberId, value]);
        return { memberId, merged: false };
      }
      const me = await one('memberById', [memberId]);
      const [keep, drop] = owner.id < me.id ? [owner, me] : [me, owner];
      const pick = (t) => {
        const a = keep[`${t}_verified`] ? keep[t] : null, b = drop[`${t}_verified`] ? drop[t] : null;
        if (a && b && a !== b) return null;                      // two different verified contacts: can't merge
        return a || b ? [a || b, 1] : [keep[t] || drop[t] || null, 0];
      };
      const email = pick('email'), phone = pick('phone');
      if (!email || !phone) return { conflict: true };
      const consents = [keep.consent_at, drop.consent_at].filter((x) => x != null);
      await raw.q('moveSessions', [drop.id, keep.id]);
      for (const k of ['moveVisits', 'movePledges', 'moveRole']) await raw.q(k, [drop.id, keep.id]);
      await raw.q('deleteMember', [drop.id]);                  // frees its verified contacts for the keeper
      await raw.q('mergeInto', [keep.id, email[0], email[1], phone[0], phone[1],
        ...PROFILE_FIELDS.map((f) => keep[f] || drop[f] || ''),
        consents.length ? Math.min(...consents) : null, Math.min(keep.created_at, drop.created_at)]);
      return { memberId: keep.id, merged: true };
    },

    recordConsent: (id, now, sms) => raw.q('recordConsent', [id, now, sms ? 1 : 0]),

    updateProfile: (id, profile, now) =>
      raw.q('updateProfile', [id, ...PROFILE_FIELDS.map((f) => profile[f] ?? ''), now]),

    insertSession: (hash, memberId, now, ua) => raw.q('insertSession', [hash, memberId, now, now, ua]),
    getSession: (hash) => one('getSession', [hash]),
    touchSession: (hash, now) => raw.q('touchSession', [now, hash]),
    listSessions: (memberId) => raw.q('listSessions', [memberId]),
    deleteSession: (hash) => raw.q('deleteSession', [hash]),
    deleteMemberSessions: (memberId) => raw.q('deleteMemberSessions', [memberId]),

    // ---- Volunteer area ----
    insertVisit: (m, v, now) => raw.q('insertVisit', [m.id, v.clientId, v.date, v.households, v.people, v.area, v.notes,
      m.state || '', m.lga || '', m.ward || '', now]),
    insertPledge: (m, p, now) => raw.q('insertPledge', [m.id, p.clientId, p.name, p.phone, p.pollingUnit, p.note, now,
      m.state || '', m.lga || '', m.ward || '', now]),
    myVisits: (id) => raw.q('myVisits', [id]),
    myPledges: (id) => raw.q('myPledges', [id]),
    myTotals: (id) => one('myTotals', [id]),
    areaCounts: (m) => one('areaCounts', [m.state || '', m.lga || '', m.ward || '', m.polling_unit || '']),
    wardActivity: (m, since) => one('wardActivity', [m.state || '', m.lga || '', m.ward || '', since]),
    wardPledges: (m) => one('wardPledges', [m.state || '', m.lga || '', m.ward || '']),
    stateCoordinators: (state) => raw.q('stateCoordinators', [state]),
    topVolunteers: (since, state = '', lga = '', ward = '') => raw.q('topVolunteers', [since, state, lga, ward]),
    topStates: (since) => raw.q('topStates', [since]),

    getRole: (id) => one('getRole', [id]),
    setRole: (id, role, state, by, now) => raw.q('setRole', [id, role, state, by, now]),
    deleteRole: (id) => raw.q('deleteRole', [id]),
    listRoles: () => raw.q('listRoles'),
    coordVolunteers: (state) => raw.q('coordVolunteers', [state]),
    coordPledges: (state) => raw.q('coordPledges', [state]),
    async coordByLga(state, since) {
      const rows = new Map();
      const add = (list) => list.forEach((r) => rows.set(r.lga, { lga: r.lga, volunteers: 0, visits: 0, households: 0, pledges: 0, ...rows.get(r.lga), ...r }));
      add(await raw.q('coordByLgaMembers', [state]));
      add(await raw.q('coordByLgaVisits', [state, since]));
      add(await raw.q('coordByLgaPledges', [state]));
      return [...rows.values()].sort((a, b) => b.volunteers - a.volunteers || String(a.lga).localeCompare(String(b.lga)));
    },
  };
}
