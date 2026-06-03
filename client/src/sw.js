// Custom service worker (injectManifest mode). vite-plugin-pwa replaces
// `self.__WB_MANIFEST` with the precache manifest at build time.
//
// Beyond the precache + runtime caches we had with the generated SW, this
// version adds:
//   - A `sync` event handler that drains the offline queue when connectivity
//     returns, EVEN IF THE TAB IS CLOSED (Background Sync API). Android
//     Chrome/Edge support this fully; iOS Safari does not implement it, so
//     iOS users still rely on opening the app for the page-side drain.
//   - A local notification (showNotification) after a successful drain.
//   - postMessage to connected clients so the in-page sync indicator updates
//     without the user having to refresh.

import { precacheAndRoute, cleanupOutdatedCaches, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkFirst, StaleWhileRevalidate, CacheFirst } from 'workbox-strategies';
import { ExpirationPlugin } from 'workbox-expiration';
import { CacheableResponsePlugin } from 'workbox-cacheable-response';
import { openDB } from 'idb';

// We used to call self.skipWaiting() at top level and self.clients.claim()
// in the activate handler so a new SW would take over immediately. That
// combination — even with no page-side `controllerchange` listener — was
// observed (via Playwright instrumentation) to cause a one-off browser-
// level reload on first SW activation: the page navigated twice with no
// JavaScript navigation API call (reload/assign/replace/href setter/
// history.go/form submit were all patched and recorded zero calls). The
// reload landed within ~10ms of the controllerchange event, strongly
// implicating the SW takeover itself.
//
// Standard SW lifecycle now: new SW installs, waits in the background,
// activates only after all controlled tabs are closed (or after an
// explicit user gesture). No surprise reloads. Cost: new bundles take
// effect on next fresh tab instead of mid-session — acceptable for an
// attendance app where leaders typically open/close per use anyway.

// Allow the page to ask the SW to purge user-scoped runtime caches
// (called from logout(); see api/client.js). The api-get cache is shared
// across whoever uses this browser, so we have to drop it explicitly to
// avoid leaking one user's cached responses to the next.
self.addEventListener('message', (event) => {
  // The page (UpdatePrompt → vite-plugin-pwa updateServiceWorker) asks this
  // waiting SW to take over NOW, in response to the user tapping the "new
  // version" banner. We deliberately do NOT skipWaiting on install/activate
  // (that caused a reload glitch — see main.jsx); only on this explicit,
  // user-initiated request. No clients.claim either.
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (event.data?.type === 'purge-caches') {
    event.waitUntil((async () => {
      try {
        await caches.delete('api-get');
      } catch { /* ignore */ }
      event.ports?.[0]?.postMessage?.({ ok: true });
    })());
  }
});

const DB_NAME = 'victorhugo-offline';
const DB_VERSION = 2;
const STORE_PENDING = 'pending_requests';
const STORE_CONFLICTS = 'conflicts';
const STORE_AUTH = 'cached_auth';
const SYNC_TAG = 'drain-attendance-queue';
const MAX_RETRIES = 5;

// ----- Precache + runtime caches (same behavior as before) -----
precacheAndRoute(self.__WB_MANIFEST || []);
cleanupOutdatedCaches();

registerRoute(
  new NavigationRoute(createHandlerBoundToURL('/index.html'), {
    denylist: [/^\/api\//],
  })
);

registerRoute(
  ({ url, request }) => url.pathname.startsWith('/api/') && request.method === 'GET',
  new NetworkFirst({
    cacheName: 'api-get',
    networkTimeoutSeconds: 5,
    plugins: [
      new ExpirationPlugin({ maxEntries: 200, maxAgeSeconds: 60 * 60 * 24 * 7 }),
      // Only cache genuine 200s — never opaque/error (status 0) responses.
      // For an authenticated API, caching a 0 could persist a failed or
      // cross-origin response and serve it back offline.
      new CacheableResponsePlugin({ statuses: [200] }),
    ],
  })
);

registerRoute(
  ({ url }) => url.origin === 'https://fonts.googleapis.com',
  new StaleWhileRevalidate({ cacheName: 'google-fonts-stylesheets' })
);

registerRoute(
  ({ url }) => url.origin === 'https://fonts.gstatic.com',
  new CacheFirst({
    cacheName: 'google-fonts-webfonts',
    plugins: [
      new ExpirationPlugin({ maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 }),
      new CacheableResponsePlugin({ statuses: [0, 200] }),
    ],
  })
);

// ----- IDB (shared schema with the page-side offlineQueue.js) -----
let dbPromise;
function getDB() {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_PENDING)) {
          db.createObjectStore(STORE_PENDING, { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(STORE_CONFLICTS)) {
          db.createObjectStore(STORE_CONFLICTS, { keyPath: 'id', autoIncrement: true });
        }
        if (!db.objectStoreNames.contains(STORE_AUTH)) {
          db.createObjectStore(STORE_AUTH, { keyPath: 'leaderId' });
        }
      },
    });
  }
  return dbPromise;
}

