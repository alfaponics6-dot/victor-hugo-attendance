import { forwardRef } from 'react';
import { cn } from '../../lib/cn';

export const Card = forwardRef(function Card({ className, hover = false, ...props }, ref) {
  return (
    <div
      ref={ref}
      className={cn(
        'surface rounded-2xl p-5 transition-[transform,background,border-color] duration-200',
        hover && 'hover:-translate-y-0.5 hover:bg-[color:var(--color-surface-hover)] hover:border-[color:var(--color-border-strong)]',
        className
      )}
      {...props}
    />
  );
});

export const CardHeader = ({ className, ...p }) => (
  <div className={cn('flex items-start justify-between gap-3 mb-4', className)} {...p} />
);

export const CardTitle = ({ className, ...p }) => (
  <h3 className={cn('text-sm font-medium text-[color:var(--color-fg-muted)] tracking-wide uppercase', className)} {...p} />
);

export const CardValue = ({ className, ...p }) => (
  <div className={cn('text-3xl font-semibold tabular tracking-tight', className)} {...p} />
);

export const CardDescription = ({ className, ...p }) => (
  <p className={cn('text-xs text-[color:var(--color-fg-subtle)]', className)} {...p} />
);

export default Card;
