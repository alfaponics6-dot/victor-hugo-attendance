import { useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, WifiOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useOnlineStatus } from '../../lib/useOnlineStatus';
import { useSyncStatus } from '../../lib/useSyncStatus';
import { drainQueue } from '../../lib/syncQueue';
import ConflictsModal from './ConflictsModal';

// Single banner that surfaces three related states:
//   1. offline (amber)   — no network, may have queued writes
//   2. syncing (blue)    — back online, draining the queue
//   3. conflicts (orange) — replay hit a 409 / hard error; user action needed
// We collapse into one slot to avoid stacking banners; precedence is
// offline > conflicts > syncing > idle-pending > nothing.
//
// Clickable states:
//   - conflicts > 0           → opens the resolver modal
//   - online + pending > 0 + !syncing → triggers an immediate drainQueue()
//                               so the user can retry stuck-pending state
//                               without reloading the tab.
export default function OfflineIndicator() {
  const isOnline = useOnlineStatus();
  const { pending, conflicts, isSyncing } = useSyncStatus();
  const { t } = useTranslation('common');
  const [modalOpen, setModalOpen] = useState(false);

  // First time the user goes offline, ask for notification permission so the
  // SW can tell them when their queued writes finally sync. One-shot — we
  // remember in localStorage even if they dismiss, to avoid re-prompting.
  useEffect(() => {
    if (isOnline) return;
    if (typeof Notification === 'undefined') return;
    if (Notification.permission !== 'default') return;
    if (localStorage.getItem('notif_permission_asked') === '1') return;
    localStorage.setItem('notif_permission_asked', '1');
    Notification.requestPermission().catch(() => {});
  }, [isOnline]);

  if (isOnline && pending === 0 && conflicts === 0) return null;

  let tone, Icon, message, spin = false, cta = null, onClick = null;
  if (!isOnline) {
    tone = 'amber';
    Icon = WifiOff;
    message = pending > 0
      ? t('offline.bannerWithPending', { count: pending })
      : t('offline.banner');
  } else if (conflicts > 0) {
    tone = 'orange';
    Icon = AlertTriangle;
    message = t('offline.conflicts', { count: conflicts });
    cta = t('offline.conflictsCta');
    onClick = () => setModalOpen(true);
  } else if (isSyncing) {
    tone = 'blue';
    Icon = RefreshCw;
    message = t('offline.syncing', { count: pending });
    spin = true;
  } else {
    // online + pending > 0 + not actively syncing — tap to retry now
    tone = 'blue';
    Icon = RefreshCw;
    message = t('offline.pending', { count: pending });
    cta = t('offline.syncNowCta');
    onClick = () => { drainQueue().catch(() => {}); };
  }

  const tones = {
    amber: 'border-amber-300 bg-amber-100 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200',
    blue:  'border-sky-300  bg-sky-100  text-sky-900  dark:border-sky-800  dark:bg-sky-950  dark:text-sky-200',
    orange:'border-orange-300 bg-orange-100 text-orange-900 dark:border-orange-800 dark:bg-orange-950 dark:text-orange-200',
  };

  const baseCls = `sticky top-0 z-50 flex items-center justify-center gap-2 border-b px-4 py-2 text-sm font-medium ${tones[tone]}`;
  const inner = (
    <>
      <Icon className={`size-4 shrink-0 ${spin ? 'animate-spin' : ''}`} aria-hidden="true" />
      <span>{message}</span>
      {cta && (
        <span className="ml-2 text-xs underline underline-offset-2 opacity-90">
          {cta}
        </span>
      )}
    </>
  );

  return (
    <>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className={`${baseCls} w-full hover:brightness-95 cursor-pointer text-center`}
          aria-haspopup={conflicts > 0 ? 'dialog' : undefined}
        >
          {inner}
        </button>
      ) : (
        <div role="status" aria-live="polite" className={baseCls}>
          {inner}
        </div>
      )}
      <ConflictsModal open={modalOpen} onClose={() => setModalOpen(false)} />
    </>
  );
}
