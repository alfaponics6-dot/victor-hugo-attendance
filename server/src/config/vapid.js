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
  const generated = webpush.generateVAPIDKeys();
  try {
    fs.writeFileSync(KEYS_PATH, JSON.stringify(generated, null, 2), {
      mode: 0o600,
    });
    console.log(`Generated new VAPID keys at ${KEYS_PATH}`);
  } catch (e) {
    console.error('Could not persist VAPID keys:', e.message);
  }
  return generated;
}

const keys = loadOrGenerate();
webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);

module.exports = {
  publicKey: keys.publicKey,
  webpush,
};
