import {
  enqueue as enqueueToStore,
  peekAll,
  removeById,
  bumpRetries,
  recordConflict,
  count as queueCount,
  conflictCount,
} from './offlineQueue';
import { getLiveCredential, onLiveCredentialChange } from './offlineAuth';
import { setAppBadge } from './appBadge';

const MAX_RETRIES = 5;
// Subscribers get notified whenever the queue size, conflict count, or
// syncing flag changes. Hook adapters bridge this to React state.
const listeners = new Set();
let isSyncing = false;

// BroadcastChannel cross-tab fanout. Without this, Tab A enqueuing an
// offline write doesn't update Tab B's banner / badge until Tab B
// happens to call snapshot() itself (which it won't, unless something
// triggers notify there). Every notify() in any tab broadcasts a
// "re-snapshot now" ping; every tab's receiver runs a local snapshot()
// + listener notify so React state catches up.
const channel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('vh-sync')
  : null;
if (channel) {
  channel.addEventListener('message', (e) => {
    if (e.data?.type !== 'queue-changed') return;
    // Avoid re-broadcasting (would ping-pong forever): use the silent
    // local-only notify path.
    notifyLocalOnly().catch(() => {});
  });
}

async function snapshot() {
  const [pending, conflicts] = await Promise.all([queueCount(), conflictCount()]);
  return { pending, conflicts, isSyncing };
}

async function notify() {
  await notifyLocalOnly();
  // Fan out to other tabs so their useSyncStatus subscribers re-render.
  // Wrapped in try because some browsers throw if the channel was closed
  // (e.g., after pagehide on iOS Safari).
  try { channel?.postMessage({ type: 'queue-changed' }); } catch { /* ignore */ }
}

async function notifyLocalOnly() {
  const snap = await snapshot();
  // Mirror the pending count onto the app icon badge — leaders see a
  // red number on the PWA icon when they unlock their iPad even if no
  // notification fired. Best-effort, silently no-ops where unsupported.
  setAppBadge(snap.pending).catch(() => {});
  for (const l of listeners) {
    try { l(snap); } catch { /* never let one listener kill another */ }
  }
}

export function subscribe(listener) {
  let cancelled = false;
  listeners.add(listener);
  // Push current state to the new subscriber so React doesn't render
  // stale. Guard the .then() callback so a React StrictMode mount →
  // unmount cycle (or any fast unsubscribe) doesn't invoke `listener`
  // (often setState) after the component is gone.
  snapshot()
    .then((snap) => { if (!cancelled) listener(snap); })
    .catch(() => {});
  return () => {
    cancelled = true;
    listeners.delete(listener);
  };
}

export async function getSnapshot() {
  return snapshot();
}

// Single facade used by the axios interceptor: enqueue + notify subscribers
// in one call so the UI's pending-count chip updates immediately.
//
// Also registers a Background Sync tag so the SW can drain even if the
// tab gets closed before connectivity returns. SyncManager isn't supported
// on iOS Safari — that's a no-op there (we'll still drain on next page open).
export async function enqueueRequest(payload) {
  const id = await enqueueToStore(payload);
  await notify();
  registerBackgroundSync().catch(() => {});
  // Best-effort: tell the server "I have N items pending". When the
  // device is offline (typical for an enqueue), this fetch fails — that
  // lines up with the next online drain or boot heartbeat. When the
  // network is just transiently flaky, this lets the server flag us
  // before the next cron tick so wake-up pushes can fire.
  pushHeartbeat().catch(() => {});
  return id;
}

// Tell the server how many writes are currently pending in our IndexedDB
// queue. The server's syncStateTracker middleware (and the explicit
// /push/heartbeat endpoint) use this to set/clear the per-leader
// sync_needed_at flag that gates the wake-up push cron.
async function pushHeartbeat() {
  if (typeof navigator === 'undefined' || !navigator.onLine) return;
  try {
    const queueSize = await queueCount();
    await fetch('/api/push/heartbeat', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queueSize }),
    });
  } catch { /* best-effort */ }
}

