import { useEffect, useState } from 'react';

// navigator.onLine reflects the OS-level network state. It can be a false
// positive (LAN connected, no upstream) but it's the cheap signal we have for
// Phase 1. Phase 2 will reconcile against actual fetch outcomes when the
// write queue lands.
//
// iOS Safari (especially in installed PWAs) is known to silently drop the
// `online`/`offline` events when the app is backgrounded across a network
// transition — the user yanks WiFi while the tablet is asleep, comes back,
// and the indicator is still stuck on "online" or "offline" from before.
// We additionally re-check navigator.onLine on visibilitychange / pageshow
// to recover from those drops; cheap reads, no network traffic.
export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    const recheck = () => {
      if (typeof navigator !== 'undefined') setIsOnline(navigator.onLine);
    };
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    // Recover from Safari's dropped online/offline events when the page
    // returns to the foreground or the BFCache restore happens.
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('pageshow', recheck);
    window.addEventListener('focus', recheck);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('pageshow', recheck);
      window.removeEventListener('focus', recheck);
    };
  }, []);

  return isOnline;
}
