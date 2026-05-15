import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './lib/i18n'
// Imported for the side effect: sets the right `light` class on <html> at
// module load, BEFORE React renders. Prevents a flash of the wrong theme
// for users who picked light last session.
import './lib/useTheme'
import { initSyncQueue } from './lib/syncQueue'
import App from './App.jsx'
import ErrorBoundary from './components/common/ErrorBoundary'

// Register the online listener and drain any queued writes from a prior
// offline session. Safe to call before React mounts; offline operations
// won't kick in until the axios interceptor enqueues something.
initSyncQueue()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
