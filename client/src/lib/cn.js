import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

// Standard className composer: drops falsy classes, dedupes Tailwind conflicts.
export const cn = (...inputs) => twMerge(clsx(inputs));
