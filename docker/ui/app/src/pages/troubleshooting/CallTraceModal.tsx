/**
 * CallTraceModal — the per-call inspection panel of the Troubleshooting page.
 *
 * Replaces the old inline "expanded row" under the results table. Everything
 * that dropdown showed is here, in a large, deliberately-outlined panel that
 * reads as separate from the page:
 *
 *   ┌─ head (fixed) ────────────────────────────────────────────────────────┐
 *   │ SIGNALING LADDER · Call 3 of 25            [Grafana] [‹ ›] [×]        │
 *   │ +1 (617) 454-4217 → +1 (774) 404-5256                                 │
 *   │ Started · Last msg · Result+attempts · STIR · Duration · Zone · …     │
 *   ├─ PCAP export strip (fixed) ───────────────────────────────────────────┤
 *   ├─ body (scrolls; keyed per call) ──────────────────────────────────────┤
 *   │ correlation notice · network path · <SipLadder> (+pipeline warnings,  │
 *   │ A/B Call-ID chips, filters, packet inspector)                         │
 *   └───────────────────────────────────────────────────────────────────────┘
 *
 * Mounted ONLY while open (the results table owns the selection), so all
 * open-time side effects — body scroll lock, initial focus, the document
 * key listener — are plain mount/unmount effects. Rendered through a portal
 * to document.body so the full-screen page's stacking/overflow can't clip
 * it; the portal root carries `.dl-scope` so the `--rcf-*` tokens and the
 * shared `dl-*` primitives resolve exactly as they do on the page.
 *
 * Keyboard: Esc closes · ←/→ step to the previous/next call on the current
 * results page (ignored while typing in a field, while text is selected, or
 * inside the packet inspector, which marks itself `data-trace-keys="local"`)
 * · Tab is trapped inside the panel. Focus RETURN to the originating row is
 * the owner's job (it knows which row is current after stepping).
 */
