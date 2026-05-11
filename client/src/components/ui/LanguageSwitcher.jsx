import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { LANGUAGES } from '../../lib/i18n';
import { cn } from '../../lib/cn';
import Flag from './Flag';

/**
 * Compact language picker. Renders a glass pill that opens a popover with the
 * four supported locales. Choice is persisted by i18next-browser-languagedetector
 * under the `i18nextLng` localStorage key.
 */
const LanguageSwitcher = ({ className, align = 'right' }) => {
  const { i18n, t } = useTranslation('common');
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const current = LANGUAGES.find((l) => l.code === i18n.resolvedLanguage) || LANGUAGES[0];

  useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pick = (code) => {
    i18n.changeLanguage(code);
    setOpen(false);
  };

  return (
    <div ref={ref} className={cn('relative inline-block', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={t('language.switch')}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-2 h-9 px-3 rounded-xl text-xs font-medium tracking-tight',
          'surface text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]',
          'transition-colors'
        )}
      >
        <Flag code={current.code} />
        <span className="tabular">{current.short}</span>
        <ChevronDown className={cn('size-3 transition-transform duration-150', open && 'rotate-180')} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            role="listbox"
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.14, ease: [0.25, 1, 0.5, 1] }}
            className={cn(
              'absolute z-30 min-w-[190px] p-1 rounded-xl surface glow',
              align === 'right' ? 'right-0' : 'left-0',
              'top-full mt-2'
            )}
          >
            {LANGUAGES.map((l) => {
              const active = l.code === current.code;
              return (
                <li key={l.code}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={active}
                    onClick={() => pick(l.code)}
                    className={cn(
                      'w-full flex items-center justify-between gap-3 h-10 px-3 rounded-lg text-sm',
                      'transition-colors',
                      active
                        ? 'bg-[color-mix(in_oklch,var(--color-accent)_18%,transparent)] text-[color:var(--color-accent)]'
                        : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface-hover)]'
                    )}
                  >
                    <span className="flex items-center gap-2.5">
                      <Flag code={l.code} className="!w-[1.4em] !h-[1em]" />
                      <span>{l.label}</span>
                      <span className="text-[10px] font-medium tracking-[0.12em] tabular text-[color:var(--color-fg-subtle)]">
                        {l.short}
                      </span>
                    </span>
                    {active && <Check className="size-3.5" />}
                  </button>
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
};

export default LanguageSwitcher;
