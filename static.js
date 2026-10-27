// Static files.
//
// The Docker build pre-compresses the large text assets (scripts/precompress.js writes
// <file>.br and <file>.gz next to each one), so the 8.7 MB of polling-unit JSON is compressed
// once at build time with maximum Brotli settings instead of on every request.
//
// Caching: page HTML/JS/CSS are not fingerprinted, so browsers revalidate them (cheap 304s via
// ETag) and always pick up a new deploy. Polling-unit data and images change rarely: 7 days.
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

const TYPES = { '.json': 'application/json; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const LONG = 'public, max-age=604800, stale-while-revalidate=86400';
const REVALIDATE = 'no-cache';

function cacheControlFor(urlPath) {
  if (urlPath.startsWith('/geo/') || urlPath.startsWith('/images/') || /\.(ico|png|jpe?g|webp|svg)$/.test(urlPath)) return LONG;
  return REVALIDATE;
}

/** Serves <file>.br / <file>.gz when the browser accepts it and the build produced one. */
function precompressed(root) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const ext = path.extname(req.path);
    if (!TYPES[ext]) return next();
    let file;
    try { file = path.join(root, decodeURIComponent(req.path)); } catch { return next(); }
    if (!file.startsWith(root + path.sep) || file.includes('\0')) return next();
    const accept = String(req.get('accept-encoding') || '');
    for (const [enc, suffix] of [['br', '.br'], ['gzip', '.gz']]) {
      if (!new RegExp(`\\b${enc}\\b`).test(accept)) continue;
      if (!fs.existsSync(file + suffix)) continue;
      res.set({
        'Content-Encoding': enc,
        'Content-Type': TYPES[ext],
        'Cache-Control': cacheControlFor(req.path),
        Vary: 'Accept-Encoding',
      });
      return res.sendFile(file + suffix, { etag: true, lastModified: true, cacheControl: false }, (err) => {
        if (err && !res.headersSent) next(err);
      });
    }
    next();
  };
}

export function staticFiles(publicDir) {
  const root = path.resolve(publicDir);
  const router = express.Router();
  router.use(precompressed(root));
  router.use(express.static(root, {
    extensions: ['html'],
    cacheControl: false,
    setHeaders: (res, filePath) => {
      res.setHeader('Cache-Control', cacheControlFor('/' + path.relative(root, filePath).split(path.sep).join('/')));
    },
  }));
  return router;
}
