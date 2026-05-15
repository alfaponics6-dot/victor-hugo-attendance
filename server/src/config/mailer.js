// Microsoft Graph mailer (replaces nodemailer SMTP). Outlook.com / M365
// SMTP is being deprecated tenant-side, so we send via the Graph API
// using a delegated refresh token instead.
//
// Setup is one-time and operator-driven:
//   1. Register an app at portal.azure.com → App registrations.
//      - Personal Microsoft accounts only.
//      - "Allow public client flows" = Yes.
//      - Delegated permission: Mail.Send + offline_access.
//   2. Run `MS_GRAPH_CLIENT_ID=<client-id> node scripts/setup-ms-graph.js`
//      and follow the device-code prompt to authorize.
//   3. Add the printed MS_GRAPH_REFRESH_TOKEN to .env and restart the API.
//
// Required env:
//   MS_GRAPH_CLIENT_ID       Azure app registration's Application (client) ID
//   MS_GRAPH_REFRESH_TOKEN   Long-lived refresh token from setup script
//
// Optional env:
//   MS_GRAPH_TENANT          'consumers' (default for outlook.com) | 'common' | tenant id
//   MS_GRAPH_CLIENT_SECRET   Only for confidential-client app regs
//
// Microsoft rotates refresh tokens on each use. We persist the latest
// one to server/ms-graph-token.json (gitignored) so it survives
// restarts without rewriting .env.

const path = require('path');
const fs = require('fs');

const TOKEN_FILE = path.join(__dirname, '..', '..', 'ms-graph-token.json');
const TENANT = process.env.MS_GRAPH_TENANT || 'consumers';
const CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID;
const CLIENT_SECRET = process.env.MS_GRAPH_CLIENT_SECRET; // optional
const SCOPES = 'https://graph.microsoft.com/Mail.Send offline_access';

function loadInitialRefreshToken() {
  // File takes precedence if newer than env — file gets updated whenever
  // Microsoft rotates the refresh token in a successful exchange.
  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
      if (data?.refreshToken) return data.refreshToken;
    }
  } catch (e) {
    console.error(`ms-graph-token.json unreadable: ${e.message}`);
  }
  return process.env.MS_GRAPH_REFRESH_TOKEN || null;
}

let currentRefreshToken = loadInitialRefreshToken();
let cachedAccessToken = null;
let cachedExpiry = 0;

const configured = !!(CLIENT_ID && currentRefreshToken);

function persistRefreshToken(token) {
  try {
    fs.writeFileSync(
      TOKEN_FILE,
      JSON.stringify({ refreshToken: token, updatedAt: new Date().toISOString() }, null, 2),
      { mode: 0o600 },
    );
  } catch (e) {
    console.error('Failed to persist MS Graph refresh token:', e.message);
  }
}

async function getAccessToken() {
  if (cachedAccessToken && Date.now() < cachedExpiry - 60_000) {
    return cachedAccessToken;
  }
  if (!currentRefreshToken) throw new Error('No refresh token — run setup-ms-graph.js');

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    refresh_token: currentRefreshToken,
    grant_type: 'refresh_token',
    scope: SCOPES,
  });
  if (CLIENT_SECRET) params.set('client_secret', CLIENT_SECRET);

  const res = await fetch(`https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Token refresh failed: ${res.status} ${errText.slice(0, 300)}`);
  }
  const data = await res.json();
  cachedAccessToken = data.access_token;
  cachedExpiry = Date.now() + data.expires_in * 1000;
  // Microsoft typically rotates the refresh token; capture the new one
  // so subsequent calls (and the next restart) use the fresh value.
  if (data.refresh_token && data.refresh_token !== currentRefreshToken) {
    currentRefreshToken = data.refresh_token;
    persistRefreshToken(currentRefreshToken);
  }
  return cachedAccessToken;
}

async function sendMail({ to, subject, html, text }) {
  if (!configured) return { skipped: true, reason: 'MS Graph not configured' };
  if (!to) return { skipped: true, reason: 'No recipient' };
  try {
    const token = await getAccessToken();
    const message = {
      subject: subject || '',
      body: {
        contentType: html ? 'HTML' : 'Text',
        content: html || text || '',
      },
      toRecipients: [{ emailAddress: { address: to } }],
    };
    const res = await fetch('https://graph.microsoft.com/v1.0/me/sendMail', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message, saveToSentItems: false }),
    });
    // sendMail returns 202 Accepted on success, with no body.
    if (res.status === 202) return { sent: true };
    const errText = await res.text().catch(() => '');
    return { sent: false, error: `Graph ${res.status}: ${errText.slice(0, 300)}` };
  } catch (err) {
    return { sent: false, error: err.message };
  }
}

module.exports = {
  sendMail,
  isConfigured: () => configured,
};