// ----- Background Sync handler -----
const DRAIN_LOCK_NAME = 'vh-drain-queue';

self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG) {
    // Background Sync semantics: if the promise passed to waitUntil
    // REJECTS, the browser keeps the sync registration alive and retries
    // it with exponential backoff. If it RESOLVES, the registration is
    // cleared. We don't want a transient IDB / lock error to silently
    // suppress future drains by leaving the registration in a bad state,
    // and we ALSO don't want a single unrelated throw (e.g. an aborted
    // fetch during shutdown) to mark the sync "failed forever" once the
    // browser exhausts its retry budget. Swallow + log so the runtime
    // sees a resolved promise; the next push or page-side drain will
    // pick up anything that was missed.
    event.waitUntil(
      drainWithLock().catch((err) => {
        console.warn('[sw] background sync drain failed:', err?.message || err);
      }),
    );
  }
});

// Acquire the cross-context Web Lock before touching the IDB store so we
// can't race a page-side drainQueue running concurrently.
//
// Returns true if we actually ran the drain, false if the lock was held
// elsewhere and we skipped. Callers use this to decide whether they
// need to fire a fallback notification (we shouldn't fire one when the
// other context is already mid-drain — it'll show its own).
async function drainWithLock() {
  if (self.navigator?.locks?.request) {
    return self.navigator.locks.request(
      DRAIN_LOCK_NAME,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) return false;
        await drainQueueInSW();
        return true;
      },
    );
  }
  await drainQueueInSW();
  return true;
}

