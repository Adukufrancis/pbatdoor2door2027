// Data layer (Postgres). Schema lives in migrations/*.sql.
//
// Members sign in with an email OR a phone number. A contact is "verified" once the
// person has entered a code sent to it; only verified contacts can be used to log in,
// and each verified email/phone belongs to at most one member.

// Profile questions asked after the first login (all stored as text).
export const PROFILE_FIELDS = [
  'full_name', 'gender', 'date_of_birth', 'state', 'lga', 'ward',
  'polling_unit', 'address', 'occupation', 'interests',
];

const MEMBER_COLS = `id, email, email_verified, phone, phone_verified, ${PROFILE_FIELDS.join(', ')}, consent_at, join_consent_at, sms_consent_at, created_at`;

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
  memberByIdForUpdate: `SELECT ${MEMBER_COLS} FROM members WHERE id = $1 FOR UPDATE`,
  // When someone proves they own a contact, remove it from any account that only typed it in.
  releaseUnverifiedEmail: 'UPDATE members SET email = NULL WHERE email = $1 AND email_verified = 0',
  releaseUnverifiedPhone: 'UPDATE members SET phone = NULL WHERE phone = $1 AND phone_verified = 0',
  insertByEmail: `INSERT INTO members (email, email_verified, created_at) VALUES ($1, 1, $2) RETURNING ${MEMBER_COLS}`,
  insertByPhone: `INSERT INTO members (phone, phone_verified, created_at) VALUES ($1, 1, $2) RETURNING ${MEMBER_COLS}`,
  setEmail: 'UPDATE members SET email = $2, email_verified = 0 WHERE id = $1 AND email_verified = 0',
  setPhone: 'UPDATE members SET phone = $2, phone_verified = 0 WHERE id = $1 AND phone_verified = 0',
  linkEmail: 'UPDATE members SET email = $2, email_verified = 1 WHERE id = $1',
  linkPhone: 'UPDATE members SET phone = $2, phone_verified = 1 WHERE id = $1',
  moveSessions: 'UPDATE member_sessions SET member_id = $2 WHERE member_id = $1',
  deleteMember: 'DELETE FROM members WHERE id = $1',
  mergeInto: `UPDATE members SET email = $2, email_verified = $3, phone = $4, phone_verified = $5,
                ${PROFILE_FIELDS.map((f, i) => `${f} = $${i + 6}`).join(', ')},
                consent_at = $${PROFILE_FIELDS.length + 6},
                join_consent_at = $${PROFILE_FIELDS.length + 7},
                sms_consent_at = $${PROFILE_FIELDS.length + 8},
                created_at = $${PROFILE_FIELDS.length + 9} WHERE id = $1`,
  updateProfile: `UPDATE members SET ${PROFILE_FIELDS.map((f, i) => `${f} = $${i + 2}`).join(', ')},
                    consent_at = COALESCE(consent_at, $${PROFILE_FIELDS.length + 2}) WHERE id = $1`,
  recordConsent: `UPDATE members SET join_consent_at = COALESCE(join_consent_at, $2),
                    sms_consent_at = CASE WHEN $3 = 1 THEN COALESCE(sms_consent_at, $2) ELSE sms_consent_at END
                    WHERE id = $1`,

  insertSession: `INSERT INTO member_sessions (token_hash, member_id, created_at, last_seen, user_agent)
                  VALUES ($1, $2, $3, $4, $5)`,
  getSession: 'SELECT token_hash, member_id, last_seen FROM member_sessions WHERE token_hash = $1',
  touchSession: 'UPDATE member_sessions SET last_seen = $1 WHERE token_hash = $2',
  listSessions: `SELECT token_hash, created_at, last_seen, user_agent FROM member_sessions
                  WHERE member_id = $1 ORDER BY last_seen DESC`,
  deleteSession: 'DELETE FROM member_sessions WHERE token_hash = $1',
  deleteMemberSessions: 'DELETE FROM member_sessions WHERE member_id = $1',

  // Serialises concurrent requests for the same bucket so the count can't be overshot.
  lockBucket: 'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
  countHits: 'SELECT count(*)::int AS n FROM rate_limit_hits WHERE bucket = $1 AND hit_at > $2',
  insertHit: 'INSERT INTO rate_limit_hits (bucket, hit_at) VALUES ($1, $2)',
  purgeHits: 'DELETE FROM rate_limit_hits WHERE hit_at < $1',
};

// BIGINT comes back from pg as a string; turn numeric columns back into numbers.
const NUMERIC = new Set(['id', 'member_id', 'created_at', 'expires_at', 'sent_at', 'last_seen', 'attempts',
  'consent_at', 'join_consent_at', 'sms_consent_at', 'email_verified', 'phone_verified']);
const fixRow = (r) => {
  for (const k of Object.keys(r)) if (NUMERIC.has(k) && r[k] != null) r[k] = Number(r[k]);
  return r;
};

