/**
 * CdrDetailModal — the centerpiece of the merged Calls & Quality page: one
 * centered daylight modal that unifies the old CDR expanded-row and the Call
 * Quality slide-out sheet.
 *
 * Layout (concise but deep — grouped, labeled, no walls of raw key/values):
 *   1. Header — From → To, direction/product/status pills, UUID (mono, small)
 *      with a copy button.
 *   2. Hero quality tiles — MOS / R-Factor / Quality % / Loss % / Jitter,
 *      status-colored.
 *   3. Call Info — times, duration vs billable, zone/SBC, carrier, codecs,
 *      hangup cause + SIP code, SIP identities.
 *   4. STIR / SHAKEN — the shared <AttestationChain/> (handles its own
 *      404-for-old-rows case).
 *   5. RTP Detail — collapsible (default closed): packet/byte counters both
 *      directions, jitter floor/peak/avg, burst/loss rates, flaw total.
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
  mosColor, rFactorColor, packetLossColor, jitterColor, qualityPctColor,
  fmtDurationShort, fmtBytes,
} from './quality';
import type { Cdr } from '../../types/cdr';

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

interface HeroTileProps {
  label: string;
  value: string;
  sub?: string;
  color: string;
}

function HeroTile({ label, value, sub, color }: HeroTileProps) {
  return (
    <div className="dl-tile" style={{ flex: '1 1 110px', padding: '12px 14px' }}>
      <div className="dl-tile-label">{label}</div>
      <div className="dl-tile-value" style={{ color, fontSize: '1.4rem' }}>{value}</div>
      {sub && <div className="dl-tile-hint">{sub}</div>}
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
}

export function CdrDetailModal({ cdr, onClose, isStaff, isAdmin }: CdrDetailModalProps) {
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
  const zone = zoneOf(d.sbc_id);
  // Shared callsFormat mapping — same label as the table's Carrier column,
  // so the two can never drift. EMPTY folds to InfoItem's own em dash.
  const carrier = carrierLabel(d);

  const hasQuality =
    d.mos != null || d.r_factor != null || d.quality_pct != null ||
    d.packet_loss_pct != null || d.jitter_avg_ms != null;
  const hasRtp =
    d.rtp_audio_in_raw_bytes != null || d.rtp_audio_out_raw_bytes != null ||
    d.rtp_audio_in_packet_count != null || d.rtp_audio_out_packet_count != null ||
    d.jitter_avg_ms != null || d.flaw_total != null;

  async function copyUuid() {
    try {
      await navigator.clipboard.writeText(d.uuid);
      toastOk('UUID copied');
    } catch {
      toastErr('Copy failed');
    }
  }

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
                onClick={() => void copyUuid()}
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
          {/* Hero quality tiles */}
          {hasQuality && (
            <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
              <HeroTile
                label="MOS"
                value={d.mos != null ? d.mos.toFixed(2) : '—'}
                sub={d.mos != null ? (d.mos >= 4.0 ? 'Excellent' : d.mos >= 3.5 ? 'Good' : 'Poor') : undefined}
                color={mosColor(d.mos)}
              />
              <HeroTile
                label="R-Factor"
                value={d.r_factor != null ? d.r_factor.toFixed(1) : '—'}
                sub={d.r_factor != null ? (d.r_factor >= 80 ? 'Good' : d.r_factor >= 60 ? 'Fair' : 'Poor') : undefined}
                color={rFactorColor(d.r_factor)}
              />
              <HeroTile
                label="Quality"
                value={d.quality_pct != null ? `${d.quality_pct.toFixed(1)}%` : '—'}
                color={qualityPctColor(d.quality_pct)}
              />
              <HeroTile
                label="Packet Loss"
                value={d.packet_loss_pct != null ? `${d.packet_loss_pct.toFixed(2)}%` : '—'}
                color={packetLossColor(d.packet_loss_pct)}
              />
              <HeroTile
                label="Jitter (est)"
                value={d.jitter_avg_ms != null ? `${d.jitter_avg_ms.toFixed(1)}ms` : '—'}
                color={jitterColor(d.jitter_avg_ms)}
              />
            </div>
          )}

          {/* Call Info */}
          <SectionTitle>Call Info</SectionTitle>
          <div className="dlx-info-grid">
            <InfoItem label="Start" value={fmtDateFull(d.start_time)} />
            <InfoItem label="Answered" value={fmtDateFull(d.answer_time)} />
            <InfoItem label="Ended" value={fmtDateFull(d.end_time)} />
            <InfoItem
              label="Duration"
              value={`${fmtDurationShort(d.duration_seconds)}${d.billable_seconds > 0 ? ` · billable ${fmtDurationShort(d.billable_seconds)}` : ''}`}
            />
            <InfoItem label="Zone / SBC" value={d.sbc_id ? `${zone ?? '—'} · ${d.sbc_id}` : null} mono />
            <InfoItem label="Carrier" value={carrier === EMPTY ? null : carrier} />
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
            {d.traffic_grade && <InfoItem label="Traffic Grade" value={d.traffic_grade} />}
            {d.trunk_id && <InfoItem label="Trunk" value={d.trunk_id} mono />}
            {d.network_addr && <InfoItem label="Network Addr" value={d.network_addr} mono />}
            {(d.sip_from_user || d.sip_to_user) && (
              <InfoItem
                label="SIP From / To"
                value={`${d.sip_from_user ?? '—'} → ${d.sip_to_user ?? '—'}`}
                mono
              />
            )}
            {d.sip_user_agent && <InfoItem label="User Agent" value={d.sip_user_agent} mono wide />}
          </div>

          {/* STIR / SHAKEN */}
          <div className="dlx4-xsection">
            <SectionTitle>STIR / SHAKEN</SectionTitle>
            <AttestationChain callId={d.uuid} />
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
                <span className="dlx4-subhead" style={{ display: 'block', margin: 0 }}>RTP Detail</span>
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
                  <div>
                    <p className="dlx4-subhead" style={{ color: INK_FAINT }}>Audio In (from carrier)</p>
                    <div className="dlx-info-grid" style={{ gridTemplateColumns: '1fr' }}>
                      <InfoItem label="Packets" value={d.rtp_audio_in_packet_count?.toLocaleString() ?? null} mono />
                      <InfoItem label="Raw / Media Bytes" value={`${fmtBytes(d.rtp_audio_in_raw_bytes)} / ${fmtBytes(d.rtp_audio_in_media_bytes)}`} mono />
                      {d.packet_loss_count != null && (
                        <InfoItem label="Skipped (autoflush)" value={d.packet_loss_count.toLocaleString()} mono />
                      )}
                      {d.packet_total_count != null && (
                        <InfoItem label="Packets Total" value={d.packet_total_count.toLocaleString()} mono />
                      )}
                    </div>
                  </div>
                  <div>
                    <p className="dlx4-subhead" style={{ color: INK_FAINT }}>Audio Out (to carrier)</p>
                    <div className="dlx-info-grid" style={{ gridTemplateColumns: '1fr' }}>
                      <InfoItem label="Packets" value={d.rtp_audio_out_packet_count?.toLocaleString() ?? null} mono />
                      <InfoItem label="Raw / Media Bytes" value={`${fmtBytes(d.rtp_audio_out_raw_bytes)} / ${fmtBytes(d.rtp_audio_out_media_bytes)}`} mono />
                    </div>
                  </div>
                  <div>
                    <p className="dlx4-subhead" style={{ color: INK_FAINT }}>Jitter &amp; Flaws</p>
                    <div className="dlx-info-grid" style={{ gridTemplateColumns: '1fr' }}>
                      <InfoItem
                        label="Floor / Peak / Avg"
                        value={
                          d.jitter_min_ms != null || d.jitter_max_ms != null || d.jitter_avg_ms != null
                            ? `${d.jitter_min_ms?.toFixed(2) ?? '—'} / ${d.jitter_max_ms?.toFixed(2) ?? '—'} / ${d.jitter_avg_ms?.toFixed(2) ?? '—'} ms`
                            : null
                        }
                        mono
                      />
                      {d.rtp_audio_in_mean_interval != null && (
                        <InfoItem label="Mean Packet Interval" value={`${d.rtp_audio_in_mean_interval.toFixed(2)}ms`} mono />
                      )}
                      {d.rtp_audio_in_jitter_burst_rate != null && (
                        <InfoItem label="Jitter Burst Rate" value={d.rtp_audio_in_jitter_burst_rate.toFixed(4)} mono />
                      )}
                      {d.rtp_audio_in_jitter_loss_rate != null && (
                        <InfoItem label="Jitter Loss Rate" value={d.rtp_audio_in_jitter_loss_rate.toFixed(4)} mono />
                      )}
                      {d.flaw_total != null && (
                        <InfoItem label="Flaw Total" value={d.flaw_total.toLocaleString()} mono />
                      )}
                    </div>
                  </div>
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
