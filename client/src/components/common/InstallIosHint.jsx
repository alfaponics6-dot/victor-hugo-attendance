import { useState } from 'react';
import { Share, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// Floating bottom banner shown to iOS Safari users who haven't installed
// the PWA to their home screen. Without installation, iOS shows its own
// "no internet" page on cold offline navigations and never consults the
// service worker — meaning our cached app shell is unreachable. From a
// home-screen-installed PWA, the SW intercepts properly.
//
// Hidden if: not iOS Safari, already running standalone, or dismissed
// in the last 30 days (localStorage flag).

const STORAGE_KEY = 'install_hint_dismissed_until';
const DISMISS_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function isIosSafariNonStandalone() {
  if (typeof window === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // First the easy case: UA literally says iPad/iPhone/iPod.
  let isIos = /iPad|iPhone|iPod/.test(ua);
  // iPadOS 13+ masquerades as MacIntel in the UA string. Touch-bar
  // MacBooks ALSO report maxTouchPoints > 0, so > 1 alone false-positives
  // those — a profesor reviewing the dashboard from a Mac with touch bar
  // would see an irrelevant "add to Home Screen" banner. Threshold of >=
  // 5 cleanly excludes touch bar (max 1-2 points) while keeping every
  // real iPad (which reports 5+ for multi-touch gestures).
  if (!isIos && navigator.platform === 'MacIntel' && navigator.maxTouchPoints >= 5) {
    isIos = true;
  }
  if (!isIos) return false;
  const isStandalone =
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true;
  return !isStandalone;
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

export default function InstallIosHint() {
  const { t } = useTranslation('common');
  const [show] = useState(isIosSafariNonStandalone);
  const [dismissed, setDismissed] = useState(readDismissed);
  const [expanded, setExpanded] = useState(false);

  if (!show || dismissed) return null;

  const dismiss = () => {
    try {
      localStorage.setItem(STORAGE_KEY, String(Date.now() + DISMISS_MS));
    } catch {
      /* ignore */
    }
    setDismissed(true);
  };

  return (
    <div
      role="region"
      aria-label={t('install.title')}
      className="fixed bottom-4 left-1/2 z-40 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 rounded-2xl border border-sky-300 bg-sky-50 p-3 text-sm text-sky-950 shadow-lg dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100"
    >
      <div className="flex items-start gap-3">
        <Share className="mt-0.5 size-4 shrink-0 text-sky-700 dark:text-sky-300" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <p className="font-medium">{t('install.title')}</p>
          <p className="mt-0.5 text-xs text-sky-800 dark:text-sky-200">
            {t('install.subtitle')}
          </p>
          {expanded && (
            <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-sky-900 dark:text-sky-100">
              <li>{t('install.step1')}</li>
              <li>
                {t('install.step2')}
                <Plus className="mx-1 inline-block size-3 align-middle" aria-hidden="true" />
              </li>
              <li>{t('install.step3')}</li>
            </ol>
          )}
          <div className="mt-2 flex items-center gap-3 text-xs">
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="font-medium underline underline-offset-2 hover:text-sky-700 dark:hover:text-sky-300"
            >
              {expanded ? t('install.hideHow') : t('install.showHow')}
            </button>
            <button
              type="button"
              onClick={dismiss}
              className="text-sky-700 hover:text-sky-900 dark:text-sky-300 dark:hover:text-sky-100"
            >
              {t('install.dismiss')}
            </button>
          </div>
        </div>
        <button
          type="button"
          onClick={dismiss}
          aria-label={t('install.dismiss')}
          className="-m-1 rounded-md p-1 text-sky-700 hover:bg-sky-100 hover:text-sky-900 dark:text-sky-300 dark:hover:bg-sky-900"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
