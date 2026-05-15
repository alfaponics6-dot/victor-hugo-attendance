import {
  enqueue as enqueueToStore,
  peekAll,
  removeById,
  bumpRetries,
  recordConflict,
  count as queueCount,
  conflictCount,
} from './offlineQueue';

const MAX_RETRIES = 5;
// Subscribers get notified whenever the queue size, conflict count, or
// syncing flag changes. Hook adapters bridge this to React state.
const listeners = new Set();
let isSyncing = false;

async function snapshot() {
  const [pending, conflicts] = await Promise.all([queueCount(), conflictCount()]);
  return { pending, conflicts, isSyncing };
}

async function notify() {
  const snap = await snapshot();
  for (const l of listeners) {
    try { l(snap); } catch { /* never let one listener kill another */ }
  }
}

export function subscribe(listener) {
  listeners.add(listener);
  // Push current state to the new subscriber so React doesn't render stale.
  snapshot().then(listener).catch(() => {});
  return () => listeners.delete(listener);
}

export async function getSnapshot() {
  return snapshot();
}

// Single facade used by the axios interceptor: enqueue + notify subscribers
// in one call so the UI's pending-count chip updates immediately.
export async function enqueueRequest(payload) {
  const id = await enqueueToStore(payload);
  await notify();
  return id;
}

// Drain the queue once. Safe to call repeatedly — concurrent invocations
// short-circuit on the isSyncing flag. Caller decides when (online event,
// app boot, manual retry button).
export async function drainQueue() {
  if (isSyncing) return { skipped: 'already-syncing' };
  if (!navigator.onLine) return { skipped: 'offline' };
  isSyncing = true;
  await notify();

  let processed = 0;
  let conflicts = 0;
  let failed = 0;

  try {
    const items = await peekAll();
    // Stable FIFO order: idb returns by primary key ascending, which is the
    // same as createdAt for autoincrement keys.
    for (const item of items) {
      if (!navigator.onLine) break; // bailed mid-drain — pick up next online event
      const result = await replay(item);
      if (result === 'success') {
        await removeById(item.id);
        processed += 1;
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
      } else if (result === 'auth-fail') {
        // 401 on replay: user is logged out or token is dead. Stop the
        // drain to avoid blasting the rest of the queue at /login. Items
        // stay in the queue; next successful login will retry them.
        break;
      } else {
        // network / 5xx → keep the item, bump retries
        const retries = await bumpRetries(item.id);
        if (retries >= MAX_RETRIES) {
          // Treat as a conflict so the UI surfaces it for manual handling
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
        }
      }
    }
  } finally {
    isSyncing = false;
    await notify();
  }
  return { processed, conflicts, failed };
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
    try {
      const data = await response.clone().json();
      item.lastError = data?.error || data?.message || `HTTP 409`;
    } catch {
      item.lastError = 'HTTP 409';
    }
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
  // Drain on reconnect.
  window.addEventListener('online', () => {
    drainQueue().catch(() => {});
  });
  // Drain on boot if we're already online and have items waiting.
  if (navigator.onLine) {
    drainQueue().catch(() => {});
  }
}
