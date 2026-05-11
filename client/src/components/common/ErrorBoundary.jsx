import { Component } from 'react';
import i18n from '../../lib/i18n';

// Class-component boundary, so we can't use the useTranslation hook. We
// call into the i18next instance directly. At ErrorBoundary render time
// i18next is guaranteed initialised by main.jsx's eager import.
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    this.setState({ error, errorInfo });
    if (import.meta.env.DEV) {
      console.error('Error caught by boundary:', error, errorInfo);
    }
  }

  handleReset = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render() {
    if (!this.state.hasError) return this.props.children;
    const t = i18n.t.bind(i18n);

    return (
      <div className="min-h-screen grid place-items-center p-6">
        <div className="surface rounded-2xl p-6 sm:p-8 max-w-md w-full text-center space-y-4">
          <h1 className="text-2xl font-semibold tracking-tight">{t('common:errorBoundary.title')}</h1>
          <p className="text-sm text-[color:var(--color-fg-muted)]">
            {t('common:errorBoundary.description')}
          </p>

          {import.meta.env.DEV && this.state.error && (
            <details className="text-left text-xs surface-flat rounded-lg p-3">
              <summary className="cursor-pointer text-[color:var(--color-fg-muted)]">
                {t('common:errorBoundary.detailsSummary')}
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-words text-[11px] text-[color:var(--color-danger)]">
                {this.state.error.toString()}
                {this.state.errorInfo && this.state.errorInfo.componentStack}
              </pre>
            </details>
          )}

          <div className="flex flex-col sm:flex-row gap-2 pt-2">
            <button
              onClick={this.handleReset}
              className="h-11 px-4 rounded-xl bg-[color:var(--color-accent)] text-[oklch(0.18_0.02_260)] font-medium flex-1"
            >
              {t('common:errorBoundary.tryAgain')}
            </button>
            <button
              onClick={() => (window.location.href = '/')}
              className="h-11 px-4 rounded-xl surface text-[color:var(--color-fg)] font-medium flex-1"
            >
              {t('common:errorBoundary.backHome')}
            </button>
          </div>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
