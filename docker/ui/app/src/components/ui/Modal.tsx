import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { cn } from '../../utils/cn';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  /** Max width class, defaults to max-w-lg */
  maxWidth?: string;
}

export function Modal({ open, onClose, title, children, footer, maxWidth = 'max-w-lg' }: ModalProps) {
  // Close on Escape key
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onClose]);

  // Prevent body scroll while modal is open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/65 backdrop-blur-sm animate-modal-backdrop"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel */}
      <div
        className={cn(
          'relative w-full rounded-2xl overflow-hidden',
          'flex flex-col max-h-[90vh]',
          'animate-modal-panel',
          maxWidth,
        )}
        style={{
          background: 'linear-gradient(180deg, #1c1f2b 0%, #15171f 100%)',
          border: '1px solid rgba(59,130,246,0.14)',
          boxShadow:
            'inset 0 1px 0 rgba(255,255,255,0.05), 0 0 0 1px rgba(0,0,0,0.4), 0 24px 60px -12px rgba(0,0,0,0.7), 0 8px 24px -8px rgba(0,0,0,0.5)',
        }}
      >
        {/* Inner top highlight + accent hairline */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 h-px"
          style={{
            background:
              'linear-gradient(90deg, transparent, rgba(59,130,246,0.55), transparent)',
          }}
        />

        {/* Header */}
        <div className="flex items-center justify-between gap-4 px-6 py-5 border-b border-[#2a2f45]/70">
          <h2 className="text-[1.125rem] font-bold text-[#e2e8f0] tracking-[-0.01em] leading-tight">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className={cn(
              'flex-shrink-0 inline-flex items-center justify-center',
              'w-8 h-8 rounded-lg text-[#718096]',
              'transition-colors duration-150',
              'hover:bg-white/[0.06] hover:text-[#e2e8f0]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6]/50',
            )}
            aria-label="Close modal"
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end gap-3 px-6 py-5 border-t border-[#2a2f45]/70">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
