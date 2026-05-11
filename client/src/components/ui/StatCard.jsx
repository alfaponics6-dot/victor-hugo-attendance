import { motion } from 'motion/react';
import { cn } from '../../lib/cn';
import Card from './Card';

/**
 * Dashboard-style stat tile with optional trend indicator and icon glyph.
 * Numbers are animated via Motion when `value` changes.
 */
const StatCard = ({
  label,
  value,
  unit,
  hint,
  icon: Icon,
  tone = 'default',
  trend,
  className,
}) => {
  const accentByTone = {
    default: 'var(--color-accent)',
    success: 'var(--color-success)',
    warn: 'var(--color-warn)',
    danger: 'var(--color-danger)',
  };
  const accent = accentByTone[tone] || accentByTone.default;

  return (
    <Card hover className={cn('relative overflow-hidden group', className)}>
      <div
        aria-hidden
        className="absolute -top-24 -right-24 w-56 h-56 rounded-full opacity-30 blur-3xl pointer-events-none transition-opacity group-hover:opacity-50"
        style={{ background: `radial-gradient(circle, ${accent}, transparent 60%)` }}
      />
      <div className="relative flex items-start justify-between">
        <div className="space-y-1.5">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.12em] text-[color:var(--color-fg-subtle)]">
            {Icon && <Icon className="size-3.5" />}
            {label}
          </div>
          <motion.div
            key={String(value)}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.35, ease: [0.25, 1, 0.5, 1] }}
            className="flex items-baseline gap-1.5"
          >
            <span className="text-[2.25rem] leading-none font-semibold tabular tracking-tight">
              {value}
            </span>
            {unit && (
              <span className="text-sm font-medium text-[color:var(--color-fg-subtle)]">{unit}</span>
            )}
          </motion.div>
          {hint && (
            <div className="text-xs text-[color:var(--color-fg-muted)]">{hint}</div>
          )}
        </div>
        {trend && (
          <div
            className={cn(
              'inline-flex items-center gap-1 rounded-md px-2 h-6 text-[11px] font-medium tabular',
              trend.dir === 'up' && 'bg-[color-mix(in_oklch,var(--color-success)_18%,transparent)] text-[color:var(--color-success)]',
              trend.dir === 'down' && 'bg-[color-mix(in_oklch,var(--color-danger)_18%,transparent)] text-[color:var(--color-danger)]',
              trend.dir === 'flat' && 'bg-[color-mix(in_oklch,var(--color-fg-muted)_15%,transparent)] text-[color:var(--color-fg-muted)]'
            )}
          >
            {trend.dir === 'up' ? '▲' : trend.dir === 'down' ? '▼' : '─'} {trend.value}
          </div>
        )}
      </div>
    </Card>
  );
};

export default StatCard;
