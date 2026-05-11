import { cn } from '../../lib/cn';

const Skeleton = ({ className, ...props }) => (
  <div
    className={cn(
      'rounded-md bg-[linear-gradient(110deg,color-mix(in_oklch,var(--color-fg-subtle)_8%,transparent)_8%,color-mix(in_oklch,var(--color-fg-subtle)_18%,transparent)_18%,color-mix(in_oklch,var(--color-fg-subtle)_8%,transparent)_33%)]',
      'bg-[length:200%_100%] [animation:shimmer_1.4s_linear_infinite]',
      className
    )}
    {...props}
  />
);

export default Skeleton;
