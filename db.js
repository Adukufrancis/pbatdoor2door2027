// Postgres connection pool and the SQL migration runner.
//
// Connection settings: DATABASE_URL, or the standard PGHOST / PGPORT / PGUSER / PGPASSWORD /
// PGDATABASE variables (docker-compose uses these so the password never has to be URL-encoded).
// DATABASE_SSL: "disable" (default, e.g. the compose `db` service on the private network),
// "require" (encrypt, don't verify the certificate) or "verify" (encrypt and verify).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { logger } from './logger.js';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
// Arbitrary constant: only one process at a time may run migrations.
const MIGRATION_LOCK_ID = 727_2027;

function sslOption(mode = process.env.DATABASE_SSL) {
  switch ((mode || 'disable').toLowerCase()) {
    case 'disable': case 'off': case 'false': return false;
    case 'require': return { rejectUnauthorized: false };
    case 'verify': case 'verify-full': return { rejectUnauthorized: true };
    default: throw new Error(`DATABASE_SSL must be disable, require or verify (got "${mode}")`);
  }
}

export function createPool(env = process.env) {
  const pool = new pg.Pool({
    ...(env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {}),
    ssl: sslOption(env.DATABASE_SSL),
    max: Number(env.DATABASE_POOL_MAX || 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: Number(env.DATABASE_STATEMENT_TIMEOUT_MS || 15_000),
    application_name: 'pbat-app',
  });
  // An idle client losing its connection (e.g. Postgres restarting) must not crash the process.
  pool.on('error', (err) => logger.error({ err }, 'postgres idle client error'));
  return pool;
}

/** Waits for Postgres to accept connections (it may still be starting when the app boots). */
export async function waitForDatabase(pool, { attempts = 30, delayMs = 2000 } = {}) {
  for (let i = 1; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      logger.warn({ attempt: i, err: err.message }, 'database not ready, retrying');
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

export function listMigrations(dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .filter((f) => /^\d+_.+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = fs.readFileSync(path.join(dir, file), 'utf8');
      return { version: file.replace(/\.sql$/, ''), sql, checksum: crypto.createHash('sha256').update(sql).digest('hex') };
    });
}

/** Applies every migration in migrations/ that hasn't run yet, each in its own transaction. */
export async function migrate(pool, dir = MIGRATIONS_DIR) {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const done = new Map((await client.query('SELECT version, checksum FROM schema_migrations')).rows
      .map((r) => [r.version, r.checksum]));
    const applied = [];
    for (const m of listMigrations(dir)) {
      if (done.has(m.version)) {
        if (done.get(m.version) !== m.checksum) {
          logger.warn({ version: m.version }, 'migration file changed after it was applied; add a new migration instead');
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(m.sql);
        await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [m.version, m.checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${m.version} failed: ${err.message}`);
      }
      applied.push(m.version);
      logger.info({ version: m.version }, 'migration applied');
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}
