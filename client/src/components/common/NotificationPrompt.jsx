import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { requestNotificationPermission, ensurePushSubscription } from '../../lib/pushSubscribe';

// Floating "Enable notifications" CTA shown to leaders who are running
// the installed PWA but haven't decided about notification permission
// yet. Granting unlocks the server-push wake-up that drains the offline
// queue without the leader opening the app.
//
// Hidden if: no Notification API, permission already decided, not
// running standalone, dismissed in the last 30 days.

const STORAGE_KEY = 'notif_prompt_dismissed_until';
const DISMISS_MS = 30 * 24 * 60 * 60 * 1000;

function isStandalone() {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function readDismissed() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const until = parseInt(raw, 10);
    return !Number.isNaN(until) && Date.now() < until;
  } catch {
    return false;
  }
}

export default function NotificationPrompt() {
  const { t } = useTranslation('common');
  const [permission, setPermission] = useState(
    typeof Notification !== 'undefined' ? Notification.permission : 'unsupported'
  );
  const [dismissed, setDismissed] = useState(readDismissed);
  const [working, setWorking] = useState(false);
  const [show, setShow] = useState(false);

  useEffect(() => {
    setShow(isStandalone());
    // Re-evaluate when the install state flips (user installs the PWA
    // mid-session, or switches between standalone/browser tab views).
    // Without this the prompt stays hidden until the next full reload
    // even though the leader just installed the app.
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(display-mode: standalone)');
    const onChange = () => setShow(isStandalone());
    // Older Safari uses addListener/removeListener instead of add/remove
    // EventListener — feature-detect both so iOS 13 doesn't blow up.
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else if (mql.addListener) mql.addListener(onChange);
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange);
      else if (mql.removeListener) mql.removeListener(onChange);
    };
  }, []);

  if (!show) return null;
  if (permission !== 'default') return null;
  if (dismissed) return null;

  const enable = async () => {
    setWorking(true);
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === 'granted') {
      // Subscribe right away so the cron picks up the new endpoint on
      // its next run; failure here is silent and the next login retries.
      ensurePushSubscription().catch(() => {});
    }
    setWorking(false);
  };

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now() + DISMISS_MS));
    } catch { /* ignore */ }
    setDismissed(true);
  };

  return (
    <div
      role="region"
      aria-label={t('notifications.title')}
      className="fixed bottom-4 left-1/2 z-30 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-2xl border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950 shadow-lg dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-100"
    >
      <div className="flex items-start gap-3">
        <Bell className="mt-0.5 size-4 shrink-0 text-emerald-700 dark:text-emerald-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t('notifications.title')}</p>
          <p className="mt-0.5 text-xs text-emerald-800 dark:text-emerald-200">
            {t('notifications.subtitle')}
          </p>
          <div className="mt-2 flex items-center gap-3 text-xs">
            <button
              type="button"
              onClick={enable}
              disabled={working}
              className="rounded-md bg-emerald-600 px-3 py-1 font-medium text-white hover:bg-emerald-700 disabled:opacity-60"
            >
              {working ? t('actions.loading') : t('notifications.enable')}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="text-emerald-800 hover:text-emerald-950 dark:text-emerald-200 dark:hover:text-emerald-100"
            >
              {t('notifications.dismiss')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