async function registerBackgroundSync() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!('SyncManager' in window)) return;
  const reg = await navigator.serviceWorker.ready;
  if (!reg.sync) return;
  await reg.sync.register('drain-attendance-queue');
}

// Drain the queue once. Safe to call repeatedly — concurrent invocations
// short-circuit on the isSyncing flag AND on the Web Locks API so the
// service worker's background-sync drain can't race the page-side drain
// across contexts on the same browser profile.
//
// On 401 we attempt a single silent re-login using the in-memory credential
// (set by Login.jsx after either online or offline login). The cookie this
// produces lets us drain queued writes that were made during a long offline
// session, where the server's JWT cookie expired before sync.
const DRAIN_LOCK_NAME = 'vh-drain-queue';

export async function drainQueue() {
  if (isSyncing) return { skipped: 'already-syncing' };
  if (!navigator.onLine) return { skipped: 'offline' };

  // Web Locks coordinate page + SW contexts. ifAvailable returns null
  // immediately if the lock is held elsewhere instead of queueing.
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(
      DRAIN_LOCK_NAME,
      { ifAvailable: true },
      (lock) => (lock ? doDrainQueue() : Promise.resolve({ skipped: 'lock-busy' })),
    );
  }
  return doDrainQueue();
}

// Track which leaderId the current cookie was last aligned to. When the
// in-memory credential changes (user switch on a shared tablet), drain
// re-aligns the cookie BEFORE replaying queued writes — otherwise replays
// would be attributed to whoever last logged in online, not the user
// who actually made the offline edits.
let lastAlignedLeaderId = null;

