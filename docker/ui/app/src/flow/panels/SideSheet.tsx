/**
 * SideSheet — the builder's right-hand overlay for Publish, Test call and
 * Version history. It covers the inspector, not the canvas, so the flow
 * stays visible (the test call highlights blocks as it steps). Non-modal
 * dialog semantics: focus moves in on open and back to the opener on
 * close; Esc closes (unless `busy`).
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

export interface SideSheetProps {
  title: string;
  sub?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
}

export function SideSheet({ title, sub, onClose, busy = false, children, footer, icon }: SideSheetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const busyRef = useRef(busy);
  const closeRef = useRef(onClose);
  useEffect(() => {
    busyRef.current = busy;
    closeRef.current = onClose;
  });

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = ref.current?.querySelector<HTMLElement>('[data-autofocus]');
    (first ?? ref.current)?.focus({ preventScroll: true });
    return () => {
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // A dialog opened from the sheet handles its own Esc first.
      if (document.querySelector('.vm-dialog-root')) return;
      if (!busyRef.current) closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div ref={ref} className="ivr-sheet" role="dialog" aria-modal="false" aria-labelledby={titleId} tabIndex={-1}>
      <div className="ivr-sheet-head">
        {icon && <span className="ivr-sheet-icon">{icon}</span>}
        <div className="ivr-sheet-titles">
          <h2 id={titleId} className="ivr-sheet-title">
            {title}
          </h2>
          {sub && <div className="ivr-sheet-sub">{sub}</div>}
        </div>
        <button type="button" className="vm-iconbtn" onClick={onClose} disabled={busy} aria-label={`Close ${title}`} title="Close (Esc)">
          <X size={15} aria-hidden="true" />
        </button>
      </div>
      <div className="ivr-sheet-body">{children}</div>
      {footer && <div className="ivr-sheet-foot">{footer}</div>}
    </div>
  );
}
