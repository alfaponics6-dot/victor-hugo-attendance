#!/usr/bin/env node
//
// One-time setup: trade a Microsoft device code for a refresh token that
// lets the server send mail via Microsoft Graph API.
//
// Run on the server (NOT in CI — needs the operator to sign in to a real
// browser):
//
//   MS_GRAPH_CLIENT_ID=<app-client-id> node scripts/setup-ms-graph.js
//
// The script prints a short user code, you go to microsoft.com/devicelogin
// and sign in as the sending account (experienciadetrabajo@outlook.com).
// Once consent is granted, the script prints the refresh token. Add it to
// /opt/victorhugo/server/.env as MS_GRAPH_REFRESH_TOKEN and restart the
// API.
//
// Tenant defaults to "consumers" (for personal outlook.com accounts).
// Override MS_GRAPH_TENANT=common if the app registration supports both
// personal + org accounts.

const CLIENT_ID = process.env.MS_GRAPH_CLIENT_ID;
const TENANT = process.env.MS_GRAPH_TENANT || 'consumers';
const SCOPES = 'https://graph.microsoft.com/Mail.Send offline_access';

if (!CLIENT_ID) {
  console.error('Set MS_GRAPH_CLIENT_ID env var to the Azure app registration client ID');
  process.exit(1);
}

const AUTH_BASE = `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0`;

async function postForm(url, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function main() {
  console.log(`Requesting device code (tenant=${TENANT})...`);
  const init = await postForm(`${AUTH_BASE}/devicecode`, {
    client_id: CLIENT_ID,
    scope: SCOPES,
  });
  if (init.status !== 200) {
    console.error('Device code request failed:', JSON.stringify(init.data, null, 2));
    process.exit(1);
  }
  const { device_code, user_code, verification_uri, expires_in, interval } = init.data;
  console.log('');
  console.log('=== Sign in to authorize the app ===');
  console.log(`URL:  ${verification_uri}`);
  console.log(`Code: ${user_code}`);
  console.log(`(Expires in ${expires_in}s — poll every ${interval}s)`);
  console.log('');

  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, (interval + 1) * 1000));
    const poll = await postForm(`${AUTH_BASE}/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: CLIENT_ID,
      device_code,
    });
    if (poll.status === 200 && poll.data.refresh_token) {
      console.log('=== SUCCESS — refresh token below ===');
      console.log('');
      console.log(`MS_GRAPH_REFRESH_TOKEN=${poll.data.refresh_token}`);
      console.log('');
      console.log('Add that line to /opt/victorhugo/server/.env (alongside MS_GRAPH_CLIENT_ID)');
      console.log('and restart the API: sudo systemctl restart victorhugo-api');
      return;
    }
    const err = poll.data?.error;
    if (err === 'authorization_pending' || err === 'slow_down') continue;
    console.error('Token poll failed:', JSON.stringify(poll.data, null, 2));
    process.exit(1);
  }
  console.error('Device code expired before sign-in completed. Re-run the script.');
  process.exit(1);
}

main().catch((e) => {
  console.error('Setup failed:', e);
  process.exit(1);
});
