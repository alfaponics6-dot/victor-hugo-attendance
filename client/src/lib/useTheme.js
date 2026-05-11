import { useEffect, useSyncExternalStore } from 'react';

// Theme is dark by default. Order of precedence on first paint:
//   1. localStorage `theme` (set by a previous explicit toggle)
//   2. window.matchMedia('(prefers-color-scheme: light)') — honour OS pref
//   3. fall through to 'dark'
//
// We use a module-level store + useSyncExternalStore so that multiple
// components consuming `useTheme()` share state — earlier we had each
// component running its own useState, which meant the ThemeToggle could
// flip its local state without Login.jsx (which conditionally renders
// the bg photo) re-rendering.
const STORAGE_KEY = 'theme';

function readInitial() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark') return stored;
  } catch { /* localStorage may be blocked */ }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
}

function applyTheme(theme) {
  const html = document.documentElement;
  if (theme === 'light') html.classList.add('light');
  else html.classList.remove('light');
}

// ─── Tiny module-level store ─────────────────────────────────────────
let _theme = typeof document !== 'undefined' ? readInitial() : 'dark';
const _subs = new Set();

function _emit() {
  _subs.forEach((cb) => cb());
}

function _setTheme(next) {
  if (next !== 'light' && next !== 'dark') return;
  if (next === _theme) return;
  _theme = next;
  applyTheme(_theme);
  try { localStorage.setItem(STORAGE_KEY, _theme); } catch { /* ignore */ }
  _emit();
}

function _subscribe(cb) {
  _subs.add(cb);
  return () => _subs.delete(cb);
}

// useSyncExternalStore is the React-recommended primitive for subscribing
// to external (non-React) state. It guarantees tearing-free reads.
export function useTheme() {
  const theme = useSyncExternalStore(_subscribe, () => _theme, () => 'dark');

  // OS preference change watcher — only takes effect if the user has never
  // chosen explicitly (no localStorage entry).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    const onChange = (e) => {
      try { if (localStorage.getItem(STORAGE_KEY)) return; } catch { return; }
      _setTheme(e.matches ? 'light' : 'dark');
    };
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);

  return {
    theme,
    setTheme: _setTheme,
    toggle: () => _setTheme(_theme === 'dark' ? 'light' : 'dark'),
    isDark: theme === 'dark',
    isLight: theme === 'light',
  };
}

// Apply once at module import so the right class is on <html> BEFORE
// React mounts — avoids a flash of dark-on-first-paint when a user picked
// light last session.
if (typeof document !== 'undefined') {
  applyTheme(_theme);
}
