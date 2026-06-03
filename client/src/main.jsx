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
import UpdatePrompt from './components/common/UpdatePrompt'

// Register the online listener and drain any queued writes from a prior
// offline session. Safe to call before React mounts; offline operations
// won't kick in until the axios interceptor enqueues something.
initSyncQueue()

// If the user previously granted notification permission but the push
// subscription was never landed (e.g. they granted while offline, or a
// VAPID key fetch failed mid-flow), recover it on every boot. Safe and
// idempotent — silently no-ops when permission is default/denied.
ensurePushSubscription().catch(() => {})

// We used to call window.location.reload() inside a `controllerchange`
// listener so a new SW's bundle would take effect mid-session. That
// caused a visible "page renders, blanks, renders" glitch on first
// loads — the `hadInitialController` gate we added didn't fully
// suppress it (multiple users still reported the flash on hard
// refresh / incognito, after the gate was deployed and minified to
// the equivalent `if (!n && t)` form).
//
// New approach: do NOT auto-reload. New SW bundles will be picked up
// on the user's next manual navigation. The cost is that an existing
// tab won't see a freshly deployed bundle until the user reloads, but
// that's acceptable for an attendance app (no second-by-second update
// requirements) and worth eliminating the glitch entirely.
//
// If we ever want to surface "new version available" again, do it
// passively (e.g. a dismissable banner that calls reload on click),
// never via an automatic reload triggered by a SW lifecycle event.

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
      <UpdatePrompt />
    </ErrorBoundary>
  </StrictMode>,
)
