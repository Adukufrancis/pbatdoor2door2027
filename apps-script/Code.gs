/**
 * PBAT DOOR TO DOOR: free email sender using your own Gmail.
 *
 * Setup (once):
 *  1. Go to https://script.google.com, signed in with the Gmail you want codes sent from, and click New project.
 *  2. Delete what's there, paste this whole file, and change SECRET below to a long random password.
 *  3. Click Deploy > New deployment > type: Web app.
 *       Execute as: Me      Who has access: Anyone
 *     Click Deploy, allow the permissions, and copy the Web app URL.
 *  4. In the server's .env, set GMAIL_SCRIPT_URL = that URL and GMAIL_SCRIPT_SECRET = the same SECRET.
 *
 * Limit: Google allows a personal Gmail account about 100 recipients per day.
 */
const SECRET = 'CHANGE-ME-to-a-long-random-password';

function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    if (data.secret !== SECRET) return reply({ ok: false, error: 'unauthorized' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.to || '')) return reply({ ok: false, error: 'bad recipient' });
    MailApp.sendEmail({
      to: data.to,
      subject: String(data.subject).slice(0, 200),
      body: String(data.text || ''),
      htmlBody: String(data.html || ''),
      name: String(data.fromName || 'PBAT DOOR TO DOOR').slice(0, 80),
    });
    return reply({ ok: true, remaining: MailApp.getRemainingDailyQuota() });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
