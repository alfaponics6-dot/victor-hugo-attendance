import { forwardRef } from 'react';
import { cn } from '../../lib/cn';

const baseField =
  'w-full h-10 px-3 rounded-xl text-sm font-sans ' +
  'bg-[color:var(--color-bg-2)] border border-[color:var(--color-border)] ' +
  'placeholder:text-[color:var(--color-fg-subtle)] ' +
  'transition-[border-color,box-shadow,background] duration-150 ease-out ' +
  'hover:border-[color:var(--color-border-strong)] ' +
  'focus:outline-none focus:border-[color:var(--color-accent)] ' +
  'focus:shadow-[0_0_0_3px_color-mix(in_oklch,var(--color-accent)_18%,transparent)] ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

export const Input = forwardRef(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(baseField, className)} {...props} />;
});

export const Textarea = forwardRef(function Textarea({ className, rows = 3, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(baseField, 'h-auto py-2 leading-relaxed resize-y', className)}
      {...props}
    />
  );
});

export const Select = forwardRef(function Select({ className, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        baseField,
        'appearance-none cursor-pointer pr-9 ' +
          'bg-[image:linear-gradient(45deg,transparent_50%,var(--color-fg-muted)_50%),linear-gradient(135deg,var(--color-fg-muted)_50%,transparent_50%)] ' +
          'bg-[position:calc(100%_-_18px)_50%,calc(100%_-_13px)_50%] bg-[size:5px_5px,5px_5px] bg-no-repeat',
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
});

export const Label = ({ className, ...p }) => (
  <label className={cn('block text-xs font-medium text-[color:var(--color-fg-muted)] mb-1.5 tracking-wide', className)} {...p} />
);

export default Input;
