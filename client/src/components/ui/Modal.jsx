import { useEffect, useId, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';

// CSS selector for tabbable elements inside the dialog. We trap Tab/Shift+Tab
// to keep focus within the modal — without this, Tab would escape the dialog
// onto background page controls underneath the backdrop (a11y bug).
const FOCUSABLE_SELECTOR =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
  'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const Modal = ({ open, onClose, title, description, children, className, size = 'md', closeLabel }) => {
  const { t } = useTranslation('common');
  const ariaCloseLabel = closeLabel || t('actions.close');
  const panelRef = useRef(null);
  const previousFocusRef = useRef(null);
  // Stable IDs so the dialog's title and description are announced by screen
  // readers as the accessible name and description of the dialog itself.
  const reactId = useId();
  const titleId = `modal-title-${reactId}`;
  const descId = `modal-desc-${reactId}`;

  useEffect(() => {
    if (!open) return;
    // Remember what was focused so we can restore on close — keyboard users
    // expect to return to the trigger button after dismissing a modal.
    previousFocusRef.current = document.activeElement;

    const onKey = (e) => {
      if (e.key === 'Escape') {
        onClose?.();
        return;
      }
      // Focus trap. Without this, Tab leaks out of the dialog onto the
      // background page (the click outline you'd see "jumping behind" the
      // backdrop).
      if (e.key === 'Tab' && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll(FOCUSABLE_SELECTOR);
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        // If focus is on the panel itself (tabIndex=-1 fallback) or has
        // somehow leaked outside the panel, pull it back to the appropriate
        // edge so Tab navigation stays inside the dialog.
        if (!panelRef.current.contains(active) || active === panelRef.current) {
          e.preventDefault();
          (e.shiftKey ? last : first).focus();
          return;
        }
        if (e.shiftKey && active === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';

    // Move focus into the dialog on open. If a child opted into focus via
    // `autoFocus` (e.g. ConfirmModal's primary action), don't steal it. We
    // detect that by checking whether the active element after React's
    // commit phase is already inside the panel. Falling back: focus the
    // first focusable child, then the panel itself so screen readers
    // announce the dialog's role and label.
    const focusTimer = window.setTimeout(() => {
      if (!panelRef.current) return;
      const alreadyInside = panelRef.current.contains(document.activeElement);
      if (alreadyInside && document.activeElement !== panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll(FOCUSABLE_SELECTOR);
      const target = focusables[0] || panelRef.current;
      target.focus({ preventScroll: true });
    }, 0);

    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      window.clearTimeout(focusTimer);
      // Restore focus to whatever held it before the modal opened.
      const prev = previousFocusRef.current;
      if (prev && typeof prev.focus === 'function') {
        prev.focus({ preventScroll: true });
      }
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
            ref={panelRef}
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
              'focus:outline-none',
              sizeClass,
              className
            )}
            role="dialog"
            aria-modal="true"
            aria-labelledby={title ? titleId : undefined}
            aria-describedby={description ? descId : undefined}
            tabIndex={-1}
          >
            <header className="flex items-start justify-between gap-3 px-5 sm:px-6 pt-5 sticky top-0 z-10 surface rounded-t-2xl">
              <div className="min-w-0 flex-1">
                {title && (
                  <h2 id={titleId} className="text-base sm:text-base font-semibold tracking-tight truncate">
                    {title}
                  </h2>
                )}
                {description && (
                  <p id={descId} className="text-xs text-[color:var(--color-fg-muted)] mt-0.5 line-clamp-2">{description}</p>
                )}
              </div>
              <button
                type="button"
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
