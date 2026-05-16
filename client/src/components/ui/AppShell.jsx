import { motion } from 'motion/react';
import { cn } from '../../lib/cn';

/**
 * Shared page chrome: fixed-width centered column with subtle entrance fade.
 * Pages use this so spacing/typography stay consistent across views.
 */
const AppShell = ({ className, children }) => (
  <motion.main
    initial={{ opacity: 0, y: 6 }}
    animate={{ opacity: 1, y: 0 }}
    transition={{ duration: 0.35, ease: [0.25, 1, 0.5, 1] }}
    className={cn(
      'mx-auto w-full max-w-[1480px] px-4 py-5 sm:px-6 sm:py-6 lg:px-10 lg:py-8',
      className
    )}
  >
    {children}
  </motion.main>
);

export const PageHeader = ({ title, subtitle, eyebrow, actions, className }) => (
  <header
    className={cn(
      'flex flex-col gap-3 sm:gap-4 mb-6 sm:mb-8 lg:flex-row lg:items-end lg:justify-between',
      className
    )}
  >
    <div className="space-y-1 min-w-0">
      {eyebrow && (
        <div className="text-[10px] sm:text-[11px] font-medium uppercase tracking-[0.16em] text-[color:var(--color-fg-subtle)] truncate">
          {eyebrow}
        </div>
      )}
      <h1 className="text-2xl sm:text-[1.65rem] font-semibold tracking-tight leading-tight text-balance">
        {title}
      </h1>
      {subtitle && (
        <p className="text-xs sm:text-sm text-[color:var(--color-fg-muted)] max-w-xl">{subtitle}</p>
      )}
    </div>
    {actions && (
      <div className="flex flex-wrap items-center gap-2 sm:gap-3 lg:shrink-0">{actions}</div>
    )}
  </header>
);

export const SectionTitle = ({ children, className, action }) => (
  <div className={cn('flex items-end justify-between gap-3 mb-3 mt-4 sm:mt-6', className)}>
    <h2 className="text-xs sm:text-[13px] font-medium uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)]">
      {children}
    </h2>
    {action && <div className="shrink-0">{action}</div>}
  </div>
);

export default AppShell;
