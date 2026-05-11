import { useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';

const Modal = ({ open, onClose, title, description, children, className, size = 'md', closeLabel }) => {
  const { t } = useTranslation('common');
  const ariaCloseLabel = closeLabel || t('actions.close');
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  const sizeClass = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  }[size];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-50 grid place-items-end sm:place-items-center sm:p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
        >
          <div
            className="absolute inset-0 bg-black/60 backdrop-blur-md"
            onClick={onClose}
          />
          <motion.div
            initial={{ y: 12, scale: 0.97, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 8, scale: 0.97, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
            className={cn(
              // Phone: a near-full-width bottom sheet with rounded top corners.
              // sm+: a centered, capped-width dialog.
              'relative w-full surface glow shadow-2xl',
              'max-h-[90vh] overflow-y-auto',
              'rounded-t-2xl sm:rounded-2xl',
              sizeClass,
              className
            )}
            role="dialog"
            aria-modal="true"
          >
            <header className="flex items-start justify-between gap-3 px-5 sm:px-6 pt-5 sticky top-0 z-10 surface rounded-t-2xl">
              <div className="min-w-0 flex-1">
                {title && (
                  <h2 className="text-base sm:text-base font-semibold tracking-tight truncate">
                    {title}
                  </h2>
                )}
                {description && (
                  <p className="text-xs text-[color:var(--color-fg-muted)] mt-0.5 line-clamp-2">{description}</p>
                )}
              </div>
              <button
                aria-label={ariaCloseLabel}
                onClick={onClose}
                className="size-9 sm:size-8 grid place-items-center rounded-lg text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface-hover)] transition-colors shrink-0"
              >
                <X className="size-4" />
              </button>
            </header>
            <div className="px-5 sm:px-6 py-4 sm:py-5">{children}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
};

export default Modal;
