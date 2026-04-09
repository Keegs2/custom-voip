import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Merges class names using clsx + tailwind-merge.
 * Handles strings, arrays, objects, and falsy values gracefully.
 * tailwind-merge ensures conflicting Tailwind classes are resolved correctly.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
