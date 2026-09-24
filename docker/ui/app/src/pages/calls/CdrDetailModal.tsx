/**
 * CdrDetailModal — the centerpiece of the merged Calls & Quality page: one
 * centered daylight modal that unifies the old CDR expanded-row and the Call
 * Quality slide-out sheet.
 *
 * Layout (concise but deep — grouped, labeled, no walls of raw key/values):
 *   1. Header — From → To, direction/product/status pills, UUID (mono, small)
 *      with a copy button.
 *   2. Call quality (docs/CALL_QUALITY_ACCURACY_PLAN.md §C.3 / §E.4) — a
 *      header "Call quality: <grade> (worse direction)" from
 *      `call_quality_grade`, then TWO columns from `quality_by_direction`:
 *      "Caller's audio (what the callee heard)" = caller_audio (A row) and
 *      "Callee's audio (what the caller heard)" = callee_audio (answered
 *      carrier B row, null when none). Each shows grade pill, MOS, R, true
 *      loss % (+ lost packets), RFC 3550 jitter avg/max — or, when the
 *      direction wasn't graded, the reason (plain language for customers,
 *      technical wording for staff). Staff also get per-direction
 *      diagnostics (source, FS MOS, expected/reordered packets, SSRC
 *      changes, burst ratio). Rows without `quality_by_direction` (carrier B
 *      rows, an API that predates it) fall back to the row's own fields.
 *   3. Call Info — times, duration vs billable, zone/SBC, carrier, codecs,
 *      hangup cause + SIP code, SIP identities. STAFF also get the CDR A/B
 *      leg-split identity: Leg (A / B / legacy), Call ID (copyable) and, on
 *      carrier B rows, the bridge Attempt number, plus a "Show all legs of
 *      this call" action (staff only — the parent passes `onShowAllLegs`)
 *      that sets the list to Rows=All legs + call_id=<call_id ?? uuid>.
 *   4. STIR / SHAKEN — the shared <AttestationChain/> (handles its own
 *      404-for-old-rows case).
 *   5. RTP Detail — STAFF ONLY, collapsible (default closed): packet/byte
 *      counters both directions, and a "FreeSWITCH raw" block with FS's own
 *      values kept for traceability (do_mos MOS, quality %, legacy peak
 *      jitter std, autoflush/CNG skip counter, flaws, loss/burst rates).
 *      Those raw values are NOT the quality score and are never shown to
 *      customers.
 *   6. Billing — STAFF ONLY: rate, cost, margin (+ the admin Rate CDR write).
 *
 * Data: seeds from the table row for instant paint, then fetches the full
 * record via GET /v1/cdrs/{uuid} (react-query ['cdr', uuid]).
 *
 * Mechanics: Escape + backdrop click close, body scroll-lock (same idiom as
 * components/ui/Modal, rebuilt here in the daylight vocabulary —
 * dlx4-modal-* in dl-platform-b.css).
 */
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getCdr, rateCdr } from '../../api/cdrs';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/Toast';
import { AttestationChain } from '../../components/stir/AttestationChain';
import { fmt } from '../../utils/format';
import { carrierLabel, EMPTY } from './callsFormat';
import {
  MONO, INK_FAINT,
  gradeColor, gradeLabel, mosColor, rFactorColor, packetLossColor, jitterColor,
  qualityStatusReason,
  fmtDurationShort, fmtBytes,
} from './quality';
import type { ReasonAudience } from './quality';
import { GradePill } from './CallsTable';
import { fmtMinutes, hasExactDuration } from '../../utils/callDuration';
import type { Cdr, LegQuality } from '../../types/cdr';

// Dev-only grade-definition self-test (dead-code-eliminated in production).
if (import.meta.env.DEV) {
  void import('./quality.assert');
}