// Drain logic that runs INSIDE the service worker context. Mirrors the
// page-side drainQueue but uses raw fetch (no axios) and can't do silent
// re-login because the plaintext credential is page-memory only.
async function drainQueueInSW() {
  const db = await getDB();
  let items;
  try { items = await db.getAll(STORE_PENDING); } catch { items = []; }
  // NOTE: don't early-return when items is empty. We still want to fire
  // the heartbeat at the end so the server clears any stale sync flag
  // that's keeping the cron poking us.

  let processed = 0;
  let conflicts = 0;
  let skipped = 0;
  for (const item of items) {
    const result = await replayItem(item);
    if (result === 'success') {
      try { await db.delete(STORE_PENDING, item.id); } catch { /* ignore */ }
      processed += 1;
    } else if (result === 'conflict') {
      try {
        await db.add(STORE_CONFLICTS, {
          url: item.url,
          method: item.method,
          body: itemBodyForConflict(item),
          serverMessage: item.lastError ?? 'HTTP 4xx',
          serverStatus: item.lastStatus ?? 409,
          createdAt: Date.now(),
        });
        await db.delete(STORE_PENDING, item.id);
        conflicts += 1;
      } catch { /* ignore */ }
    } else if (result === 'auth-fail') {
      // The page-side drain handles silent re-login (it has the live
      // plaintext credential). From SW we can't. Stop the drain so the
      // next online tab session can finish the job. Re-register the sync
      // tag so we get another shot if the cookie gets refreshed
      // elsewhere — BUT only if SyncManager actually exists. On iOS
      // Safari `self.registration.sync` is undefined; the previous code
      // silently no-op'd, leading to an infinite "Conectado" loop where
      // every cron push triggered a SW wake → auth-fail → fake stub →
      // server still flagged → next push, forever. Now we explicitly
      // tell the server queueSize=0 so the cron stops bothering us
      // until the user reopens the app and the page-side drain runs.
      if (self.registration?.sync) {
        try { await self.registration.sync.register(SYNC_TAG); } catch { /* ignore */ }
      } else {
        // No SyncManager → no escape from this state via SW. Tell the
        // server we have nothing to drain (a deliberate lie scoped to
        // this push); the page-side drain will heartbeat the truth on
        // next tab open.
        try {
          await fetch('/api/push/heartbeat', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ queueSize: 0 }),
          });
        } catch { /* ignore */ }
      }
      break;
    } else if (result === 'skipped') {
      // FormData items: we can't reliably reconstruct the multipart body
      // with stored Blobs from inside the SW context, so the page-side
      // drain has to handle them. Leave the item alone — no retry-bump,
      // no conflict-record. It'll be processed next tab open.
      skipped += 1;
      continue;
    } else {
      // network / 5xx in SW context: DO NOT bump retries. The page-side
      // drain has the authoritative retry counter (and can do silent
      // relogin, which the SW can't). If the leader's tablet is asleep
      // and a series of cron-triggered pushes all hit a flaky cellular
      // window, bumping retries here would burn through MAX_RETRIES and
      // surface fake conflicts that the user has no way to action.
      // Leave the item alone — next push (or next tab open) will retry
      // with the same counter.
    }
  }

  if (processed > 0 || conflicts > 0) {
    await notifyClients({ type: 'sync-complete', processed, conflicts });
    if (processed > 0) await showSyncNotification(processed, conflicts);
  }

  // Tell the server how many items remain so the cron can stop pushing
  // this leader once the queue is drained. Best-effort — auth cookie
  // must still be valid for the heartbeat to land.
  try {
    const remaining = await db.count(STORE_PENDING).catch(() => null);
    if (remaining !== null) {
      // Special case: if everything we touched was FormData (which the
      // SW can't replay), report queueSize=0 so the cron stops pushing.
      // The page-side drain will replay these items on next tab open
      // and its heartbeat will restore the flag if work remains. Without
      // this the server would push us every cron tick forever for items
      // we have no way to drain in SW context.
      const effective =
        processed === 0 && conflicts === 0 && skipped > 0 && remaining === skipped
          ? 0
          : remaining;
      // Update the home-screen app badge so the leader sees the new
      // pending count next time they look at their iPad. This is the
      // primary "you have offline work waiting" signal on iOS — push
      // can be throttled, badge can't.
      try {
        if (remaining === 0 && self.navigator?.clearAppBadge) {
          await self.navigator.clearAppBadge();
        } else if (remaining > 0 && self.navigator?.setAppBadge) {
          await self.navigator.setAppBadge(remaining);
        }
      } catch { /* unsupported */ }
      await fetch('/api/push/heartbeat', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ queueSize: effective }),
      }).catch(() => null);
    }
  } catch { /* ignore */ }
}

function itemBodyForConflict(item) {
  if (item.body?.kind === 'formdata') {
    // Files dropped — too costly to duplicate. UI can still show the fields.
    const fields = {};
    for (const [k, v] of Object.entries(item.body.fields || {})) {
      if (typeof v === 'string') fields[k] = v;
    }
    return { kind: 'formdata', fields, files: {} };
  }
  return { kind: 'json', body: item.body?.body ?? null };
}

async function replayItem(item) {
  const init = {
    method: item.method,
    headers: { ...(item.headers || {}) },
    credentials: 'include',
  };
  // SW has no access to FormData reconstruction with stored Blobs in a
  // straightforward way; the page-side drain handles those. Skip formdata
  // items here — the page-side drain will pick them up on next tab open.
  if (item.body?.kind === 'formdata') return 'skipped';
  if (item.method !== 'GET' && item.method !== 'HEAD' && item.body?.body !== undefined) {
    init.headers['Content-Type'] = init.headers['Content-Type'] || 'application/json';
    init.body = typeof item.body.body === 'string'
      ? item.body.body
      : JSON.stringify(item.body.body);
  }

  let response;
  try {
    response = await fetch(item.url, init);
  } catch (err) {
    item.lastError = err?.message || 'network error';
    return 'network-fail';
  }

  if (response.ok) return 'success';
  if (response.status === 401 || response.status === 403) return 'auth-fail';
  if (response.status === 409) {
    item.lastStatus = 409;
    let data = null;
    try { data = await response.clone().json(); } catch { /* ignore */ }
    item.lastError = data?.error || data?.message || 'HTTP 409';
    // A different leader is logged in on this device right now; leave the
    // item queued for its real author instead of mis-attributing it or
    // burying it as a conflict the author can't recover.
    if (data?.error === 'WRONG_AUTHOR') return 'skipped';
    return 'conflict';
  }
  if (response.status >= 400 && response.status < 500) {
    item.lastStatus = response.status;
    item.lastError = `HTTP ${response.status}`;
    return 'conflict';
  }
  item.lastError = `HTTP ${response.status}`;
  return 'network-fail';
}

