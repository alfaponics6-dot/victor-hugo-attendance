import { useRegisterSW } from 'virtual:pwa-register/react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import Button from '../ui/Button';

/**
 * Passive "new version available" banner.
 *
 * Uses vite-plugin-pwa's prompt flow: `needRefresh` becomes true ONLY when a
 * new service worker is waiting — a genuine update, never on first install
 * (that fires `offlineReady` instead). Tapping "Actualizar" calls
 * updateServiceWorker(true), which messages the waiting SW to skipWaiting
 * (handled in sw.js) and reloads the page exactly once.
 *
 * There is intentionally NO automatic reload on a SW lifecycle event — see the
 * note in main.jsx about the prior reload glitch. This is the blessed
 * "dismissable banner that reloads on click" approach: the only reload is the
 * one the user explicitly triggers, so it can never interrupt attendance
 * marking or loop.
 */
export default function UpdatePrompt() {
  const { t } = useTranslation('common');
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      // Installed PWAs left open (e.g. an iPad) won't notice a new deploy on
      // their own. Poll for an updated SW every 30 min and whenever the app
      // regains focus, so the banner can appear without a full app close.
      if (!registration) return;
      const check = () => registration.update().catch(() => {});
      setInterval(check, 30 * 60 * 1000);
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    },
  });

  if (!needRefresh) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-[100] flex justify-center px-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pointer-events-none"
    >
      <div className="pointer-events-auto flex items-center gap-2 rounded-xl bg-[color:var(--color-bg-2)] hairline shadow-lg px-3 py-2.5 max-w-md w-full">
        <RefreshCw className="size-4 text-[color:var(--color-accent)] shrink-0" />
        <span className="text-sm flex-1 min-w-0">{t('update.available')}</span>
        <Button variant="ghost" size="sm" onClick={() => setNeedRefresh(false)}>
          {t('update.later')}
        </Button>
        <Button variant="primary" size="sm" onClick={() => updateServiceWorker(true)}>
          {t('update.reload')}
        </Button>
      </div>
    </div>
  );
}
