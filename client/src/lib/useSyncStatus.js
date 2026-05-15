import { useEffect, useState } from 'react';
import { subscribe, getSnapshot } from './syncQueue';

// Returns { pending, conflicts, isSyncing }. Reflects the current state of
// the offline write queue and any unresolved conflicts.
//
// Two notification sources merge here:
//   1. The page-side syncQueue subscribe() — fires when this tab enqueues
//      or drains.
//   2. The service worker's `sync-complete` postMessage — fires when the
//      SW drained the queue from its background sync handler (tab may be
//      closed; another tab may have done the work).
// Both push us to re-snapshot from IDB so the count stays consistent.
export function useSyncStatus() {
  const [state, setState] = useState({ pending: 0, conflicts: 0, isSyncing: false });

  useEffect(() => {
    const unsubscribe = subscribe(setState);
    const onSWMessage = (event) => {
      if (event.data?.type === 'sync-complete') {
        getSnapshot().then(setState).catch(() => {});
      }
    };
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', onSWMessage);
    }
    return () => {
      unsubscribe();
      if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
        navigator.serviceWorker.removeEventListener('message', onSWMessage);
      }
    };
  }, []);

  return state;
}
