import { useEffect, useState } from 'react';
import { subscribe } from './syncQueue';

// Returns { pending, conflicts, isSyncing }. Reflects the current state of
// the offline write queue and any unresolved conflicts.
export function useSyncStatus() {
  const [state, setState] = useState({ pending: 0, conflicts: 0, isSyncing: false });

  useEffect(() => {
    const unsubscribe = subscribe(setState);
    return unsubscribe;
  }, []);

  return state;
}
