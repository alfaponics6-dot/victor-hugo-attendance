import { motion } from 'motion/react';
import { useId } from 'react';
import { cn } from '../../lib/cn';

/**
 * Pill-style tab bar with sliding indicator. Pass `tabs` as
 * `[{ key, label, icon }]` and control via `value` / `onChange`.
 *
 * On phones we hide the labels (icon-only) and let the strip scroll
 * horizontally if it overflows. The container scrolls without scrollbar
 * chrome so the design stays tidy.
 */
const Tabs = ({ tabs, value, onChange, className }) => {
  const layoutId = useId();
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex items-center gap-1 p-1 rounded-2xl surface',
        'max-w-full overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
        className
      )}
    >
      {tabs.map((t) => {
        const active = t.key === value;
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            role="tab"
            aria-selected={active}
            aria-label={t.label}
            title={t.label}
            onClick={() => onChange(t.key)}
            className={cn(
              'relative inline-flex shrink-0 items-center gap-2 h-10 px-3 sm:h-9 sm:px-4 rounded-xl text-sm font-medium tracking-tight',
              'transition-colors duration-150',
              active
                ? 'text-[oklch(0.18_0.02_260)]'
                : 'text-[color:var(--color-fg-muted)] hover:text-[color:var(--color-fg)]'
            )}
          >
            {active && (
              <motion.span
                layoutId={`tabs-pill-${layoutId}`}
                className="absolute inset-0 bg-[color:var(--color-accent)] rounded-xl"
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
              />
            )}
            <span className="relative flex items-center gap-2">
              {Icon && <Icon className="size-4 shrink-0" />}
              <span className="hidden sm:inline">{t.label}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
};

export default Tabs;
