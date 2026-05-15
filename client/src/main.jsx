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

// When a new service worker takes control mid-session (e.g. immediately
// after a deploy, via skipWaiting + clients.claim), reload the page so
// the tab runs against the new bundle's contract. Without this, the
// page can register a sync tag with handlers the new SW knows but the
// old SW — still controlling this tab — does not.
//
// IMPORTANT: only reload when there was ALREADY a controller. On a
// first-ever visit, the page renders → SW installs → SW activates and
// claims → controllerchange fires for the first time. Reloading there
// is wasteful and looks like a glitch (page renders, blanks, renders).
// We only care about controllerchange when an OLD controller is being
// swapped for a new one.
if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
  const hadInitialController = !!navigator.serviceWorker.controller
  let reloading = false
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return
    if (!hadInitialController) return  // first-install case, page is already fresh
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