async function doDrainQueue() {
  isSyncing = true;
  await notify();

  // NOTE: we deliberately do NOT fire a start-of-drain heartbeat. Two
  // concurrent heartbeats (one at start with size N, one at end with
  // size 0 or remaining) race through the network — HTTP/2 multiplexing
  // can deliver them out of order, so a late "N>0" overwrites the
  // authoritative final "0" and the server keeps pushing forever.
  // The boot-time heartbeat + enqueue heartbeat + axios X-Queue-Size
  // headers already keep the server informed about queue growth; the
  // end-of-drain heartbeat is the authoritative final state.

  let processed = 0;
  let conflicts = 0;
  let failed = 0;
  let attemptedRelogin = false;

  // Pre-emptive cookie alignment when the active credential identity has
  // changed (or never aligned this session). Best-effort: if it fails the
  // normal drain still tries, and the auth-fail path retries.
  const live = getLiveCredential();
  if (live && live.leaderId !== lastAlignedLeaderId && navigator.onLine) {
    const ok = await silentRelogin();
    if (ok) lastAlignedLeaderId = live.leaderId;
  }

  try {
    // Outer loop: re-fetch items + restart after a successful silent re-login.
    while (navigator.onLine) {
      const items = await peekAll();
      if (items.length === 0) break;

      let hitAuthFail = false;
      let madeProgress = false;

      for (const item of items) {
        if (!navigator.onLine) break;
        // Don't replay another leader's queued write under the current
        // session — leave it for its author to sync when they log back in
        // on this shared device. (Server also enforces this via X-Queued-By;
        // skipping here avoids a wasted round-trip on the page path.)
        if (item.userId != null && live?.leaderId != null
            && Number(item.userId) !== Number(live.leaderId)) {
          continue;
        }
        const result = await replay(item);
        if (result === 'success') {
          await removeById(item.id);
          processed += 1;
          madeProgress = true;
        } else if (result === 'conflict') {
          await recordConflict({
            url: item.url,
            method: item.method,
            body: item.isFormData
              ? { kind: 'formdata', fields: item.body ? formDataToFields(item.body) : {}, files: {} }
              : { kind: 'json', body: item.body },
            serverMessage: item.lastError,
            serverStatus: 409,
          });
          await removeById(item.id);
          conflicts += 1;
          madeProgress = true;
        } else if (result === 'auth-fail') {
          hitAuthFail = true;
          break;
        } else if (result === 'skipped') {
          // Wrong author for this session — leave the item queued for its
          // author. No retry-bump, no conflict, no progress flag.
          continue;
        } else {
          // network / 5xx → keep the item, bump retries
          const retries = await bumpRetries(item.id);
          // null = record disappeared (concurrent drain, storage
          // eviction). Treat as already handled — don't try to remove
          // or conflict-record it.
          if (retries === null) {
            madeProgress = true;
            continue;
          }
          if (retries >= MAX_RETRIES) {
            await recordConflict({
              url: item.url,
              method: item.method,
              body: item.isFormData
                ? { kind: 'formdata', fields: formDataToFields(item.body), files: {} }
                : { kind: 'json', body: item.body },
              serverMessage: `Failed after ${MAX_RETRIES} attempts: ${item.lastError ?? 'unknown'}`,
              serverStatus: 0,
            });
            await removeById(item.id);
            failed += 1;
            madeProgress = true;
          }
        }
      }

      if (hitAuthFail && !attemptedRelogin) {
        attemptedRelogin = true;
        const ok = await silentRelogin();
        if (ok) continue; // restart drain with fresh cookie
        break;
      }
      if (hitAuthFail) break;
      if (!madeProgress) break; // avoid infinite loop on stable failures
    }
  } finally {
    isSyncing = false;
    await notify();
  }

  // If items remain and we're still online and we didn't successfully
  // process any of them, schedule an exponential-backoff retry. The
  // earlier predicate also required conflicts===0 and failed===0 — that
  // was wrong: if one bad item always goes to the conflicts store, the
  // other genuinely-stuck items would never retry. Only `processed`
  // counts as "made forward progress on the network side".
  const { pending } = await snapshot();
  if (pending > 0 && navigator.onLine && processed === 0) {
    scheduleBackoffRetry();
  } else {
    resetBackoff();
  }

  // Final heartbeat so the server's sync_needed_at reflects reality
  // (clears it when queue is empty; keeps it set when items remain).
  pushHeartbeat().catch(() => {});

  return { processed, conflicts, failed };
}

let backoffMs = 0;
let backoffTimer = null;
const BACKOFF_INITIAL = 60_000;     // 1 min
const BACKOFF_MAX = 30 * 60_000;    // 30 min

function scheduleBackoffRetry() {
  if (backoffTimer) return; // already scheduled
  // Compute the delay locally; don't commit it to `backoffMs` until the
  // timer actually fires AND attempts a real drain. If we double
  // pre-emptively, repeated already-syncing skips will push the backoff
  // to the cap in seconds without any real retries having occurred.
  const delay = backoffMs === 0 ? BACKOFF_INITIAL : Math.min(backoffMs * 2, BACKOFF_MAX);
  backoffTimer = setTimeout(async () => {
    backoffTimer = null;
    let result = null;
    try { result = await drainQueue(); } catch { /* ignore */ }
    // Only commit to the longer backoff if the drain actually ran. A
    // skipped result means another drain is already in-flight (it'll
    // handle backoff in its own finally), so leave our state alone.
    if (result && !result.skipped) backoffMs = delay;
  }, delay);
}

function resetBackoff() {
  backoffMs = 0;
  if (backoffTimer) { clearTimeout(backoffTimer); backoffTimer = null; }
}

