// Phone codes through Google Firebase, shared by the login and account pages.
// usage: const fb = firebasePhone(opts.firebase, containerEl);
//        await fb.send('0803…')      -> throws with .message on failure
//        const idToken = await fb.confirm('123456')
export const toE164 = (v) => { const d = String(v).replace(/[^\d]/g, ''); return d.startsWith('234') ? `+${d}` : `+234${d.replace(/^0/, '')}`; };

export function fbMessage(e) {
  const msg = {
    'auth/invalid-phone-number': "That phone number doesn't look right. Check it and try again.",
    'auth/too-many-requests': 'Too many attempts from this device. Please wait a while and try again.',
    'auth/quota-exceeded': 'Phone codes are busy right now. Please try again later.',
    'auth/captcha-check-failed': 'The security check failed. Please reload the page and try again.',
    'auth/invalid-app-credential': 'The security check failed. Please reload the page and try again.',
    'auth/unauthorized-domain': "Phone codes aren't switched on for this website yet.",
    'auth/network-request-failed': 'Your browser blocked the request to Google. Try Chrome, or turn off content blockers.',
    'auth/billing-not-enabled': 'Phone codes need billing switched on in Firebase.',
    'auth/operation-not-allowed': "Phone codes aren't switched on in Firebase yet.",
    'auth/invalid-verification-code': 'Incorrect code. Check the text message and try again.',
    'auth/code-expired': 'That code has expired. Request a new one.',
    'auth/session-expired': 'That code has expired. Request a new one.',
  }[e?.code] || "We couldn't send the text message. Please try again.";
  return `${msg} [${e?.code || e?.message || 'unknown'}]`;
}

export function firebasePhone(cfg, container) {
  let fb = null, verifier = null, confirmation = null;
  async function load() {
    if (fb) return fb;
    const [{ initializeApp, getApps }, auth] = await Promise.all([import(`${cfg.sdk}/firebase-app.js`), import(`${cfg.sdk}/firebase-auth.js`)]);
    const app = getApps()[0] || initializeApp({ apiKey: cfg.apiKey, authDomain: cfg.authDomain, projectId: cfg.projectId });
    fb = { ...auth, auth: auth.getAuth(app) };
    fb.auth.languageCode = 'en';
    return fb;
  }
  return {
    async send(phone) {
      const f = await load();
      if (!verifier) {
        const box = document.createElement('div');          // reCAPTCHA can't render twice into one element
        container.replaceChildren(box);
        verifier = new f.RecaptchaVerifier(f.auth, box, { size: 'invisible' });
      }
      try {
        confirmation = await f.signInWithPhoneNumber(f.auth, toE164(phone), verifier);
      } catch (err) {
        try { verifier.clear(); } catch {}
        verifier = null;
        throw Object.assign(new Error(fbMessage(err)), { code: err?.code });
      }
    },
    async confirm(code) {
      try {
        const cred = await confirmation.confirm(code);
        const idToken = await cred.user.getIdToken();
        try { await fb.signOut(fb.auth); } catch {}           // our own session takes over
        return idToken;
      } catch (err) {
        throw Object.assign(new Error(fbMessage(err)), { code: err?.code });
      }
    },
  };
}