async function notifyClients(message) {
  try {
    const clients = await self.clients.matchAll({ includeUncontrolled: true });
    for (const c of clients) c.postMessage(message);
  } catch { /* nothing to do */ }
}

async function showSyncNotification(processed, conflicts) {
  if (!('showNotification' in self.registration)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const body = conflicts > 0
      ? `Se sincronizaron ${processed} registro(s) · ${conflicts} conflicto(s) requieren atención`
      : `Se sincronizaron ${processed} registro(s).`;
    await self.registration.showNotification('Asistencia sincronizada', {
      body,
      icon: '/Logo-Universidad-EARTH_academico-300x257.png',
      badge: '/Logo-Universidad-EARTH_academico-300x257.png',
      tag: 'attendance-sync',
      renotify: false,
    });
  } catch { /* permission may have been revoked */ }
}

// ----- Web Push wake-up -----
// The server pushes a periodic 'sync-trigger' so we can drain the queue
// without the leader opening the app. Apple requires every push handler
// on iOS to show a visible notification, so we always show one (the
// drain logic decides whether it's "synced N records" or a quiet
// "connected" stub).
self.addEventListener('push', (event) => {
  // Wrap so an unexpected throw in handlePush can't surface as a "push
  // event failed" → iOS would treat that as silent push and revoke our
  // subscription after a few strikes. If everything else fails, fire a
  // last-resort visible notification so Apple sees we honored the push.
  event.waitUntil(
    handlePush(event).catch(async () => {
      try {
        if (Notification.permission === 'granted') {
          await self.registration.showNotification('Asistencia', {
            body: 'Conectado.',
            icon: '/Logo-Universidad-EARTH_academico-300x257.png',
            tag: 'sync-status',
            silent: true,
          });
        }
      } catch { /* nothing we can do */ }
    }),
  );
});

async function handlePush(event) {
  let payload = {};
  try {
    if (event.data) payload = event.data.json();
  } catch { /* opaque or empty push */ }

  // Run the drain inside the lock so a concurrent page-side drain can't
  // race us. ranDrain=false means the page-side has the lock and is
  // already handling everything (including its own notification) — we
  // skip the fallback to avoid a duplicate "Conectado" stub on top of
  // the real "Asistencia sincronizada" notification the page will show.
  //
  // CRITICAL: every catch path here MUST still attempt to fire a visible
  // notification. iOS penalizes silent push aggressively — if the drain
  // throws and we return early without a notification, Apple's push
  // service starts demoting our subscription within a handful of strikes.
  let ranDrain = false;
  try {
    ranDrain = await drainWithLock();
  } catch {
    // Treat a drain error like "we ran but produced no notification" —
    // we still owe the user (and Apple) a visible notification.
    ranDrain = true;
  }

  // If page-side has the lock, it'll handle its own notification — skip.
  if (!ranDrain) return;

  // If drainQueueInSW emitted a real notification (processed > 0), we're
  // done. Otherwise iOS will penalize us for "silent push" — fall back
  // to a quiet status notification with a short auto-dismiss so we
  // satisfy the visible-notification requirement without spamming.
  if (Notification.permission === 'granted') {
    let recent = [];
    try {
      recent = await self.registration.getNotifications({ tag: 'attendance-sync' });
    } catch { /* very rare; treat as "no recent notification" and fall back */ }
    if (recent.length === 0) {
      await self.registration
        .showNotification('Asistencia', {
          body: 'Conectado y sincronizado.',
          icon: '/Logo-Universidad-EARTH_academico-300x257.png',
          tag: 'sync-status',
          silent: true,
          requireInteraction: false,
        })
        .catch(() => {});
      // Auto-dismiss the quiet notification after 4s so it doesn't pile up.
      // Wrapped in async catch so a getNotifications/close throw doesn't
      // leak an unhandled rejection out of the timer (which would log
      // noise in DevTools and could be picked up by error reporting).
      setTimeout(() => {
        self.registration.getNotifications({ tag: 'sync-status' })
          .then((stale) => { for (const n of stale) n.close(); })
          .catch(() => {});
      }, 4000);
    }
  }
}

// Clicking the notification focuses the app (or opens it if closed).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of clients) {
      if ('focus' in c) return c.focus();
    }
    if (self.clients.openWindow) return self.clients.openWindow('/');
  })());
});
