import { forwardRef } from 'react';
import { cn } from '../../lib/cn';

const VARIANTS = {
  primary:
    'bg-[color:var(--color-accent)] text-[oklch(0.18_0.02_260)] hover:brightness-110 ' +
    'shadow-[0_1px_0_oklch(100%_0_0/.18)_inset,0_8px_28px_-12px_color-mix(in_oklch,var(--color-accent)_60%,transparent)]',
  secondary:
    'surface text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface-hover)]',
  ghost:
    'bg-transparent text-[color:var(--color-fg-muted)] hover:bg-[color:var(--color-surface-hover)] hover:text-[color:var(--color-fg)]',
  outline:
    'bg-transparent hairline-strong text-[color:var(--color-fg)] hover:bg-[color:var(--color-surface-hover)]',
  danger:
    'bg-[color:var(--color-danger)] text-white hover:brightness-110',
  success:
    'bg-[color:var(--color-success)] text-[oklch(0.18_0.02_260)] hover:brightness-110',
};

const SIZES = {
  sm: 'h-8 px-3 text-xs',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-sm',
  icon: 'h-10 w-10 p-0',
};

const Button = forwardRef(function Button(
  { variant = 'primary', size = 'md', loading, className, children, disabled, ...props },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-xl font-medium tracking-tight',
        'transition-[background,color,transform,box-shadow] duration-150 ease-out',
        'active:scale-[0.98] disabled:opacity-50 disabled:pointer-events-none',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--color-accent)]',
        VARIANTS[variant],
        SIZES[size],
        className
      )}
      {...props}
    >
      {loading && (
        <span className="size-4 rounded-full border-2 border-current border-t-transparent animate-spin-slow" />
      )}
      {children}
    </button>
  );
});

export default Button;
