// PBAT DOOR TO DOOR: who publishes this website.
// ➜ Edit the text INSIDE the quotes. It is used in the footer, the Privacy Policy, the Terms and the Contact page.
//   Anything still in [square brackets] is a placeholder that must be replaced before launch.
export const SITE = {
  name: 'PBAT Door to Door Movement',              // the organisation's official name
  address: '65 Parakou Street, Abuja, FCT, Nigeria', // physical address for the "Published by" line
  email: 'info@pbatdoor2door2027.org',              // contact email (ideally on your own domain)
  privacyEmail: 'privacy@pbatdoor2door2027.org',    // where people send data requests (can be the same as email)
  phone: '',                                        // optional public phone / volunteer hotline, e.g. '0800 000 0000'
  domain: 'https://pbatdoor2door2027.org',
  policyDate: '28 October 2026',                    // date the Privacy Policy and Terms were last updated
};

/** Fill every element marked data-site="key" (text) or data-site-mail="key" (mailto link). */
export function fillSite(root = document) {
  root.querySelectorAll('[data-site]').forEach((el) => { el.textContent = SITE[el.dataset.site] || ''; });
  root.querySelectorAll('[data-site-mail]').forEach((a) => {
    const v = SITE[a.dataset.siteMail]; a.href = `mailto:${v}`; if (!a.textContent.trim()) a.textContent = v;
  });
  root.querySelectorAll('[data-site-if]').forEach((el) => { el.hidden = !SITE[el.dataset.siteIf]; });
}
