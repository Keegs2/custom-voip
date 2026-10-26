/**
 * SideSheet — the builder's right-hand overlay for Publish, Test call,
 * Version history and the Flow assistant. It covers the inspector, not the
 * canvas, so the flow stays visible (the test call highlights blocks as it
 * steps). Non-modal dialog semantics: focus moves in on open and back to the
 * opener on close; Esc closes (unless `busy`).
 *
 * `fullscreen` (phone width, where there is no right column): the sheet
 * covers the screen instead, so it becomes MODAL — aria-modal, and Tab stays
 * inside it.
 */
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface SideSheetProps {
  title: string;
  sub?: ReactNode;
  onClose: () => void;
  busy?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  icon?: ReactNode;
  /** Cover the whole screen (phone width) as a modal sheet. */
  fullscreen?: boolean;
  /** Extra class on the sheet root (a panel's own layout tweaks). */
  className?: string;
}

export function SideSheet({ title, sub, onClose, busy = false, children, footer, icon, fullscreen = false, className }: SideSheetProps) {
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
      if (e.key === 'Tab' && fullscreen) {
        // Modal: keep Tab inside the sheet.
        const sheet = ref.current;
        if (!sheet) return;
        const items = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
        if (items.length === 0) return;
        const firstEl = items[0];
        const lastEl = items[items.length - 1];
        if (e.shiftKey && (document.activeElement === firstEl || document.activeElement === sheet)) {
          e.preventDefault();
          lastEl.focus();
        } else if (!e.shiftKey && document.activeElement === lastEl) {
          e.preventDefault();
          firstEl.focus();
        }
        return;
      }
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // A dialog opened from the sheet handles its own Esc first.
      if (document.querySelector('.vm-dialog-root')) return;
      if (!busyRef.current) closeRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const classes = ['ivr-sheet', fullscreen && 'ivr-sheet--full', className].filter(Boolean).join(' ');

  return (
    <div ref={ref} className={classes} role="dialog" aria-modal={fullscreen ? 'true' : 'false'} aria-labelledby={titleId} tabIndex={-1}>
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
