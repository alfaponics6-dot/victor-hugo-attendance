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
// Leader accounts share a single LEADER_ACCESS_CODE (per README). Caching
// the credential per-leaderId would force every leader to log in online
// once per device — wrong UX for shared tablets where any of 14 leaders
// can pick up the device and need to mark attendance offline. We key the
// leader cache by role instead. Admin/profesor still use per-leaderId
// caching since their passwords are personal.
const SHARED_LEADER_KEY = 'role:leader';
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
    const role = profile?.role || 'leader';
    // leader → shared key (any leader's online login unlocks offline for
    // ALL leaders on this device, since the access code is org-wide).
    // admin/profesor → per-user key (their password is personal).
    const key = role === 'leader' ? SHARED_LEADER_KEY : Number(leaderId);
    await db.put(STORE_AUTH, {
      leaderId: key,
      salt: buf2hex(salt),
      hashed: buf2hex(hashed),
      iterations: ITERATIONS,
      // For shared-leader records the embedded profile is the leader who
      // happened to log in online. We don't restore it on offline-login —
      // tryOfflineLogin reconstructs from the selected leader instead.
      profile,
      role,
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
//
// `leader` is the leader object the user selected from the dropdown (from
// /auth/leaders). For the shared-leader cache path we reconstruct the
// profile from this object so the restored session reflects who the user
// actually picked, not whoever last logged in online.
export async function tryOfflineLogin({ leaderId, credential, leader }) {
  if (!crypto?.subtle || !leaderId || !credential) return null;
  try {
    const db = await getDB();

    // Path 1: shared leader cache. Only applies if the selected leader has
    // role 'leader' (or unspecified, which defaults to leader in this app).
    const selectedRole = leader?.role || 'leader';
    if (selectedRole === 'leader') {
      const shared = await db.get(STORE_AUTH, SHARED_LEADER_KEY);
      if (shared && Date.now() <= shared.expiresAt) {
        if (await verifyAgainst(credential, shared)) {
          return buildProfileFromLeader(leader);
        }
      } else if (shared && Date.now() > shared.expiresAt) {
        await db.delete(STORE_AUTH, SHARED_LEADER_KEY).catch(() => {});
      }
    }

    // Path 2: per-user cache. Used for admin/profesor + legacy leader
    // records cached before SHARED_LEADER_KEY existed.
    const record = await db.get(STORE_AUTH, Number(leaderId));
    if (!record) return null;
    if (Date.now() > record.expiresAt) {
      await db.delete(STORE_AUTH, Number(leaderId)).catch(() => {});
      return null;
    }
    if (await verifyAgainst(credential, record)) {
      return record.profile;
    }
    return null;
  } catch {
    return null;
  }
}

async function verifyAgainst(credential, record) {
  const salt = hex2buf(record.salt);
  // Old records may not have an iterations field — fall back to 100k
  // (the original setting) so existing cached creds keep verifying.
  const iterations = record.iterations || 100_000;
  const hashed = await hashCredential(credential, salt, iterations);
  const expected = hex2buf(record.hashed);
  return constantTimeEqual(hashed, expected);
}

// The leaders list returns snake_case fields; the rest of the app
// (AuthContext, pages) expects camelCase. Mirror the shape /auth/login
// returns so consumers don't have to special-case offline login.
function buildProfileFromLeader(leader) {
  if (!leader) return null;
  return {
    id: leader.id,
    name: leader.name,
    email: leader.email ?? null,
    projectId: leader.project_id ?? leader.projectId ?? null,
    projectName: leader.project_name ?? leader.projectName ?? null,
    projectNumber: leader.project_number ?? leader.projectNumber ?? null,
    role: leader.role || 'leader',
  };
}

// Returns true if a cached credential exists for this leader and hasn't
// expired. Used to decide whether to show the offline-login affordance
// vs. a "no internet, no cached login" message.
//
// Checks BOTH paths the verifier checks: shared `role:leader` cache and
// per-user cache. Without the shared-cache check this returned false for
// leaders on a tablet where another leader had primed the shared
// credential — wrong answer, UI would discourage an offline-login that
// actually would have worked.
export async function hasCachedCredential(leaderId, opts = {}) {
  const role = opts.role || 'leader';
  try {
    const db = await getDB();
    if (role === 'leader') {
      const shared = await db.get(STORE_AUTH, SHARED_LEADER_KEY);
      if (shared && Date.now() <= shared.expiresAt) return true;
    }
    if (!leaderId) return false;
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

// In-memory plaintext credential, used by syncQueue.drainQueue to silently
// re-login when the server cookie expired (or pre-emptively when a
// different leader offline-logs-in on a shared tablet).
//
// For the LEADER role, we also persist the credential to localStorage so
// it survives a PWA cold-restart on iOS — without persistence, an iPad
// that kills the standalone PWA in the background loses the cred and the
// user has to manually re-login to flush the queue. The leader access
// code is already shared org-wide and cached as a hash in IDB; storing
// it as plaintext is a marginal extra exposure on an unlocked device,
// well worth the offline-resilience win.
//
// Admin/profesor credentials are PERSONAL passwords — those stay
// in-memory only.
const LIVE_STORAGE_KEY = 'live_leader_cred';

function loadPersistedCredential() {
  try {
    const raw = localStorage.getItem(LIVE_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.leaderId || !parsed?.credential) return null;
    return {
      leaderId: Number(parsed.leaderId),
      credential: String(parsed.credential),
      mode: parsed.mode === 'password' ? 'password' : 'accessCode',
    };
  } catch {
    return null;
  }
}

let liveCredential = loadPersistedCredential();
// Listeners notified whenever the live credential changes — syncQueue
// subscribes so it can reset its silent-relogin "permanently failed"
// latch when a fresh credential lands (otherwise a transient 401 early
// in the session would stick forever, even after the user re-logins
// with correct creds later in the same tab).
const credChangeListeners = new Set();

export function rememberLiveCredential({ leaderId, credential, mode }) {
  if (!leaderId || !credential) return;
  const safeMode = mode === 'password' ? 'password' : 'accessCode';
  liveCredential = { leaderId: Number(leaderId), credential, mode: safeMode };
  // Only persist for shared-code leader role. Personal passwords would
  // turn the device into a long-term password leak surface.
  if (safeMode === 'accessCode') {
    try {
      localStorage.setItem(LIVE_STORAGE_KEY, JSON.stringify(liveCredential));
    } catch { /* quota / private mode — drop silently */ }
  } else {
    try { localStorage.removeItem(LIVE_STORAGE_KEY); } catch { /* ignore */ }
  }
  for (const l of credChangeListeners) {
    try { l(liveCredential); } catch { /* don't let one listener kill another */ }
  }
}

export function onLiveCredentialChange(listener) {
  credChangeListeners.add(listener);
  return () => credChangeListeners.delete(listener);
}

export function getLiveCredential() {
  return liveCredential;
}

export function clearLiveCredential() {
  liveCredential = null;
  try { localStorage.removeItem(LIVE_STORAGE_KEY); } catch { /* ignore */ }
  // Notify listeners so the silentReloginPermanentlyFailed latch (and
  // any future state pegged to credential identity) resets on explicit
  // logout, not just on credential ROTATION via rememberLiveCredential.
  for (const l of credChangeListeners) {
    try { l(null); } catch { /* don't let one listener kill another */ }
  }
}