/** Minute-precision timestamp — tenant rows are floored to the minute. */
function fmtDateMinute(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function fmtDateFull(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

/** Zone derives from the sbc_id prefix ("{zone}-sbc-{n}"); legacy ids have none. */
function zoneOf(sbcId: string | null | undefined): string | null {
  const m = sbcId?.match(/^(east|west|central)-/);
  return m ? m[1] : null;
}

/* ── Small layout atoms ──────────────────────────────────────────────── */

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <p className="dlx4-subhead" style={{ margin: '0 0 10px' }}>{children}</p>;
}

interface InfoItemProps {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  /** Span the full info-grid width (user agent, long values). */
  wide?: boolean;
  accent?: string;
}

function InfoItem({ label, value, mono, wide, accent }: InfoItemProps) {
  return (
    <div style={wide ? { gridColumn: '1 / -1' } : undefined}>
      <span className="dlx-ilabel">{label}</span>
      <span
        className={mono ? 'dlx-ivalue dlx4-mono' : 'dlx-ivalue'}
        style={{
          ...(mono ? { fontSize: '0.78rem' } : null),
          ...(accent ? { color: accent, fontWeight: 700 } : null),
        }}
      >
        {value ?? '—'}
      </span>
    </div>
  );
}

/* ── Quality by direction ────────────────────────────────────────────── */

/** Build a direction block from a row's own columns (B rows / older API). */
function rowLegQuality(d: Cdr): LegQuality {
  return {
    quality_status: d.quality_status ?? null,
    quality_grade: d.quality_grade ?? null,
    mos: d.mos ?? null,
    r_factor: d.r_factor ?? null,
    packet_loss_pct: d.packet_loss_pct ?? null,
    packet_loss_count: d.packet_loss_count ?? null,
    jitter_avg_ms: d.jitter_avg_ms ?? null,
    jitter_max_ms: d.jitter_max_ms ?? null,
    burst_ratio: d.burst_ratio ?? null,
    inbound_media_ratio: d.inbound_media_ratio ?? null,
    uuid: d.uuid,
    quality_source: d.quality_source,
    packets_expected: d.packets_expected,
    packets_reordered: d.packets_reordered,
    ssrc_changes: d.ssrc_changes,
    fs_mos: d.fs_mos,
  };
}

function fmtNum(v: number | null | undefined, dp: number, unit = ''): string | null {
  return v != null ? `${v.toFixed(dp)}${unit}` : null;
}

interface DirectionPanelProps {
  title: string;
  subtitle: string;
  /** null = this direction has no row (e.g. no carrier leg). */
  leg: LegQuality | null;
  /** Shown when `leg` is null. */
  missingNote: string;
  isStaff: boolean;
}

function DirectionPanel({ title, subtitle, leg, missingNote, isStaff }: DirectionPanelProps) {
  const audience: ReasonAudience = isStaff ? 'staff' : 'customer';
  const rated = leg?.quality_status === 'rated';
  const reason = leg ? qualityStatusReason(leg.quality_status, audience) : null;

  return (
    <div className="dl-tile" style={{ flex: '1 1 280px', padding: '12px 14px', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div className="dl-tile-label">{title}</div>
          <div className="dl-tile-hint" style={{ marginTop: 2 }}>{subtitle}</div>
        </div>
        {leg && (
          <GradePill grade={leg.quality_grade} status={leg.quality_status} isStaff={isStaff} />
        )}
      </div>

      {!leg && (
        <p style={{ margin: '10px 0 0', fontSize: '0.78rem', color: 'var(--rcf-ink-dim)' }}>{missingNote}</p>
      )}

      {leg && reason && (
        <p
          role="note"
          style={{
            margin: '10px 0 0',
            fontSize: '0.78rem',
            fontWeight: leg.quality_status === 'no_rtp' ? 700 : 500,
            color: leg.quality_status === 'no_rtp' ? gradeColor('poor') : 'var(--rcf-ink-dim)',
          }}
        >
          {reason}
        </p>
      )}

      {leg && rated && (
        <div className="dlx-info-grid" style={{ marginTop: 10, gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
          <InfoItem label="MOS" value={fmtNum(leg.mos, 2)} mono accent={mosColor(leg.mos)} />
          <InfoItem label="R-Factor" value={fmtNum(leg.r_factor, 1)} mono accent={rFactorColor(leg.r_factor)} />
          <InfoItem
            label="Packet loss"
            value={
              leg.packet_loss_pct != null
                ? `${leg.packet_loss_pct.toFixed(2)}%${leg.packet_loss_count != null ? ` · ${leg.packet_loss_count.toLocaleString()} lost` : ''}`
                : null
            }
            mono
            accent={packetLossColor(leg.packet_loss_pct)}
          />
          <InfoItem
            label="Jitter avg / max"
            value={
              leg.jitter_avg_ms != null || leg.jitter_max_ms != null
                ? `${leg.jitter_avg_ms?.toFixed(1) ?? '—'} / ${leg.jitter_max_ms?.toFixed(1) ?? '—'} ms`
                : 'not measured'
            }
            mono
            accent={leg.jitter_avg_ms != null ? jitterColor(leg.jitter_avg_ms) : undefined}
          />
        </div>
      )}

      {leg && isStaff && (
        <div
          className="dlx-info-grid"
          style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--rcf-line)', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}
        >
          <InfoItem label="Status" value={leg.quality_status ?? 'NULL (pre-backfill)'} mono />
          <InfoItem label="Source" value={leg.quality_source ?? null} mono />
          <InfoItem label="Inbound media ratio" value={fmtNum(leg.inbound_media_ratio, 3)} mono />
          <InfoItem label="Burst ratio" value={fmtNum(leg.burst_ratio, 3)} mono />
          <InfoItem label="Packets expected" value={leg.packets_expected?.toLocaleString() ?? null} mono />
          <InfoItem label="Packets reordered" value={leg.packets_reordered?.toLocaleString() ?? null} mono />
          <InfoItem label="SSRC changes" value={leg.ssrc_changes?.toLocaleString() ?? null} mono />
          <InfoItem label="FS MOS (raw)" value={fmtNum(leg.fs_mos, 2)} mono />
        </div>
      )}
    </div>
  );
}

function RawGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="dlx4-subhead" style={{ color: INK_FAINT }}>{title}</p>
      <div className="dlx-info-grid" style={{ gridTemplateColumns: '1fr' }}>{children}</div>
    </div>
  );
}

/* ── Modal ───────────────────────────────────────────────────────────── */

interface CdrDetailModalProps {
  /** Row the operator clicked — seeds the modal for instant paint. */
  cdr: Cdr;
  onClose: () => void;
  /** Admin or support — Billing section renders only for staff. */
  isStaff: boolean;
  /** True admin — the Rate CDR write is admin-only (support gets 403). */
  isAdmin: boolean;
  /** Staff only: drill the list down to every row of this call. Omitted for
      tenants, which hides the action entirely. */
  onShowAllLegs?: (callId: string) => void;
}

export function CdrDetailModal({ cdr, onClose, isStaff, isAdmin, onShowAllLegs }: CdrDetailModalProps) {
  // ALL hooks unconditionally at the top — React #310 prevention.
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();
  const [rtpOpen, setRtpOpen] = useState(false);

  const { data: detail, isFetching } = useQuery({
    queryKey: ['cdr', cdr.uuid],
    queryFn: () => getCdr(cdr.uuid),
    initialData: cdr,
    staleTime: 30_000,
  });

  const rateMutation = useMutation({
    mutationFn: () => rateCdr(cdr.uuid),
    onSuccess: () => {
      toastOk('CDR rated successfully');
      void queryClient.invalidateQueries({ queryKey: ['cdr', cdr.uuid] });
      void queryClient.invalidateQueries({ queryKey: ['cdrs'] });
    },
    onError: (err: Error) => {
      toastErr(`Rating failed: ${err.message}`);
    },
  });

  // Close on Escape.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  // Body scroll-lock while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  const d = detail ?? cdr;
  const answered = d.answer_time != null;
  // Staff rows carry exact seconds; tenant rows only whole minutes.
  const exact = hasExactDuration(d);
  const zone = zoneOf(d.sbc_id);
  // Shared callsFormat mapping — same label as the table's Carrier column,
  // so the two can never drift. EMPTY folds to InfoItem's own em dash.
  const carrier = carrierLabel(d);

  // Quality by direction. A rows from the current API carry
  // `quality_by_direction`; B rows (null) and older payloads (undefined)
  // fall back to the row's own leg columns in the matching column.
  const isBRow = d.leg === 'B';
  const byDir = d.quality_by_direction;
  const callerAudio: LegQuality | null = byDir ? byDir.caller_audio : isBRow ? null : rowLegQuality(d);
  const calleeAudio: LegQuality | null = byDir ? byDir.callee_audio : isBRow ? rowLegQuality(d) : null;
  const audience: ReasonAudience = isStaff ? 'staff' : 'customer';
  const callGradeReason = qualityStatusReason(d.call_quality_status, audience);

  // Staff-only RTP / FreeSWITCH-raw section.
  const hasRtp =
    isStaff && (
      d.rtp_audio_in_raw_bytes != null || d.rtp_audio_out_raw_bytes != null ||
      d.rtp_audio_in_packet_count != null || d.rtp_audio_out_packet_count != null ||
      d.flaw_total != null || d.fs_mos != null || d.rtp_audio_in_skip_packet_count != null
    );

  async function copyText(value: string, what: string) {
    try {
      await navigator.clipboard.writeText(value);
      toastOk(`${what} copied`);
    } catch {
      toastErr('Copy failed');
    }
  }

  const legLabel =
    d.leg === 'A' ? 'A — call row'
      : d.leg === 'B' ? 'B — carrier attempt'
        : 'Legacy (pre-split)';

  return (
    <div
      className="dlx4-modal-backdrop"
      style={{ backdropFilter: 'blur(3px)' }}
      onClick={onClose}
      role="presentation"
    >
      {/* No dl-scope here — the modal renders inside the page's dl-scope
          subtree, so the --rcf-* vars inherit (dl-scope itself carries
          full-bleed canvas margins that would break a dialog). */}
      <div
        className="dlx4-modal"
        style={{ maxWidth: 860 }}
        role="dialog"
        aria-modal="true"
        aria-label="Call detail"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="dlx4-modal-head" style={{ alignItems: 'flex-start' }}>
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <span className="dlx4-modal-title" style={{ fontFamily: MONO, fontWeight: 600 }}>
                {fmt(d.caller_id) || d.caller_id || '—'}
              </span>
              <span aria-hidden="true" style={{ color: 'var(--rcf-ink-dim)', fontSize: '0.85rem' }}>→</span>
              <span className="dlx4-modal-title" style={{ fontFamily: MONO, fontWeight: 700, color: 'var(--rcf-azure-deep)' }}>
                {fmt(d.destination) || d.destination}
              </span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <span className={d.direction === 'inbound' ? 'dl-tag' : 'dl-tag dl-tag-slate'}>{d.direction}</span>
              <span className="dl-tag">{d.product_type.toUpperCase()}</span>
              <span className={answered ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
                {answered ? 'Answered' : 'Not answered'}
              </span>
              {isFetching && <Spinner size="xs" />}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, minWidth: 0 }}>
              <span
                className="dlx4-mono"
                style={{ fontSize: '0.68rem', color: 'var(--rcf-ink-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                title={d.uuid}
              >
                {d.uuid}
              </span>
              <button
                type="button"
                onClick={() => void copyText(d.uuid, 'UUID')}
                title="Copy UUID"
                aria-label="Copy call UUID"
                className="dlx4-pgbtn"
                style={{ height: 22, minWidth: 0, padding: '0 8px', fontSize: '0.64rem' }}
              >
                Copy
              </button>
            </div>
          </div>
          <button type="button" className="dlx4-modal-close" onClick={onClose} aria-label="Close call detail">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 12, height: 12 }}>
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </div>

        {/* ── Body ───────────────────────────────────────────────── */}
        <div className="dlx4-modal-body">
          {/* Call quality — worse direction header + both directions */}
          <section aria-label="Call quality" style={{ marginBottom: 20 }}>
            {!isBRow && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                <span className="dlx4-subhead" style={{ margin: 0 }}>
                  Call quality:{' '}
                  <span style={{ color: gradeColor(d.call_quality_grade) }}>
                    {d.call_quality_grade
                      ? gradeLabel(d.call_quality_grade, d.call_quality_status)
                      : 'Not graded'}
                  </span>
                  {d.call_quality_grade && (
                    <span style={{ color: 'var(--rcf-ink-dim)', fontWeight: 500 }}> (worse direction)</span>
                  )}
                </span>
                {d.call_mos != null && (
                  <span className="dlx4-mono" style={{ fontSize: '0.78rem', color: mosColor(d.call_mos) }}>
                    MOS {d.call_mos.toFixed(2)}
                  </span>
                )}
                {!d.call_quality_grade && callGradeReason && (
                  <span style={{ fontSize: '0.78rem', color: 'var(--rcf-ink-dim)' }}>{callGradeReason}</span>
                )}
                {isStaff && d.call_quality_leg && (
                  <span className="dl-tag dl-tag-slate" title="Which direction set the call grade">
                    set by {d.call_quality_leg === 'A' ? 'caller audio (A)' : 'callee audio (B)'}
                  </span>
                )}
              </div>
            )}
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <DirectionPanel
                title="Caller’s audio"
                subtitle="what the callee heard"
                leg={callerAudio}
                missingNote={isBRow ? 'Open the call row to see the caller’s audio.' : 'Not measured for this call.'}
                isStaff={isStaff}
              />
              <DirectionPanel
                title="Callee’s audio"
                subtitle="what the caller heard"
                leg={calleeAudio}
                missingNote={
                  isStaff
                    ? 'No answered carrier leg (on-net, trunk/API, or B row not ingested yet).'
                    : 'Not measured separately for this call.'
                }
                isStaff={isStaff}
              />
            </div>
          </section>

          {/* Call Info */}
          <SectionTitle>Call Info</SectionTitle>
          <div className="dlx-info-grid">
            <InfoItem label="Start" value={fmtDateFull(d.start_time)} />
            {/* Tenant rows carry minute-floored answer/end times (API
                tenant redaction) — render them at minute precision. */}
            <InfoItem label="Answered" value={exact ? fmtDateFull(d.answer_time) : fmtDateMinute(d.answer_time)} />
            <InfoItem label="Ended" value={exact ? fmtDateFull(d.end_time) : fmtDateMinute(d.end_time)} />
            <InfoItem
              label="Duration"
              value={
                exact
                  ? `${fmtDurationShort(d.duration_seconds ?? 0)}${isStaff && (d.billable_seconds ?? 0) > 0 ? ` · billable ${fmtDurationShort(d.billable_seconds ?? 0)}` : ''}`
                  : (d.duration_minutes ?? 0) > 0 ? `about ${fmtMinutes(d.duration_minutes)}` : '—'
              }
            />
            {isStaff && (
              <InfoItem label="Zone / SBC" value={d.sbc_id ? `${zone ?? '—'} · ${d.sbc_id}` : null} mono />
            )}
            {isStaff && <InfoItem label="Carrier" value={carrier === EMPTY ? null : carrier} />}
            <InfoItem
              label="Codec"
              value={
                d.read_codec || d.write_codec
                  ? (d.read_codec === d.write_codec || !d.write_codec
                      ? d.read_codec
                      : `${d.read_codec ?? '—'} / ${d.write_codec}`)
                  : null
              }
              mono
            />
            <InfoItem
              label="Hangup"
              value={
                d.hangup_cause
                  ? `${d.hangup_cause}${d.sip_code != null ? ` (SIP ${d.sip_code})` : ''}`
                  : d.sip_code != null ? `SIP ${d.sip_code}` : null
              }
              mono
              accent={d.hangup_cause === 'NORMAL_CLEARING' ? 'var(--rcf-green)' : d.hangup_cause ? 'var(--rcf-red)' : undefined}
            />
            {isStaff && d.traffic_grade && <InfoItem label="Traffic Grade" value={d.traffic_grade} />}
            {d.trunk_id && <InfoItem label="Trunk" value={d.trunk_id} mono />}
            {isStaff && d.network_addr && <InfoItem label="Network Addr" value={d.network_addr} mono />}
            {(d.sip_from_user || d.sip_to_user) && (
              <InfoItem
                label="SIP From / To"
                value={`${d.sip_from_user ?? '—'} → ${d.sip_to_user ?? '—'}`}
                mono
              />
            )}
            {isStaff && d.sip_user_agent && <InfoItem label="User Agent" value={d.sip_user_agent} mono wide />}
            {/* CDR A/B leg split — staff only (tenant rows carry no leg fields). */}
            {isStaff && <InfoItem label="Leg" value={legLabel} />}
            {isStaff && d.leg === 'B' && (
              <InfoItem label="Attempt" value={d.leg_attempt != null ? `#${d.leg_attempt}` : null} mono />
            )}
            {isStaff && (
              <InfoItem
                label="Call ID"
                wide
                value={
                  d.call_id ? (
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', minWidth: 0 }}>
                      <span
                        className="dlx4-mono"
                        style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                        title={d.call_id}
                      >
                        {d.call_id}
                      </span>
                      <button
                        type="button"
                        onClick={() => void copyText(d.call_id ?? '', 'Call ID')}
                        title="Copy Call ID"
                        aria-label="Copy call ID"
                        className="dlx4-pgbtn"
                        style={{ height: 22, minWidth: 0, padding: '0 8px', fontSize: '0.64rem', flex: 'none' }}
                      >
                        Copy
                      </button>
                    </span>
                  ) : null
                }
              />
            )}
          </div>

          {/* Staff drill-down: every row of this call (A + carrier B-legs). */}
          {isStaff && onShowAllLegs && (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="dl-btn dl-btn-ghost"
                onClick={() => onShowAllLegs(d.call_id ?? d.uuid)}
                title="Filter the list to this call's A-leg and every carrier attempt"
              >
                Show all legs of this call
              </button>
            </div>
          )}

          {/* STIR / SHAKEN */}
          <div className="dlx4-xsection">
            <SectionTitle>STIR / SHAKEN</SectionTitle>
            {/* Attestation is keyed by the CALL (A-leg uuid): a carrier B row
                resolves through its call_id; A / legacy / tenant rows fall
                back to their own uuid (== call_id on A rows). */}
            <AttestationChain callId={d.call_id ?? d.uuid} />
          </div>

          {/* RTP Detail — collapsible */}
          {hasRtp && (
            <div className="dlx4-xsection">
              <button
                type="button"
                onClick={() => setRtpOpen((o) => !o)}
                aria-expanded={rtpOpen}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  width: '100%',
                  padding: 0,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  textAlign: 'left',
                }}
              >
                {/* span (not SectionTitle's <p>) — buttons allow phrasing content only */}
                <span className="dlx4-subhead" style={{ display: 'block', margin: 0 }}>RTP Detail &amp; FreeSWITCH raw</span>
                <span
                  aria-hidden="true"
                  style={{
                    marginLeft: 'auto',
                    fontSize: '0.68rem',
                    color: 'var(--rcf-ink-dim)',
                    transition: 'transform 0.2s ease',
                    transform: rtpOpen ? 'rotate(0deg)' : 'rotate(-90deg)',
                  }}
                >
                  ▾
                </span>
              </button>

              {rtpOpen && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 18, marginTop: 12 }}>
                  {/* Packet/byte volume counters scale 1:1 with talk time (an
                      exact-duration proxy) — this whole section is staff-only. */}
                  <RawGroup title="Audio In (from carrier)">
                    <InfoItem label="Packets" value={d.rtp_audio_in_packet_count?.toLocaleString() ?? null} mono />
                    <InfoItem label="Raw / Media Bytes" value={`${fmtBytes(d.rtp_audio_in_raw_bytes)} / ${fmtBytes(d.rtp_audio_in_media_bytes)}`} mono />
                    {d.packet_total_count != null && (
                      <InfoItem label="Packets Total" value={d.packet_total_count.toLocaleString()} mono />
                    )}
                    {d.loss_bursts != null && (
                      <InfoItem label="Loss bursts" value={d.loss_bursts.toLocaleString()} mono />
                    )}
                  </RawGroup>
                  <RawGroup title="Audio Out (to carrier)">
                    <InfoItem label="Packets" value={d.rtp_audio_out_packet_count?.toLocaleString() ?? null} mono />
                    <InfoItem label="Raw / Media Bytes" value={`${fmtBytes(d.rtp_audio_out_raw_bytes)} / ${fmtBytes(d.rtp_audio_out_media_bytes)}`} mono />
                  </RawGroup>
                  {/* FS's own values — traceability only, NOT the quality score. */}
                  <RawGroup title="FreeSWITCH raw (this row)">
                    <InfoItem label="FS MOS (do_mos)" value={fmtNum(d.fs_mos, 2)} mono />
                    <InfoItem label="FS quality %" value={fmtNum(d.fs_quality_pct, 1, '%')} mono />
                    <InfoItem label="FS legacy peak jitter std (ms)" value={fmtNum(d.fs_jitter_max_std_ms, 2)} mono />
                    <InfoItem
                      label="Skipped (autoflush/CNG)"
                      value={d.rtp_audio_in_skip_packet_count?.toLocaleString() ?? null}
                      mono
                    />
                    {d.flaw_total != null && (
                      <InfoItem label="Flaw Total" value={d.flaw_total.toLocaleString()} mono />
                    )}
                    {d.rtp_audio_in_mean_interval != null && (
                      <InfoItem label="Mean Packet Interval" value={`${d.rtp_audio_in_mean_interval.toFixed(2)}ms`} mono />
                    )}
                    {d.rtp_audio_in_jitter_burst_rate != null && (
                      <InfoItem label="Jitter Burst Rate" value={d.rtp_audio_in_jitter_burst_rate.toFixed(4)} mono />
                    )}
                    {d.rtp_audio_in_jitter_loss_rate != null && (
                      <InfoItem label="Jitter Loss Rate" value={d.rtp_audio_in_jitter_loss_rate.toFixed(4)} mono />
                    )}
                  </RawGroup>
                </div>
              )}
            </div>
          )}

          {/* Billing — staff only (tenants never see money) */}
          {isStaff && (
            <div className="dlx4-xsection">
              <SectionTitle>Billing</SectionTitle>
              <div className="dlx-info-grid">
                <InfoItem
                  label="Rate / Min"
                  value={d.rate_per_min != null ? `$${d.rate_per_min.toFixed(4)}/min` : null}
                  mono
                />
                <InfoItem
                  label="Total Cost"
                  value={d.total_cost != null ? `$${d.total_cost.toFixed(4)}` : null}
                  mono
                  accent={d.total_cost != null && d.total_cost > 0 ? 'var(--rcf-azure-deep)' : undefined}
                />
                <InfoItem
                  label="Carrier Cost"
                  value={d.carrier_cost != null ? `$${d.carrier_cost.toFixed(4)}` : null}
                  mono
                />
                <InfoItem
                  label="Margin"
                  value={d.margin != null ? `$${d.margin.toFixed(4)}` : null}
                  mono
                  accent={
                    d.margin == null || d.margin === 0
                      ? undefined
                      : d.margin > 0 ? 'var(--rcf-green)' : 'var(--rcf-red)'
                  }
                />
                <InfoItem
                  label="Rated"
                  value={d.rated_at ? fmtDateFull(d.rated_at) : 'Unrated'}
                />
              </div>

              {/* Rating is a write — admin only (support gets 403 from the API). */}
              {isAdmin && d.rated_at == null && (
                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="dl-btn dlx-btn-ok"
                    disabled={rateMutation.isPending}
                    onClick={() => rateMutation.mutate()}
                  >
                    {rateMutation.isPending ? 'Rating…' : 'Rate CDR'}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
