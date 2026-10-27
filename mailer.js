// Sends the sign-in code. Picks the first provider that is configured:
//   1. Brevo HTTP API     (BREVO_API_KEY)      — recommended; HTTPS, so it works where SMTP is blocked (Linode)
//   2. Zoho ZeptoMail API (ZEPTOMAIL_TOKEN)    — HTTPS; pairs well with a domain already on Zoho Mail
//   3. Resend HTTP API    (RESEND_API_KEY)     — HTTPS, needs a verified domain
//   4. Gmail via Google Apps Script (GMAIL_SCRIPT_URL + GMAIL_SCRIPT_SECRET) — free, ~100/day, see apps-script/Code.gs
//   5. SMTP               (SMTP_HOST)          — outbound SMTP is blocked on new Linode accounts
//   6. none               — development only: the code is written to the log
import nodemailer from 'nodemailer';
import { logger } from './logger.js';

function parseFrom(value) {
  // Accepts "Name <email@x.com>" or "email@x.com"
  const m = String(value || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || undefined, email: m[2].trim() } : { email: String(value || '').trim() };
}

function render(appName, code) {
  return {
    subject: `${code} is your ${appName} sign-in code`,
    text: `Your ${appName} sign-in code is ${code}.\n\nIt expires in 10 minutes. If you didn't ask for this, you can ignore this email.`,
    html: `
      <div style="font-family:system-ui,sans-serif;max-width:420px;margin:auto;padding:24px">
        <p style="color:#555">Your ${appName} sign-in code is</p>
        <p style="font-size:34px;letter-spacing:8px;font-weight:700;margin:8px 0 16px">${code}</p>
        <p style="color:#777;font-size:14px">It expires in 10 minutes. If you didn't ask for this, you can ignore this email.</p>
      </div>`,
  };
}

async function postJson(url, headers, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} -> ${res.status} ${await res.text().catch(() => '')}`.slice(0, 500));
}

export function createMailer(env = process.env) {
  const appName = env.APP_NAME || 'PBAT DOOR TO DOOR';
  const from = parseFrom(env.MAIL_FROM || env.SMTP_USER);

  if (env.BREVO_API_KEY) {
    const url = env.BREVO_API_URL || 'https://api.brevo.com/v3/smtp/email';
    return {
      provider: 'brevo',
      send: (to, code) => {
        const m = render(appName, code);
        return postJson(url, { 'api-key': env.BREVO_API_KEY.trim() }, {
          sender: { email: from.email, name: from.name || appName },
          to: [{ email: to }],
          subject: m.subject, textContent: m.text, htmlContent: m.html,
        });
      },
    };
  }

  if (env.ZEPTOMAIL_TOKEN) {
    // EU-hosted Zoho accounts use https://api.zeptomail.eu/v1.1/email
    const url = env.ZEPTOMAIL_API_URL || 'https://api.zeptomail.com/v1.1/email';
    const token = env.ZEPTOMAIL_TOKEN.trim().replace(/^Zoho-enczapikey\s+/i, '');
    return {
      provider: 'zeptomail',
      send: (to, code) => {
        const m = render(appName, code);
        return postJson(url, { Authorization: `Zoho-enczapikey ${token}` }, {
          from: { address: from.email, name: from.name || appName },
          to: [{ email_address: { address: to } }],
          subject: m.subject, textbody: m.text, htmlbody: m.html,
        });
      },
    };
  }

  if (env.RESEND_API_KEY) {
    const url = env.RESEND_API_URL || 'https://api.resend.com/emails';
    return {
      provider: 'resend',
      send: (to, code) => {
        const m = render(appName, code);
        return postJson(url, { Authorization: `Bearer ${env.RESEND_API_KEY.trim()}` }, {
          from: from.name ? `${from.name} <${from.email}>` : from.email,
          to: [to], subject: m.subject, text: m.text, html: m.html,
        });
      },
    };
  }

  if (env.GMAIL_SCRIPT_URL) {
    return {
      provider: 'gmail-script',
      send: async (to, code) => {
        const m = render(appName, code);
        const res = await fetch(env.GMAIL_SCRIPT_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ secret: env.GMAIL_SCRIPT_SECRET, to, subject: m.subject, text: m.text, html: m.html, fromName: from.name || appName }),
          redirect: 'follow',
          signal: AbortSignal.timeout(20000),
        });
        let out = {};
        try { out = await res.json(); } catch {}
        if (!res.ok || !out.ok) throw new Error(`Gmail script failed: ${res.status} ${out.error || ''}`.trim());
      },
    };
  }

  if (env.SMTP_HOST) {
    const port = Number(env.SMTP_PORT || 587);
    const t = nodemailer.createTransport({
      host: env.SMTP_HOST, port, secure: port === 465,
      auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
      connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 20000,
    });
    return {
      provider: 'smtp',
      send: (to, code) => {
        const m = render(appName, code);
        return t.sendMail({ from: env.MAIL_FROM || env.SMTP_USER, to, ...m });
      },
    };
  }

  return {
    provider: null,
    send: async (to, code) => logger.info({ to, code }, '[dev] login code (no email provider configured)'),
  };
}
