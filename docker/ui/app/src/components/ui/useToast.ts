/**
 * Toast context object + consumer hook + public types, split out of the
 * provider file (`ToastContext.tsx`) so component files export ONLY components
 * (react-refresh/only-export-components — FRONTEND_GLASS_REFACTOR.md §5.3).
 *
 * Import `useToast` from `@/components/ui/Toast` (the stable convenience
 * path); the provider stays in `./ToastContext`.
 */
import { createContext, useContext } from 'react';

export type ToastVariant = 'success' | 'error' | 'warning' | 'info';

export interface ToastOptions {
  title?: string;
  message: string;
  variant?: ToastVariant;
  duration?: number;
  persistent?: boolean;
  action?: {
    label: string;
    onClick: () => void;
  };
}

export interface ToastContextValue {
  toast: (options: ToastOptions) => void;
  toastOk: (message: string) => void;
  toastErr: (message: string) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}
