import { cn } from '../../lib/cn';

const SIZES = { sm: 'size-3', md: 'size-4', lg: 'size-6', xl: 'size-8' };

const Spinner = ({ size = 'md', className }) => (
  <span
    className={cn(
      'inline-block rounded-full border-2 border-current border-t-transparent animate-spin-slow',
      SIZES[size],
      className
    )}
    aria-hidden
  />
);

export default Spinner;
