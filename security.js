// Security headers (helmet) and the Content-Security-Policy.
//
// The pages use inline <script type="module"> blocks. Rather than allowing all inline script,
// the CSP lists the SHA-256 hash of each inline block, computed from public/*.html at startup,
// so editing a page (e.g. the WORKS list) never needs a CSP change — just a redeploy.
// CSP_MODE: "enforce" (default), "report-only" (log violations in the browser console only) or "off".
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import helmet from 'helmet';

export function inlineScriptHashes(publicDir) {
  const hashes = new Set();
  for (const file of fs.readdirSync(publicDir).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
    for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
      if (m[1].trim()) hashes.add(`'sha256-${crypto.createHash('sha256').update(m[1]).digest('base64')}'`);
    }
  }
  return [...hashes];
}

export function securityHeaders({ publicDir, isProd, firebase, mode = process.env.CSP_MODE || 'enforce' }) {
  const firebaseScript = firebase ? [new URL(firebase.sdk).origin, 'https://www.google.com', 'https://www.gstatic.com', 'https://apis.google.com'] : [];
  const firebaseConnect = firebase ? ['https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com', 'https://www.googleapis.com', 'https://www.google.com'] : [];
  const firebaseFrame = firebase ? ['https://www.google.com', 'https://recaptcha.google.com', `https://${firebase.authDomain}`] : [];

  const directives = {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'", ...inlineScriptHashes(publicDir), ...firebaseScript],
    scriptSrcAttr: ["'none'"],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
    imgSrc: ["'self'", 'data:', 'blob:', 'https://commons.wikimedia.org', 'https://upload.wikimedia.org'],
    connectSrc: ["'self'", ...firebaseConnect],
    frameSrc: firebaseFrame.length ? firebaseFrame : ["'none'"],
    workerSrc: ["'self'"],
    manifestSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
    upgradeInsecureRequests: isProd ? [] : null,
  };

  const mw = helmet({
    contentSecurityPolicy: mode === 'off' ? false : { useDefaults: false, directives, reportOnly: mode === 'report-only' },
    // Firebase's reCAPTCHA may open Google windows; keep them working.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    strictTransportSecurity: isProd ? { maxAge: 31536000, includeSubDomains: false } : false,
  });

  return (req, res, next) => {
    res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()');
    mw(req, res, next);
  };
}