import { useCallback, useEffect, useId, useMemo, useRef, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import { SipLadder } from '../../components/sip-ladder';
import { PcapExportControl } from '../../components/pcap/PcapExportControl';
import type { CallGroup, CorrelationNotice } from './callGrouping';
import {
  buildGrafanaLink,
  carrierEndpointLabel,
  deriveCarrierEndpoints,
  deriveZone,
  displayUser,
  fmtCallDuration,
  fmtCompactTs,
} from './callDisplay';
import {
  AttemptsBadge,
  AttestationBadge,
  CorrelationBanner,
  ExternalIcon,
  StatusPill,
  ZonePill,
} from './CallBadges';

export type StepDirection = -1 | 1;

export interface CallTraceModalProps {
  /** The call being inspected. */
  group: CallGroup;
  /** 0-based position of `group` in the current results page. */
  position: number;
  /** Number of calls on the current results page (for "Call N of M" + bounds). */
  total: number;
  /** Pipeline diagnostics from the API — rendered by the ladder as ⓘ chips. */
  pipelineWarnings: string[];
  /** Search-level leg-correlation warning, repeated here for context. */
  correlationNotice: CorrelationNotice | null;
  /** The COMMITTED search window — Grafana-link fallback. */
  windowStartIso: string;
  windowEndIso: string;
  onClose: () => void;
  onStep: (direction: StepDirection) => void;
}

/** Ladder scroll-region cap inside the panel: the 92vh panel minus its fixed
 *  head + PCAP strip + the ladder's own filter bar, floored for short screens.
 *  The ladder keeps its OWN vertical scroller so its sticky participant
 *  header stays pinned while long dialogs scroll. */
const LADDER_MAX_HEIGHT = 'max(340px, calc(92vh - 330px))';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** True when ←/→ belong to the focused element (text entry, the packet
 *  inspector's raw text) rather than to call stepping. */
function arrowKeysAreLocal(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return target.closest('[data-trace-keys="local"]') !== null;
}

function hasTextSelection(): boolean {
  const sel = window.getSelection();
  return sel !== null && !sel.isCollapsed && sel.toString().length > 0;
}

export function CallTraceModal({
  group,
  position,
  total,
  pipelineWarnings,
  correlationNotice,
  windowStartIso,
  windowEndIso,
  onClose,
  onStep,
}: CallTraceModalProps) {
  // ── ALL hooks unconditionally at the top (React #310 — see CLAUDE.md §13) ──
  const dialogRef = useRef<HTMLDivElement>(null);
  const backdropPressRef = useRef(false);
  const titleId = useId();

  const hasPrev = position > 0;
  const hasNext = position < total - 1;

  // Per-call derivations — only for the ONE open call (the table no longer
  // computes Grafana windows for every row).
  const details = useMemo(() => {
    const row = group.representative;
    const last = group.messages.length > 0 ? group.messages[group.messages.length - 1] : row;
    return {
      row,
      lastTimestamp: last.timestamp,
      endpoints: deriveCarrierEndpoints(group.messages),
      zone: deriveZone(group.messages),
      grafanaLink: buildGrafanaLink(group, windowStartIso, windowEndIso),
    };
  }, [group, windowStartIso, windowEndIso]);

  // Body scroll lock + initial focus — once per open (mount), restored on
  // close. Scrollbar width is compensated so the page doesn't jump sideways.
  useEffect(() => {
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
    };
  }, []);

  // Document-level keys while open: Esc, ←/→ stepping, Tab trap.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (arrowKeysAreLocal(e.target) || hasTextSelection()) return;
        e.preventDefault();
        onStep(e.key === 'ArrowLeft' ? -1 : 1);
        return;
      }

      if (e.key === 'Tab') {
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
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, onStep]);

  // Backdrop click closes — but only a press that STARTED on the backdrop, so
  // a text selection dragged out of the panel never dismisses it.
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

  // ── Derived values (after all hooks) ──
  const { row, lastTimestamp, endpoints, zone, grafanaLink } = details;
  const legCount = group.callIds.length;

  return createPortal(
    <div
      className="dl-scope dlx5-modal-root"
      onMouseDown={handleBackdropDown}
      onClick={handleBackdropClick}
    >
      <div
        ref={dialogRef}
        className="dlx5-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        {/* ── Fixed head: identity, actions, call facts ───────────────── */}
        <div className="dlx5-modal-head">
          <div className="dlx5-modal-toprow">
            <div className="dlx5-modal-id">
              <div className="dlx5-modal-eyebrow">
                <span>Signaling Ladder</span>
                <span className="dlx5-modal-eyebrow-sep" aria-hidden="true">/</span>
                <span>
                  Call {position + 1} of {total}
                </span>
              </div>
              <h2 id={titleId} className="dlx5-modal-title">
                <span className="dlx5-modal-party">{displayUser(row.from_user)}</span>
                <span className="dlx5-modal-arrow" aria-label="to">→</span>
                <span className="dlx5-modal-party dlx5-modal-party-to">{displayUser(row.to_user)}</span>
              </h2>
            </div>

            <div className="dlx5-modal-actions">
              <a
                className="dlx5-frame-link dlx5-modal-grafana"
                href={grafanaLink}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalIcon size={12} />
                Open in Grafana
              </a>
              <div className="dlx5-modal-stepper" role="group" aria-label="Step through calls">
                <button
                  type="button"
                  className="dlx5-modal-iconbtn"
                  onClick={() => onStep(-1)}
                  disabled={!hasPrev}
                  aria-label="Previous call"
                  title="Previous call (←)"
                >
                  <ChevronIcon direction="left" />
                </button>
                <button
                  type="button"
                  className="dlx5-modal-iconbtn"
                  onClick={() => onStep(1)}
                  disabled={!hasNext}
                  aria-label="Next call"
                  title="Next call (→)"
                >
                  <ChevronIcon direction="right" />
                </button>
              </div>
              <button
                type="button"
                className="dlx5-modal-iconbtn dlx5-modal-close"
                onClick={onClose}
                aria-label="Close call detail"
                title="Close (Esc)"
              >
                <CloseIcon />
              </button>
            </div>
          </div>

          <dl className="dlx5-modal-facts">
            <div className="dlx5-fact">
              <dt>Started</dt>
              <dd className="dlx5-fact-mono">{fmtCompactTs(row.timestamp)}</dd>
            </div>
            <div className="dlx5-fact">
              <dt>Last message</dt>
              <dd className="dlx5-fact-mono">{fmtCompactTs(lastTimestamp)}</dd>
            </div>
            <div className="dlx5-fact">
              <dt>Result</dt>
              <dd>
                <StatusPill status={group.finalStatus} />
                <AttemptsBadge attempts={group.attempts} />
              </dd>
            </div>
            <div className="dlx5-fact">
              <dt>Attestation</dt>
              <dd>
                <AttestationBadge attestation={group.attestation} />
              </dd>
            </div>
            <div className="dlx5-fact">
              <dt>Duration</dt>
              <dd className="dlx5-fact-num">
                {group.durationSec !== null ? fmtCallDuration(group.durationSec) : '—'}
              </dd>
            </div>
            <div className="dlx5-fact">
              <dt>Zone</dt>
              <dd>
                <ZonePill zone={zone} />
              </dd>
            </div>
            <div className="dlx5-fact">
              <dt>Orig</dt>
              <dd className="dlx5-fact-mono" title={endpoints.orig ?? 'No externally-sourced INVITE captured'}>
                {endpoints.orig !== null ? carrierEndpointLabel(endpoints.orig) : '—'}
              </dd>
            </div>
            <div className="dlx5-fact">
              <dt>Term</dt>
              <dd
                className="dlx5-fact-mono"
                title={endpoints.term ?? 'No terminating leg (inbound-only or failed call)'}
              >
                {endpoints.term !== null ? carrierEndpointLabel(endpoints.term) : '—'}
              </dd>
            </div>
            <div className="dlx5-fact">
              <dt>Legs</dt>
              <dd className="dlx5-fact-num" title={group.callIds.join('\n')}>
                {legCount} {legCount === 1 ? 'leg' : 'legs'} · {group.messages.length} msgs
              </dd>
            </div>
          </dl>
        </div>

        {/* PCAP export strip — keyed by the representative Call-ID so a
            different call NEVER inherits this call's "Show internal" toggle
            (default = edge-only, the externally-safe export). */}
        <PcapExportControl key={`pcap:${row.callid}`} callId={row.callid} />

        {/* ── Scrolling body — keyed per call: stepping resets the scroll
            position, the ladder's filters and its selected packet. ──── */}
        <div className="dlx5-modal-body" key={`body:${row.callid}`}>
          {correlationNotice !== null && (
            <div className="dlx5-modal-notice">
              <CorrelationBanner notice={correlationNotice} />
            </div>
          )}

          {/* Network Path — the ingress hop's endpoint aliases. */}
          <div className="dlx5-pathline" title="Network path — first captured hop of this call">
            <span className="dlx5-pathline-label">Network Path</span>
            {row.src_ip}
            <span className="dlx5-pathline-arrow" aria-hidden="true">→</span>
            {row.dst_ip}
          </div>

          {/* Group-scoped correlations: every leg of this call (A + each
              failover attempt) is linked however the API linked it. */}
          <SipLadder
            messages={group.messages}
            correlations={group.ladderCorrelations}
            pipelineWarnings={pipelineWarnings}
            maxScrollHeight={LADDER_MAX_HEIGHT}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Icons ───────────────────────────────────────────────────────────────────

function ChevronIcon({ direction }: { direction: 'left' | 'right' }) {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points={direction === 'left' ? '15 18 9 12 15 6' : '9 18 15 12 9 6'} />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width={15} height={15} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1={18} y1={6} x2={6} y2={18} />
      <line x1={6} y1={6} x2={18} y2={18} />
    </svg>
  );
}
