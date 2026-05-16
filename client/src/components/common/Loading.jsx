import { useTranslation } from 'react-i18next';
import Spinner from '../ui/Spinner';

// Default message comes from i18n so the spinner respects the user's locale.
// The previous hard-coded "Cargando..." showed Spanish to English / French /
// Portuguese users on every route fallback.
function Loading({ message }) {
  const { t } = useTranslation('common');
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center justify-center gap-3 py-16 text-[color:var(--color-fg-muted)]"
    >
      <Spinner size="lg" className="text-[color:var(--color-accent)]" />
      <p className="text-sm tracking-tight">{message ?? t('actions.loading')}</p>
    </div>
  );
}

export default Loading;
