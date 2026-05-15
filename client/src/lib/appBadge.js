// App icon badge — shows the number of pending offline writes on the
// PWA's home-screen icon. The leader sees "5" on the icon when they
// unlock their iPad, taps it, the app opens, and the queue drains.
//
// Available on Chrome/Edge 81+, Safari 16.4+ (installed PWA only).
// Falls back to a silent no-op on unsupported environments — calling
// is always safe.

export async function setAppBadge(count) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  try {
    if (typeof navigator === 'undefined') return;
    if (n === 0) {
      if (navigator.clearAppBadge) await navigator.clearAppBadge();
      return;
    }
    if (navigator.setAppBadge) await navigator.setAppBadge(n);
  } catch { /* unsupported / privacy mode — no-op */ }
}

export async function clearAppBadge() {
  return setAppBadge(0);
}
