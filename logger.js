// Structured JSON logs on stdout (read them with `docker compose logs app`).
import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { app: 'pbat' },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label }) },
  redact: {
    paths: ['req.headers.cookie', 'res.headers["set-cookie"]', 'req.headers.authorization'],
    censor: '[redacted]',
  },
});
