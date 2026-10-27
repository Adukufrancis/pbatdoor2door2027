// Sends the sign-in code to a phone. Picks the first provider that is configured:
//   1. Message Central VerifyNow (MC_CUSTOMER_ID + MC_PASSWORD) — no Sender ID / CAC needed;
//      they send from their own approved senders, by SMS or WhatsApp (MC_FLOW). They create
//      the code themselves, so this provider is "managed": start() + check() instead of send().
//   2. DageSMS (DAGESMS_API_KEY) — Nigerian, pay in Naira, no subscription; can use their shared
//      default Sender ID (no CAC) on the corporate route, which reaches DND numbers.
//   3. Termii  (TERMII_API_KEY + TERMII_SENDER_ID)  — needs your own approved Sender ID
//   4. Twilio  (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN + TWILIO_FROM)
//   5. none    — development: the code is printed to the console (and shown on screen).
//               In production, phone sign-in is switched off until a provider is set.
// Phone numbers arrive in the form +2348031234567.
import { logger } from './logger.js';

export function createSms(env = process.env) {
  const appName = env.APP_NAME || 'PBAT DOOR TO DOOR';
  const text = (code) => `${code} is your ${appName} code. It expires in 10 minutes. Don't share it with anyone.`;

  if (env.MC_CUSTOMER_ID && (env.MC_PASSWORD || env.MC_KEY)) {
    const base = (env.MC_BASE_URL || 'https://cpaas.messagecentral.com').trim().replace(/\/+$/, '');
    const customerId = env.MC_CUSTOMER_ID.trim();
    const key = (env.MC_KEY || Buffer.from(env.MC_PASSWORD).toString('base64')).trim();
    const flow = (env.MC_FLOW || 'SMS').trim().toUpperCase() === 'WHATSAPP' ? 'WHATSAPP' : 'SMS';
    const local = (phone) => phone.replace(/^\+?234/, '');            // 8031234567
    let token = null, tokenAt = 0;

    async function getToken(force = false) {
      if (!force && token && Date.now() - tokenAt < 30 * 60 * 1000) return token;
      const q = new URLSearchParams({ customerId, key, scope: 'NEW', country: '234' });
      if (env.MC_EMAIL) q.set('email', env.MC_EMAIL);
      const res = await fetch(`${base}/auth/v1/authentication/token?${q}`, { headers: { accept: '*/*' }, signal: AbortSignal.timeout(15000) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.token) throw new Error(`Message Central login failed (${res.status}): ${JSON.stringify(j).slice(0, 200)}`);
      token = j.token; tokenAt = Date.now();
      return token;
    }
    async function call(method, path, params) {
      for (let attempt = 0; attempt < 2; attempt++) {
        const res = await fetch(`${base}${path}?${new URLSearchParams(params)}`, {
          method, headers: { accept: '*/*', authToken: await getToken(attempt > 0) }, signal: AbortSignal.timeout(15000),
        });
        if (res.status === 401 && attempt === 0) continue;               // token expired: get a new one and retry
        const j = await res.json().catch(() => ({}));
        return { status: res.status, j };
      }
    }
    const codeOf = (j) => Number(j?.responseCode ?? j?.data?.responseCode);

    return {
      provider: `messagecentral-${flow.toLowerCase()}`,
      via: flow === 'WHATSAPP' ? 'whatsapp' : 'sms',
      managed: true,
      /** Ask Message Central to send a 6-digit code. Returns their verification id. */
      async start(phone) {
        const { status, j } = await call('POST', '/verification/v3/send',
          { countryCode: '234', customerId, flowType: flow, mobileNumber: local(phone), otpLength: '6' });
        const id = j?.data?.verificationId;
        if (status >= 400 || codeOf(j) !== 200 || !id) throw new Error(`Message Central send failed (${status}): ${JSON.stringify(j).slice(0, 300)}`);
        return String(id);
      },
      /** Returns 'ok', 'wrong' or 'expired'. Throws if Message Central can't be reached. */
      async check(phone, verificationId, code) {
        const { status, j } = await call('GET', '/verification/v3/validateOtp',
          { countryCode: '234', mobileNumber: local(phone), verificationId, customerId, code, flowType: flow });
        const rc = codeOf(j), st = j?.data?.verificationStatus;
        if (st === 'VERIFICATION_COMPLETED' || (rc === 200 && status < 400)) return 'ok';
        if (rc === 702 || rc === 700) return 'wrong';
        if (rc === 705 || rc === 703 || rc === 800 || rc === 505) return 'expired';
        throw new Error(`Message Central check failed (${status}): ${JSON.stringify(j).slice(0, 300)}`);
      },
    };
  }

  if (env.DAGESMS_API_KEY) {
    const base = (env.DAGESMS_BASE_URL || 'https://api.dagesms.com').trim().replace(/\/+$/, '');
    return {
      provider: 'dagesms',
      async send(phone, code) {
        const res = await fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.DAGESMS_API_KEY.trim()}`, 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            to: phone,                                         // +2348031234567
            from: (env.DAGESMS_SENDER || 'DageSMS').trim(),    // their shared sender, or your own approved one
            body: text(code),
            route: env.DAGESMS_ROUTE || 'corporate',           // corporate = transactional route, reaches DND numbers
          }),
          signal: AbortSignal.timeout(15000),
        });
        const raw = await res.text().catch(() => '');
        let j = {}; try { j = JSON.parse(raw); } catch {}
        if (!res.ok || /fail|error|reject/i.test(String(j.status || ''))) throw new Error(`DageSMS ${res.status}: ${raw}`.slice(0, 400));
      },
    };
  }

  if (env.TERMII_API_KEY && env.TERMII_SENDER_ID) {
    // Each Termii account has its own base URL (shown on the Termii dashboard), e.g. https://v3.api.termii.com
    let base = (env.TERMII_BASE_URL || 'https://api.ng.termii.com').trim().replace(/\/+$/, '').replace(/\/api$/, '');
    if (!/^https?:\/\//.test(base)) base = `https://${base}`;
    return {
      provider: 'termii',
      async send(phone, code) {
        const res = await fetch(`${base}/api/sms/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            api_key: env.TERMII_API_KEY,
            to: phone.replace(/^\+/, ''),          // Termii wants 2348031234567
            from: env.TERMII_SENDER_ID,
            sms: text(code),
            type: 'plain',
            channel: env.TERMII_CHANNEL || 'dnd',  // 'dnd' reaches numbers on Do-Not-Disturb
          }),
          signal: AbortSignal.timeout(15000),
        });
        const body = await res.text().catch(() => '');
        if (!res.ok) throw new Error(`Termii ${res.status}: ${body}`.slice(0, 400));
        // Termii sometimes answers 200 with an error message instead of a message_id
        if (!/message_id|Successfully/i.test(body)) throw new Error(`Termii: ${body}`.slice(0, 400));
      },
    };
  }

  if (env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM) {
    return {
      provider: 'twilio',
      async send(phone, code) {
        const form = new URLSearchParams({ To: phone, Body: text(code) });
        if (env.TWILIO_FROM.startsWith('MG')) form.set('MessagingServiceSid', env.TWILIO_FROM);
        else form.set('From', env.TWILIO_FROM);
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`, {
          method: 'POST',
          headers: {
            Authorization: 'Basic ' + Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: form,
          signal: AbortSignal.timeout(15000),
        });
        const body = await res.text().catch(() => '');
        if (!res.ok) throw new Error(`Twilio ${res.status}: ${body}`.slice(0, 400));
      },
    };
  }

  return {
    provider: null,
    send: async (phone, code) => logger.info({ phone, code }, '[dev] SMS code (no SMS provider configured)'),
  };
}
