import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './lib/i18n'
// Imported for the side effect: sets the right `light` class on <html> at
// module load, BEFORE React renders. Prevents a flash of the wrong theme
// for users who picked light last session.
import './lib/useTheme'
import { initSyncQueue } from './lib/syncQueue'
import { ensurePushSubscription } from './lib/pushSubscribe'
import App from './App.jsx'
import ErrorBoundary from './components/common/ErrorBoundary'

// Register the online listener and drain any queued writes from a prior
// offline session. Safe to call before React mounts; offline operations
// won't kick in until the axios interceptor enqueues something.
initSyncQueue()

// If the user previously granted notification permission but the push
// subscription was never landed (e.g. they granted while offline, or a
// VAPID key fetch failed mid-flow), recover it on every boot. Safe and
// idempotent — silently no-ops when permission is default/denied.
ensurePushSubscription().catch(() => {})

// When a new service worker takes control (e.g. immediately after a
// deploy, via skipWaiting + clients.claim), reload the page so the tab
// runs against the new bundle's contract. Without this, the page can
// register a sync tag with handlers the new SW knows but the old SW —
// still controlling this tab — does not.
if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return
    reloading = true
    window.location.reload()
  })
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
