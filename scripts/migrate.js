// Runs pending migrations and exits: `npm run migrate`
// (in Docker: `docker compose run --rm app node scripts/migrate.js`).
import 'dotenv/config';
import { createPool, waitForDatabase, migrate } from '../db.js';
import { logger } from '../logger.js';

const pool = createPool();
try {
  await waitForDatabase(pool);
  const applied = await migrate(pool);
  logger.info({ applied }, applied.length ? 'migrations complete' : 'database already up to date');
} catch (err) {
  logger.error({ err }, 'migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
