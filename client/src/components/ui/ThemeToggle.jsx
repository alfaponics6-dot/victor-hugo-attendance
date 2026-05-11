import { Sun, Moon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../../lib/useTheme';
import { cn } from '../../lib/cn';

// Sun/moon toggle. Mirrors LanguageSwitcher's height + chrome so the two
// can sit next to each other in headers without one looking out of place.
function ThemeToggle({ className }) {
  const { isDark, toggle } = useTheme();
  const { t } = useTranslation('common');
  const label = isDark
    ? t('theme.switchToLight', { defaultValue: 'Light mode' })
    : t('theme.switchToDark', { defaultValue: 'Dark mode' });

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={label}
      title={label}
      className={cn(
        'inline-flex items-center justify-center size-9 sm:size-8 rounded-lg',
        'surface-flat hover:bg-[color:var(--color-surface-hover)]',
        'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]',
        'transition-colors',
        className,
      )}
    >
      {isDark ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </button>
  );
}

export default ThemeToggle;
