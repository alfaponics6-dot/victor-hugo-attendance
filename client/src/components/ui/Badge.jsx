import { cn } from '../../lib/cn';

const TONES = {
  default: 'bg-[color-mix(in_oklch,var(--color-fg-muted)_15%,transparent)] text-[color:var(--color-fg-muted)]',
  accent: 'bg-[color-mix(in_oklch,var(--color-accent)_18%,transparent)] text-[color:var(--color-accent)]',
  success: 'bg-[color-mix(in_oklch,var(--color-success)_18%,transparent)] text-[color:var(--color-success)]',
  warn: 'bg-[color-mix(in_oklch,var(--color-warn)_22%,transparent)] text-[color:var(--color-warn)]',
  danger: 'bg-[color-mix(in_oklch,var(--color-danger)_18%,transparent)] text-[color:var(--color-danger)]',
  outline: 'hairline text-[color:var(--color-fg-muted)]',
};

const Badge = ({ tone = 'default', className, children, ...props }) => (
  <span
    className={cn(
      'inline-flex items-center gap-1.5 px-2 h-6 rounded-md text-[11px] font-medium tracking-wide tabular',
      TONES[tone],
      className
    )}
    {...props}
  >
    {children}
  </span>
);

export default Badge;