export function createStore(pool) {
  const q = async (name, params = [], db = pool) => (await db.query(QUERIES[name], params)).rows.map(fixRow);
  const one = async (name, params, db) => (await q(name, params, db))[0];
  const byVerified = (type, value, db) =>
    one(type === 'email' ? 'memberByVerifiedEmail' : 'memberByVerifiedPhone', [value], db);

  async function tx(fn) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn(client);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    ping: () => pool.query('SELECT 1'),

    getCode: (id) => one('getCode', [id]),
    upsertCode: (id, channel, hash, expiresAt, sentAt) => q('upsertCode', [id, channel, hash, expiresAt, sentAt]),
    bumpAttempts: (id) => q('bumpAttempts', [id]),
    deleteCode: (id) => q('deleteCode', [id]),
    purgeCodes: (now) => q('purgeCodes', [now]),

    memberById: (id) => one('memberById', [id]),
    memberByVerified: (type, value) => byVerified(type, value),

    /**
     * Sliding-window limiter: records a hit and returns true if `bucket` has had fewer than
     * `limit` hits in the last `windowMs`; otherwise returns false without recording one.
     */
    hit: (bucket, limit, windowMs, now = Date.now()) => tx(async (c) => {
      await c.query(QUERIES.lockBucket, [bucket]);
      const { n } = await one('countHits', [bucket, now - windowMs], c);
      if (n >= limit) return false;
      await q('insertHit', [bucket, now], c);
      return true;
    }),
    purgeHits: (before) => q('purgeHits', [before]),

    /** The person proved they own this email/phone: return their member, creating one if new. */
    async signInWith(type, value, now) {
      const existing = await byVerified(type, value);
      if (existing) return { member: existing, isNew: false };
      try {
        const member = await tx(async (c) => {
          await q(type === 'email' ? 'releaseUnverifiedEmail' : 'releaseUnverifiedPhone', [value], c);
          return one(type === 'email' ? 'insertByEmail' : 'insertByPhone', [value, now], c);
        });
        return { member, isNew: true };
      } catch (err) {
        // Two sign-ins racing for the same new contact: the other one won, use it.
        if (err.code !== '23505') throw err;
        const winner = await byVerified(type, value);
        if (winner) return { member: winner, isNew: false };
        throw err;
      }
    },

    /** Store a contact the member typed in (not verified yet). Returns false if someone else has it verified. */
    async setContact(memberId, type, value) {
      if (value != null) {
        const owner = await byVerified(type, value);
        if (owner && owner.id !== memberId) return false;
        if (owner && owner.id === memberId) return true;
      }
      await q(type === 'email' ? 'setEmail' : 'setPhone', [memberId, value]);
      return true;
    },

    /**
     * The member proved they own this email/phone. Attach it to their account; if another account
     * already signs in with it, merge the two (the older account is kept, sessions move with it).
     * Runs in one transaction so a failure part-way can't lose either account.
     */
    linkContact: (memberId, type, value) => tx(async (c) => {
      const owner = await byVerified(type, value, c);
      if (owner && owner.id === memberId) return { memberId, merged: false };
      if (!owner) {
        await q(type === 'email' ? 'releaseUnverifiedEmail' : 'releaseUnverifiedPhone', [value], c);
        await q(type === 'email' ? 'linkEmail' : 'linkPhone', [memberId, value], c);
        return { memberId, merged: false };
      }
      // Lock both rows in id order so two merges of the same pair can't deadlock.
      const [lo, hi] = [owner.id, memberId].sort((a, b) => a - b);
      const first = await one('memberByIdForUpdate', [lo], c);
      const second = await one('memberByIdForUpdate', [hi], c);
      if (!first || !second) return { conflict: true };
      const [keep, drop] = [first, second];          // the older (lower id) account is kept
      const pick = (t) => {
        const a = keep[`${t}_verified`] ? keep[t] : null, b = drop[`${t}_verified`] ? drop[t] : null;
        if (a && b && a !== b) return null;                      // two different verified contacts: can't merge
        return a || b ? [a || b, 1] : [keep[t] || drop[t] || null, 0];
      };
      const email = pick('email'), phone = pick('phone');
      if (!email || !phone) return { conflict: true };
      const consents = [keep.consent_at, drop.consent_at].filter((x) => x != null);
      const joinConsents = [keep.join_consent_at, drop.join_consent_at].filter((x) => x != null);
      const smsConsents = [keep.sms_consent_at, drop.sms_consent_at].filter((x) => x != null);
      await q('moveSessions', [drop.id, keep.id], c);
      await q('deleteMember', [drop.id], c);                    // frees its verified contacts for the keeper
      await q('mergeInto', [keep.id, email[0], email[1], phone[0], phone[1],
        ...PROFILE_FIELDS.map((f) => keep[f] || drop[f] || ''),
        consents.length ? Math.min(...consents) : null,
        joinConsents.length ? Math.min(...joinConsents) : null,
        smsConsents.length ? Math.min(...smsConsents) : null,
        Math.min(keep.created_at, drop.created_at)], c);
      return { memberId: keep.id, merged: true };
    }),

    recordConsent: (id, now, sms) => q('recordConsent', [id, now, sms ? 1 : 0]),

    updateProfile: (id, profile, now) =>
      q('updateProfile', [id, ...PROFILE_FIELDS.map((f) => profile[f] ?? ''), now]),

    insertSession: (hash, memberId, now, ua) => q('insertSession', [hash, memberId, now, now, ua]),
    getSession: (hash) => one('getSession', [hash]),
    touchSession: (hash, now) => q('touchSession', [now, hash]),
    listSessions: (memberId) => q('listSessions', [memberId]),
    deleteSession: (hash) => q('deleteSession', [hash]),
    deleteMemberSessions: (memberId) => q('deleteMemberSessions', [memberId]),
  };
}
