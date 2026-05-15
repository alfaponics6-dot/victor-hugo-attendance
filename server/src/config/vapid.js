const path = require('path');
const fs = require('fs');
const webpush = require('web-push');

// VAPID keys identify our server to the browser push services. The public
// key is shared with clients (they include it in their push subscription);
// the private key signs each push payload server-side. We persist them to
// a JSON file under server/ so they survive restarts but stay out of git
// (the file is .gitignored).
const KEYS_PATH = path.join(__dirname, '..', '..', 'vapid-keys.json');
const SUBJECT =
  process.env.VAPID_SUBJECT || 'mailto:cchery@earth.ac.cr';

function loadOrGenerate() {
  // Env vars take precedence — if the operator wants to manage keys
  // outside the file (vault, secrets manager), they can.
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
  }
  if (fs.existsSync(KEYS_PATH)) {
    try {
      const data = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf8'));
      if (data?.publicKey && data?.privateKey) return data;
    } catch (e) {
      console.error('vapid-keys.json unreadable, regenerating:', e.message);
    }
  }
  // SHOUTY warning so the operator can't miss this in the boot logs. New
  // VAPID keys mean every existing push_subscription row is now bound to
  // the OLD public key — webpush calls will start failing with 410/Gone
  // and the cron will silently delete those subscriptions. Recovery
  // requires every leader to revisit the app and re-grant notification
  // permission (which only re-prompts if they hadn't decided yet).
  console.warn('');
  console.warn('================================================================');
  console.warn('[vapid] No VAPID keys found — GENERATING NEW ONES.');
  console.warn('[vapid] Every existing push_subscriptions row is now invalid;');
  console.warn('[vapid] those leaders must reopen the app and re-grant');
  console.warn('[vapid] notifications. If you intended to restore an existing');
  console.warn('[vapid] vapid-keys.json (e.g., from a backup), STOP THE SERVER');
  console.warn('[vapid] now and put the file back at ' + KEYS_PATH);
  console.warn('================================================================');
  console.warn('');
  const generated = webpush.generateVAPIDKeys();
  try {
    fs.writeFileSync(KEYS_PATH, JSON.stringify(generated, null, 2), {
      mode: 0o600,
    });
    console.log(`Generated new VAPID keys at ${KEYS_PATH}`);
  } catch (e) {
    // If we can't persist, fall back to in-memory keys for this boot — but
    // SHOUT about it so the operator knows: on the next restart, NEW keys
    // will be generated again, and every push subscription dies in a loop.
    console.error('[vapid] CRITICAL: cannot write vapid-keys.json:', e.message);
    console.error('[vapid] Push subscriptions will reset on every restart.');
    console.error('[vapid] Fix filesystem permissions or set VAPID_*_KEY env vars.');
  }
  return generated;
}

const keys = loadOrGenerate();
webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);

module.exports = {
  publicKey: keys.publicKey,
  webpush,
};
