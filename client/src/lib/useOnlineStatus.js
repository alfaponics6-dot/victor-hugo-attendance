import { useEffect, useState } from 'react';

// navigator.onLine reflects the OS-level network state. It can be a false
// positive (LAN connected, no upstream) but it's the cheap signal we have for
// Phase 1. Phase 2 will reconcile against actual fetch outcomes when the
// write queue lands.
export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return isOnline;
}
