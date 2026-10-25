import { useEffect, type ReactNode } from 'react';
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
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-[color:var(--t-scrim)] backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Panel — elevation 2: raised surface, hairline, modal shadow; the
          landing's azure keyline along the top edge on dark. */}
      <div
        className={cn(
          'relative w-full rounded-xl overflow-hidden',
          'bg-[color:var(--t-surface-raised)] text-[color:var(--t-text)] border border-[color:var(--t-line)]',
          'shadow-[var(--t-shadow-modal)]',
          'flex flex-col max-h-[90vh]',
          maxWidth,
        )}
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 left-[12%] right-[12%] h-px bg-[image:var(--t-keyline)]"
        />
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[color:var(--t-line)]">
          <h2 className="text-[1rem] font-bold text-[color:var(--t-text-strong)] tracking-[-0.2px]">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-[color:var(--t-text-dim)] hover:text-[color:var(--t-text)] hover:bg-[color:var(--t-hover)] transition-colors text-xl leading-none p-1 -mr-1 rounded"
            aria-label="Close modal"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5">
          {children}
        </div>

        {/* Footer */}
        {footer && (
          <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[color:var(--t-line)]">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
