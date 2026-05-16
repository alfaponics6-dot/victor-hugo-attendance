import { motion } from 'motion/react';
import { useId, useRef } from 'react';
import { cn } from '../../lib/cn';

/**
 * Pill-style tab bar with sliding indicator. Pass `tabs` as
 * `[{ key, label, icon }]` and control via `value` / `onChange`.
 *
 * On phones we hide the labels (icon-only) and let the strip scroll
 * horizontally if it overflows. The container scrolls without scrollbar
 * chrome so the design stays tidy.
 *
 * Implements the WAI-ARIA Authoring Practices tab pattern:
 *   - Left/Right arrows move between tabs (wrapping)
 *   - Home/End jump to first/last tab
 *   - Only the active tab is in the Tab key order (tabIndex=0); inactive
 *     tabs are tabIndex=-1, focusable only via arrow keys.
 */
const Tabs = ({ tabs, value, onChange, className }) => {
  const layoutId = useId();
  const tablistRef = useRef(null);

  const handleKeyDown = (e, currentIndex) => {
    let nextIndex = -1;
    switch (e.key) {
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % tabs.length;
        break;
      case 'ArrowLeft':
        nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    const nextTab = tabs[nextIndex];
    if (!nextTab) return;
    onChange(nextTab.key);
    // Move DOM focus to the newly selected tab. Without this the user can
    // hear screen-reader changes but the focus ring stays on the previous
    // tab, which is confusing.
    const nextBtn = tablistRef.current?.querySelector(`[data-tab-key="${nextTab.key}"]`);
    nextBtn?.focus();
  };

  return (
    <div
      ref={tablistRef}
      role="tablist"
      className={cn(
        'inline-flex items-center gap-1 p-1 rounded-2xl surface',
        'max-w-full overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden',
        className
      )}
    >
      {tabs.map((t, index) => {
        const active = t.key === value;
        const Icon = t.icon;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            data-tab-key={t.key}
            aria-selected={active}
            aria-label={t.label}
            tabIndex={active ? 0 : -1}
            title={t.label}
            onClick={() => onChange(t.key)}
            onKeyDown={(e) => handleKeyDown(e, index)}
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
