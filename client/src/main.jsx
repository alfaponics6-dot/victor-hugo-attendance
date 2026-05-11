import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import './lib/i18n'
// Imported for the side effect: sets the right `light` class on <html> at
// module load, BEFORE React renders. Prevents a flash of the wrong theme
// for users who picked light last session.
import './lib/useTheme'
import App from './App.jsx'
import ErrorBoundary from './components/common/ErrorBoundary'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
