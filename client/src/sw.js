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

// skipWaiting + clients.claim so a new SW takes over immediately on
// activation. Without claim(), the old SW keeps controlling open tabs
// until they reload — sync tags registered to the new tag name end up
// being swallowed by the old SW that has no handler for them.
self.skipWaiting();
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Allow the page to ask the SW to purge user-scoped runtime caches
// (called from logout(); see api/client.js). The api-get cache is shared
// across whoever uses this browser, so we have to drop it explicitly to
// avoid leaking one user's cached responses to the next.
self.addEventListener('message', (event) => {
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
      new CacheableResponsePlugin({ statuses: [0, 200] }),
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
    event.waitUntil(drainWithLock());
  }
});

// Acquire the cross-context Web Lock before touching the IDB store so we
// can't race a page-side drainQueue running concurrently.
async function drainWithLock() {
  if (self.navigator?.locks?.request) {
    return self.navigator.locks.request(
      DRAIN_LOCK_NAME,
      { ifAvailable: true },
      (lock) => (lock ? drainQueueInSW() : Promise.resolve()),
    );
  }
  return drainQueueInSW();
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
      // tag so we get another shot if the cookie gets refreshed elsewhere.
      try {
        if (self.registration?.sync) await self.registration.sync.register(SYNC_TAG);
      } catch { /* ignore */ }
      break;
    } else if (result === 'skipped') {
      // FormData items: we can't reliably reconstruct the multipart body
      // with stored Blobs from inside the SW context, so the page-side
      // drain has to handle them. Leave the item alone — no retry-bump,
      // no conflict-record. It'll be processed next tab open.
      continue;
    } else {
      // network / 5xx: bump retries, give up at MAX
      const retries = (item.retries || 0) + 1;
      try {
        await db.put(STORE_PENDING, { ...item, retries });
      } catch { /* ignore */ }
      if (retries >= MAX_RETRIES) {
        try {
          await db.add(STORE_CONFLICTS, {
            url: item.url,
            method: item.method,
            body: itemBodyForConflict(item),
            serverMessage: `Failed after ${MAX_RETRIES} attempts`,
            serverStatus: 0,
            createdAt: Date.now(),
          });
          await db.delete(STORE_PENDING, item.id);
        } catch { /* ignore */ }
      }
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
        body: JSON.stringify({ queueSize: remaining }),
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
    try {
      const data = await response.clone().json();
      item.lastError = data?.error || data?.message || 'HTTP 409';
    } catch {
      item.lastError = 'HTTP 409';
    }
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
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let payload = {};
  try {
    if (event.data) payload = event.data.json();
  } catch { /* opaque or empty push */ }

  // Run the drain inside the lock so a concurrent page-side drain can't
  // race us. drainQueueInSW() handles the notification + client postMessage
  // when items get processed.
  await drainWithLock();

  // If drainWithLock emitted a notification (processed > 0), we're done.
  // Otherwise iOS will penalize us for "silent push" — fall back to a
  // quiet status notification with a short auto-dismiss so we satisfy
  // the visible-notification requirement without spamming the user.
  if (Notification.permission === 'granted') {
    const recent = await self.registration.getNotifications({ tag: 'attendance-sync' });
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
      setTimeout(async () => {
        const stale = await self.registration.getNotifications({ tag: 'sync-status' });
        for (const n of stale) n.close();
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
