// Subscribe the device for Web Push so the server can wake the SW and
// drain the offline queue without the leader opening the app. Best-effort:
// silently no-ops if the browser doesn't support push, the user hasn't
// granted notification permission, or the network is down.
//
// Called after a successful online login. Safe to call repeatedly — the
// browser's PushManager.subscribe() returns the existing subscription
// when one exists for the same applicationServerKey.

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const out = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) out[i] = rawData.charCodeAt(i);
  return out;
}

// Coalesce concurrent callers onto a single in-flight promise. Previously
// we returned undefined immediately when a call was already in flight,
// which made `ensurePushSubscription()` look done from the caller's POV
// even though no subscription work had happened on its behalf. The
// NotificationPrompt's enable button and the login interceptor can fire
// within milliseconds of each other; the second caller would then assume
// the first finished even when it hadn't yet POSTed to the server.
let inFlightPromise = null;

export async function ensurePushSubscription() {
  if (inFlightPromise) return inFlightPromise;
  inFlightPromise = (async () => {
    try {
      if (typeof window === 'undefined') return;
      if (!('serviceWorker' in navigator)) return;
      if (!('PushManager' in window)) return;
      if (typeof Notification === 'undefined') return;
      if (Notification.permission !== 'granted') return; // user gesture required to ask

      const reg = await navigator.serviceWorker.ready;
      if (!reg.pushManager) return;

      // Reuse existing subscription if one is already active for this origin.
      let subscription = await reg.pushManager.getSubscription();
      if (!subscription) {
        const keyResp = await fetch('/api/push/vapid-public-key', { credentials: 'include' });
        if (!keyResp.ok) return;
        let publicKey;
        try {
          ({ publicKey } = await keyResp.json());
        } catch {
          // Bad JSON from the key endpoint shouldn't kill the whole login
          // flow — just bail and let the next login retry.
          return;
        }
        if (!publicKey) return;
        try {
          subscription = await reg.pushManager.subscribe({
            userVisibleOnly: true, // iOS + Chrome both require this
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
        } catch {
          // Subscribe can throw if the user denied permission between
          // the permission check above and now, or if the push service
          // is briefly unavailable. Best-effort — next login retries.
          return;
        }
      }

      // Tell the server about the subscription so the cron can target
      // it. We retry once on a non-2xx response: a transient 500 here
      // means the device subscription exists in the browser but the
      // server can't push to it, which silently breaks wake-up sync
      // until the next login fires this function again.
      const payload = JSON.stringify({ subscription: subscription.toJSON() });
      const attempt = () => fetch('/api/push/subscribe', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      }).catch(() => null);
      let r = await attempt();
      if (!r || (!r.ok && r.status >= 500)) {
        // 401/403 means we're not logged in — no point retrying.
        // 4xx other than auth means the server rejected the payload
        // shape; retrying with the same body is pointless.
        await new Promise((res) => setTimeout(res, 1500));
        r = await attempt();
      }

      // Ask iOS / browser not to evict our IDB + localStorage. Without
      // this, iOS Safari purges site storage after ~7 days of non-use
      // even in installed PWAs — losing cached_auth, pending_requests
      // queue, and the persisted leader credential. Web Push permission
      // typically grants this automatically; calling it explicitly is a
      // no-op when not supported.
      try {
        if (navigator.storage?.persist) await navigator.storage.persist();
      } catch { /* unsupported */ }
    } catch {
      // Push is best-effort. A failure here doesn't block anything.
    } finally {
      inFlightPromise = null;
    }
  })();
  return inFlightPromise;
}

export async function unsubscribePush() {
  try {
    if (!('serviceWorker' in navigator)) return;
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager?.getSubscription();
    if (!sub) return;
    // Tell server first so we don't leave a row for an endpoint that's
    // about to stop accepting pushes.
    await fetch('/api/push/subscribe', {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => null);
    await sub.unsubscribe().catch(() => null);
  } catch { /* best-effort */ }
}

// Request notification permission from a user gesture (button click).
// Returns the resulting permission string. After 'granted', callers
// should call ensurePushSubscription() to wire up the subscription.
export async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try {
    return await Notification.requestPermission();
  } catch {
    return 'denied';
  }
}