// Silent re-login using the in-memory plaintext credential captured at
// the last successful login. Returns true if the server accepted it (and
// therefore the auth cookie is now fresh). Only retried once per process
// per credential — a stable 401 means the cached cred is dead, but a
// fresh online login (rememberLiveCredential firing) resets the latch
// so retries resume with the new credential.
let silentReloginPermanentlyFailed = false;
onLiveCredentialChange(() => {
  silentReloginPermanentlyFailed = false;
  // Force the next drain to re-align the cookie — the previous
  // alignment was for a (possibly different) leader. Without this
  // reset, logout-then-login as a different leader would skip the
  // alignment if the new leader's id happens to differ, AND
  // logout-then-login-offline as same leader would skip alignment
  // even though the server-side cookie may have been cleared.
  lastAlignedLeaderId = null;
});

async function silentRelogin() {
  if (silentReloginPermanentlyFailed) return false;
  const live = getLiveCredential();
  if (!live || !navigator.onLine) return false;
  try {
    const payload = { leaderId: live.leaderId };
    // Send only the appropriate field for the user's role to avoid
    // broadening the credential's blast radius (a leader code attempted
    // as an admin password etc.).
    if (live.mode === 'password') payload.password = live.credential;
    else payload.accessCode = live.credential;
    const r = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.ok) return true;
    if (r.status === 401 || r.status === 403) {
      silentReloginPermanentlyFailed = true;
    }
    return false;
  } catch {
    return false;
  }
}

function formDataToFields(fd) {
  const out = {};
  if (!(fd instanceof FormData)) return out;
  for (const [k, v] of fd.entries()) {
    if (typeof v === 'string') out[k] = v;
    // Files get dropped from the conflict record body — Phase 3 conflict UI
    // will need to ask the user to re-attach if needed. Storing the file
    // twice (queue + conflicts) doubles disk pressure for no value.
  }
  return out;
}

async function replay(item) {
  const init = {
    method: item.method,
    headers: { ...(item.headers || {}) },
    credentials: 'include',
  };
  if (item.method !== 'GET' && item.method !== 'HEAD') {
    if (item.isFormData) {
      // Browser sets the multipart boundary header automatically.
      init.body = item.body;
    } else if (item.body !== null && item.body !== undefined) {
      init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
      init.body = typeof item.body === 'string' ? item.body : JSON.stringify(item.body);
    }
  }

  let response;
  try {
    response = await fetch(item.url, init);
  } catch (err) {
    item.lastError = err?.message || 'network error';
    return 'network-fail';
  }

  if (response.ok) return 'success';
  if (response.status === 409) {
    let data = null;
    try { data = await response.clone().json(); } catch { /* ignore */ }
    item.lastError = data?.error || data?.message || `HTTP 409`;
    // Wrong author for the current session (X-Queued-By mismatch) — leave it
    // queued for the real author rather than treating it as a conflict.
    if (data?.error === 'WRONG_AUTHOR') return 'skipped';
    return 'conflict';
  }
  if (response.status === 401 || response.status === 403) {
    return 'auth-fail';
  }
  // 4xx (other) — these are application bugs, not transient. Treat as a
  // conflict so the user sees them rather than retrying forever.
  if (response.status >= 400 && response.status < 500) {
    try {
      const data = await response.clone().json();
      item.lastError = data?.error || data?.message || `HTTP ${response.status}`;
    } catch {
      item.lastError = `HTTP ${response.status}`;
    }
    return 'conflict';
  }
  // 5xx — transient, keep retrying
  item.lastError = `HTTP ${response.status}`;
  return 'network-fail';
}

let initialized = false;

export function initSyncQueue() {
  if (initialized) return;
  initialized = true;
  // Drain on reconnect. Clear any pending backoff timer first — we're
  // about to drain anyway, no need to also fire later.
  window.addEventListener('online', () => {
    resetBackoff();
    drainQueue().catch(() => {});
  });
  // Drain on boot if we're already online and have items waiting. Also
  // heartbeat unconditionally so the server's sync flag reflects what's
  // really sitting in this device's queue right now — fixes the case
  // where the PWA was force-closed before the queue was ever reported.
  if (navigator.onLine) {
    pushHeartbeat().catch(() => {});
    drainQueue().catch(() => {});
  }
}
