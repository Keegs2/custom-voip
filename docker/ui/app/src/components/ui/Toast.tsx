// Stable convenience import path for the toast hook + its public types:
//   import { useToast } from '@/components/ui/Toast'
// (The ToastProvider component lives in ./ToastContext; the hook/context/types
// live in ./useToast so no file mixes component and non-component exports.)
export { useToast } from './useToast';
export type { ToastOptions, ToastVariant, ToastContextValue } from './useToast';
