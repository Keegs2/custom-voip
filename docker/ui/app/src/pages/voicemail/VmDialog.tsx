/**
 * VmDialog — the voicemail page's light (daylight) modal. Same mechanics as
 * DashboardOverlay: portal to <body> with `.dl-scope` on the root so every
 * `--rcf-*` token and `dl-*` primitive resolves, scroll lock with scrollbar
 * compensation, Esc / backdrop close (a press that STARTED on the backdrop
 * only), a Tab trap, and focus returned to the opener. Mounted only while
 * open. `busy` blocks Esc/backdrop close while a request is in flight.
 *
 * ConfirmDialog (below) is the small yes/no built on it, with an optional
 * typed confirmation for destructive actions.
 */
import { useCallback, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface VmDialogProps {
  title: string;
  sub?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Blocks Esc / backdrop close (a request is in flight). */
  busy?: boolean;
  width?: number;
  /** Danger tone for the top edge (destructive confirmations). */
  tone?: 'default' | 'danger';
}

export function VmDialog({ title, sub, onClose, children, footer, busy = false, width = 520, tone = 'default' }: VmDialogProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropPressRef = useRef(false);
  const busyRef = useRef(busy);
  const titleId = useId();
  const subId = useId();

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const { body, documentElement } = document;
    const prevOverflow = body.style.overflow;
    const prevPadding = body.style.paddingRight;
    const scrollbar = window.innerWidth - documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`;
    // First field if there is one, else the dialog itself.
    const first = dialogRef.current?.querySelector<HTMLElement>('[data-autofocus]');
    (first ?? dialogRef.current)?.focus({ preventScroll: true });
    return () => {
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPadding;
      if (opener && opener.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        if (!busyRef.current) onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
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

  const onBackdropDown = useCallback((e: MouseEvent<HTMLDivElement>) => {
    backdropPressRef.current = e.target === e.currentTarget;
  }, []);
  const onBackdropClick = useCallback(
    (e: MouseEvent<HTMLDivElement>) => {
      if (backdropPressRef.current && e.target === e.currentTarget && !busyRef.current) onClose();
      backdropPressRef.current = false;
    },
    [onClose],
  );

  return createPortal(
    <div className="dl-scope vm-scope vm-dialog-root" onMouseDown={onBackdropDown} onClick={onBackdropClick}>
      <div
        ref={dialogRef}
        className={`vm-dialog${tone === 'danger' ? ' vm-dialog-danger' : ''}`}
        style={{ width: `min(${width}px, 100%)` }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={sub ? subId : undefined}
        tabIndex={-1}
      >
        <div className="vm-dialog-head">
          <div className="vm-dialog-id">
            <h2 id={titleId} className="vm-dialog-title">{title}</h2>
            {sub && <div id={subId} className="vm-dialog-sub">{sub}</div>}
          </div>
          <button
            type="button"
            className="vm-iconbtn"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            title="Close (Esc)"
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
        <div className="vm-dialog-body">{children}</div>
        {footer && <div className="vm-dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ─── ConfirmDialog ───────────────────────────────────────── */

export interface ConfirmDialogProps {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** Destructive styling (red button + edge). */
  danger?: boolean;
  /**
   * Typed confirmation: the confirm button stays disabled until the input
   * passes `matches`. `prompt` explains what to type.
   */
  typed?: { prompt: ReactNode; placeholder?: string; matches: (value: string) => boolean };
  pending: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  typed,
  pending,
  error,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [value, setValue] = useState('');
  const inputId = useId();
  const ready = !typed || typed.matches(value);

  return (
    <VmDialog
      title={title}
      onClose={onCancel}
      busy={pending}
      width={460}
      tone={danger ? 'danger' : 'default'}
      footer={
        <>
          <button type="button" className="dl-btn dl-btn-ghost" onClick={onCancel} disabled={pending}>
            Cancel
          </button>
          <button
            type="button"
            className={`dl-btn ${danger ? 'vm-btn-danger-solid' : 'dl-btn-primary'}`}
            onClick={onConfirm}
            disabled={!ready || pending}
            data-autofocus={typed ? undefined : true}
          >
            {pending && <span className="vm-spin vm-spin-light" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="vm-confirm-body">{body}</div>
      {typed && (
        <div className="vm-field">
          <label className="dl-flabel" htmlFor={inputId}>
            {typed.prompt}
          </label>
          <input
            id={inputId}
            className="dl-input dl-input-mono vm-input-full"
            value={value}
            placeholder={typed.placeholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && ready && !pending) onConfirm();
            }}
            data-autofocus
          />
        </div>
      )}
      {error && (
        <div className="dl-banner dl-banner-err vm-gap-top" role="alert">
          {error}
        </div>
      )}
    </VmDialog>
  );
}
