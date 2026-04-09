import { clsx, type ClassValue } from 'clsx';

/**
 * Merges class names using clsx.
 * Handles strings, arrays, objects, and falsy values gracefully.
 */
export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
