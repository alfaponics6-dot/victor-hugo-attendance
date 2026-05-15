import { getDB } from './offlineQueue';

// Cached-credential offline login. After a successful online login we
// PBKDF2-hash the credential (access code or password) and stash it in
// IndexedDB alongside the leader profile. If the leader later opens the
// app without internet, we re-hash whatever they type and compare —
// match → restore client-side session, no server round-trip needed.
//
// Trade-off: anyone with physical access to the device + the right code
// can offline-auth as the cached user. That's the same risk surface as
// the cached app shell itself (the device is already trusted). To bound
// the exposure we expire cached creds after 24h.
const STORE_AUTH = 'cached_auth';
const TTL_MS = 24 * 60 * 60 * 1000;
// PBKDF2-SHA256 iterations. OWASP 2023 recommendation for SHA-256 is
// 600k; we honor that for new records. Old records store their own
// iteration count so they keep verifying after upgrades. SubtleCrypto
// is hardware-accelerated; 600k on a low-end Android takes ~600ms which
// is acceptable at the once-per-login frequency we use it.
const ITERATIONS = 600_000;

function buf2hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hex2buf(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function hashCredential(credential, salt, iterations = ITERATIONS) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(credential),
    { name: 'PBKDF2' },
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

// Constant-time equality so a timing oracle can't tease out the cached
// hash byte-by-byte. Probably overkill for a local store but cheap.
function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Call after a successful ONLINE login. Stores a hashed credential plus
// the leader profile so a subsequent offline login can restore the
// session without a server round-trip.
export async function cacheCredential({ leaderId, credential, profile }) {
  if (!crypto?.subtle || !leaderId || !credential) return;
  try {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const hashed = await hashCredential(credential, salt, ITERATIONS);
    const db = await getDB();
    await db.put(STORE_AUTH, {
      leaderId: Number(leaderId),
      salt: buf2hex(salt),
      hashed: buf2hex(hashed),
      iterations: ITERATIONS,
      profile,
      createdAt: Date.now(),
      expiresAt: Date.now() + TTL_MS,
    });
  } catch {
    // Best-effort; if IDB or SubtleCrypto fails, offline login just won't
    // be available next time. Better to fail silently than block login.
  }
}

// Returns the cached profile if the credential matches and isn't expired,
// null otherwise. Caller is responsible for restoring the session
// (writing to localStorage, navigating).
export async function tryOfflineLogin({ leaderId, credential }) {
  if (!crypto?.subtle || !leaderId || !credential) return null;
  try {
    const db = await getDB();
    const record = await db.get(STORE_AUTH, Number(leaderId));
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
      await db.delete(STORE_AUTH, Number(leaderId));
      return null;
    }
    const salt = hex2buf(record.salt);
    // Old records may not have an iterations field — fall back to 100k
    // (the original setting) so existing cached creds keep verifying.
    const iterations = record.iterations || 100_000;
    const hashed = await hashCredential(credential, salt, iterations);
    const expected = hex2buf(record.hashed);
    return constantTimeEqual(hashed, expected) ? record.profile : null;
  } catch {
    return null;
  }
}

// Returns true if a cached credential exists for this leader and hasn't
// expired. Used to decide whether to show the offline-login affordance
// vs. a "no internet, no cached login" message.
export async function hasCachedCredential(leaderId) {
  if (!leaderId) return false;
  try {
    const db = await getDB();
    const record = await db.get(STORE_AUTH, Number(leaderId));
    return !!record && Date.now() <= record.expiresAt;
  } catch {
    return false;
  }
}

export async function purgeCachedAuth(leaderId) {
  try {
    const db = await getDB();
    if (leaderId !== undefined) await db.delete(STORE_AUTH, Number(leaderId));
    else await db.clear(STORE_AUTH);
  } catch { /* nothing to do */ }
}

// In-memory plaintext credential, scoped to the current tab's lifetime.
// Used by syncQueue.drainQueue to silently re-login when the server cookie
// has expired during a long offline session — without it, queued writes
// would 401 forever until the leader manually logs in again.
//
// Not persisted (no localStorage / IDB) so closing the tab evicts it.
// We track which credential field (accessCode vs password) it represents
// so silent relogin only sends the right one, not both.
let liveCredential = null;

export function rememberLiveCredential({ leaderId, credential, mode }) {
  if (!leaderId || !credential) return;
  // Default to accessCode (leader role); explicit 'password' for admin/profesor.
  const safeMode = mode === 'password' ? 'password' : 'accessCode';
  liveCredential = { leaderId: Number(leaderId), credential, mode: safeMode };
}

export function getLiveCredential() {
  return liveCredential;
}

export function clearLiveCredential() {
  liveCredential = null;
}
