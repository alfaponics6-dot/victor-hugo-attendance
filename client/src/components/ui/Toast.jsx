import { motion, AnimatePresence } from 'motion/react';
import { CheckCircle2, AlertTriangle, X, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';

const ICONS = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
};

const TONES = {
  success: 'border-[color:var(--color-success)]/40 text-[color:var(--color-success)]',
  error: 'border-[color:var(--color-danger)]/40 text-[color:var(--color-danger)]',
  info: 'border-[color:var(--color-accent)]/40 text-[color:var(--color-accent)]',
};

/**
 * Lightweight controlled toast - render at the page level and pass `type`
 * (`'success' | 'error' | 'info'`) and `text`. Auto-clears via the parent's
 * useEffect timer; we just animate.
 */
const Toast = ({ type = 'info', text, onClose, className }) => {
  const Icon = ICONS[type] || Info;
  const { t } = useTranslation('common');
  return (
    <AnimatePresence>
      {text && (
        <motion.div
          initial={{ y: -8, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -8, opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.25, 1, 0.5, 1] }}
          className={cn(
            'flex items-center gap-3 px-4 py-3 rounded-xl surface border-l-4',
            TONES[type],
            className
          )}
          role="status"
          aria-live="polite"
        >
          <Icon className="size-4 shrink-0" />
          <span className="text-sm text-[color:var(--color-fg)] flex-1">{text}</span>
          {onClose && (
            <button
              onClick={onClose}
              aria-label={t('actions.close')}
              className="size-6 grid place-items-center rounded-md text-[color:var(--color-fg-subtle)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface-hover)] transition-colors"
            >
              <X className="size-3.5" />
            </button>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default Toast;
