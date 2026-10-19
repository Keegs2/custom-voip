/**
 * DashboardOverlay — the large panel the customer views (/dashboard, the
 * customer /rcf page) open for the deep tools they do not rebuild (full
 * Call Activity, number management).
 *
 * Follows the CallTraceModal pattern: portal to document.body (so the page's
 * stacking/overflow can't clip it), the portal root carries `.rcf-scope` so
 * every `--rcf-*` token and `.rcf-*` primitive the hosted component uses
 * resolves exactly as on the page, body scroll lock with scrollbar
 * compensation, Esc / backdrop close (only a press that STARTED on the
 * backdrop), a Tab trap, and focus returned to whatever opened it.
 *
 * Mounted only while open, so every open-time effect is a plain mount /
 * unmount effect.
 */
import { useCallback, useEffect, useId, useRef, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import '../../styles/rcf-dashboard.css';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface DashboardOverlayProps {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}

export function DashboardOverlay({ title, subtitle, onClose, children }: DashboardOverlayProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropPressRef = useRef(false);
  const titleId = useId();
  const subtitleId = useId();

  // Scroll lock + initial focus on open; restore both (and the opener's
  // focus) on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { body, documentElement } = document;
    const prevOverflow = body.style.overflow;
    const prevPaddingRight = body.style.paddingRight;
    const scrollbarWidth = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbarWidth > 0) body.style.paddingRight = `${scrollbarWidth}px`;
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPaddingRight;
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  // Esc closes; Tab stays inside the panel.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (focusables.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const outside = !(active instanceof Node) || !dialog.contains(active);
      if (e.shiftKey && (active === first || active === dialog || outside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || outside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const handleBackdropDown = useCallback((e: MouseEvent<HTMLDivElement>) => {
    backdropPressRef.current = e.target === e.currentTarget;
  }, []);
  const handleBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (backdropPressRef.current && e.target === e.currentTarget) onClose();
      backdropPressRef.current = false;
    },
    [onClose],
  );

  return createPortal(
    <div className="rcf-scope rcfd-overlay-root" onMouseDown={handleBackdropDown} onClick={handleBackdropClick}>
      <div
        ref={dialogRef}
        className="rcfd-overlay"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
      >
        <div className="rcfd-overlay-head">
          <div className="rcfd-overlay-id">
            <h2 id={titleId} className="rcfd-overlay-title">{title}</h2>
            {subtitle && <p id={subtitleId} className="rcfd-overlay-sub">{subtitle}</p>}
          </div>
          <button type="button" className="rcfd-iconbtn" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="rcfd-overlay-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
