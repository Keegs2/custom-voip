/**
 * CallDetailPanel — the slide-out frosted drawer with the full RTP / quality /
 * billing detail for one CDR. Fetches the full record via `useCdrDetail` and
 * falls back to the row data while loading.
 */

import type { ReactNode } from 'react';
import { GLASS } from '../../../components/glass/glass';
import type { Cdr } from '../../../types/cdr';
import { useCdrDetail } from '../hooks';
import { mosColor, mosLabel, packetLossColor, qualityPctColor, rFactorColor, rFactorLabel, fmtBytes, fmtDuration } from '../quality';
import {
  drawerOverlay,
  drawerPanel,
  drawerHeader,
  drawerCloseBtn,
  panelSectionTitle,
  detailRow,
  detailRowLabel,
  detailRowValue,
  bigMetric,
  bigMetricValue,
  rtpGroupLabel,
  spinnerRing,
  MONO,
} from '../styles';

function DetailRow({ label, value, mono = false, accent }: { label: string; value: ReactNode; mono?: boolean; accent?: string }) {
  return (
    <div style={detailRow}>
      <span style={detailRowLabel}>{label}</span>
      <span style={detailRowValue(mono, accent)}>{value ?? '—'}</span>
    </div>
  );
}

function PanelSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={panelSectionTitle()}>{title}</div>
      {children}
    </div>
  );
}

function BigMetric({ label, value, sub, color }: { label: string; value: string; sub?: string; color: string }) {
  return (
    <div style={bigMetric(color)}>
      <div style={{ fontSize: '0.58rem', fontWeight: 700, color: GLASS.textMuted, textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>{label}</div>
      <div style={bigMetricValue(color)}>{value}</div>
      {sub && <div style={{ fontSize: '0.62rem', color: GLASS.textMuted, marginTop: 3 }}>{sub}</div>}
    </div>
  );
}

export function CallDetailPanel({ cdr, onClose }: { cdr: Cdr; onClose: () => void }) {
  const { detail: d, isLoading } = useCdrDetail(cdr);

  const sipCodeStr = d.sip_code != null ? String(d.sip_code) : null;
  const billableFmt = d.billable_seconds > 0 ? fmtDuration(d.billable_seconds) : '—';
  const costFmt = d.total_cost != null ? `$${d.total_cost.toFixed(4)}` : '—';
  const rateFmt = d.rate_per_min != null ? `$${d.rate_per_min.toFixed(4)}/min` : '—';
  const dirColor = d.direction === 'inbound' ? GLASS.accent : '#c084fc';

  return (
    <div onClick={onClose} style={drawerOverlay}>
      <div onClick={(e) => e.stopPropagation()} style={drawerPanel}>
        {/* Header */}
        <div style={drawerHeader}>
          <div>
            <div style={{ ...panelSectionTitle(), border: 'none', padding: 0, marginBottom: 4 }}>Call Detail</div>
            <div style={{ fontFamily: MONO, fontSize: '0.7rem', color: GLASS.textMuted, wordBreak: 'break-all' }}>{d.uuid}</div>
          </div>
          <button onClick={onClose} aria-label="Close panel" style={drawerCloseBtn}>✕</button>
        </div>

        {/* Loading indicator */}
        {isLoading && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 26px', fontSize: '0.75rem', color: GLASS.textMuted, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <span style={spinnerRing()} /> Fetching full detail…
          </div>
        )}

        {/* Body */}
        <div style={{ padding: '20px 26px', flex: 1 }}>
          {/* Big quality metrics */}
          {(d.mos != null || d.r_factor != null) && (
            <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap' }}>
              {d.mos != null && <BigMetric label="MOS Score" value={d.mos.toFixed(2)} sub={mosLabel(d.mos)} color={mosColor(d.mos)} />}
              {d.r_factor != null && <BigMetric label="R-Factor" value={d.r_factor.toFixed(1)} sub={rFactorLabel(d.r_factor)} color={rFactorColor(d.r_factor)} />}
              {d.quality_pct != null && <BigMetric label="Quality %" value={`${d.quality_pct.toFixed(1)}%`} color={qualityPctColor(d.quality_pct)} />}
            </div>
          )}

          <PanelSection title="Call Info">
            <DetailRow label="UUID" value={d.uuid} mono />
            <DetailRow label="Direction" value={<span style={{ padding: '1px 8px', borderRadius: 4, fontSize: '0.68rem', fontWeight: 700, background: `${dirColor}26`, color: dirColor }}>{d.direction}</span>} />
            <DetailRow label="Product Type" value={d.product_type} />
            <DetailRow label="Trunk ID" value={d.trunk_id} mono />
            <DetailRow label="Caller ID" value={d.caller_id} mono />
            <DetailRow label="Destination" value={d.destination} mono />
            <DetailRow label="Start Time" value={new Date(d.start_time).toLocaleString()} />
            <DetailRow label="Answer Time" value={d.answer_time ? new Date(d.answer_time).toLocaleString() : null} />
            <DetailRow label="End Time" value={d.end_time ? new Date(d.end_time).toLocaleString() : null} />
            <DetailRow label="Duration" value={fmtDuration(d.duration_seconds)} />
            <DetailRow label="Billable Duration" value={billableFmt} />
            <DetailRow label="Hangup Cause" value={d.hangup_cause} mono />
            <DetailRow label="SIP Code" value={sipCodeStr} />
            <DetailRow label="Carrier Used" value={d.carrier_used} />
            <DetailRow label="Traffic Grade" value={d.traffic_grade} />
          </PanelSection>

          {(d.mos != null || d.r_factor != null || d.flaw_total != null || d.packet_loss_pct != null) && (
            <PanelSection title="Quality Metrics">
              {d.mos != null && <DetailRow label="MOS Score" value={d.mos.toFixed(3)} accent={mosColor(d.mos)} />}
              {d.r_factor != null && <DetailRow label="R-Factor" value={d.r_factor.toFixed(2)} accent={rFactorColor(d.r_factor)} />}
              {d.quality_pct != null && <DetailRow label="Quality %" value={`${d.quality_pct.toFixed(2)}%`} />}
              {d.flaw_total != null && <DetailRow label="Flaw Total" value={d.flaw_total.toLocaleString()} />}
              {d.packet_loss_count != null && <DetailRow label="Packets Lost" value={d.packet_loss_count.toLocaleString()} />}
              {d.packet_total_count != null && <DetailRow label="Packets Total" value={d.packet_total_count.toLocaleString()} />}
              {d.packet_loss_pct != null && <DetailRow label="Packet Loss %" value={`${d.packet_loss_pct.toFixed(3)}%`} accent={packetLossColor(d.packet_loss_pct)} />}
            </PanelSection>
          )}

          {(d.rtp_audio_in_raw_bytes != null || d.rtp_audio_out_raw_bytes != null || d.jitter_avg_ms != null) && (
            <PanelSection title="RTP Statistics">
              {(d.rtp_audio_in_raw_bytes != null || d.rtp_audio_in_packet_count != null) && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ ...rtpGroupLabel, color: GLASS.accent }}>Audio In (from carrier)</div>
                  {d.rtp_audio_in_raw_bytes != null && <DetailRow label="Raw Bytes" value={fmtBytes(d.rtp_audio_in_raw_bytes)} />}
                  {d.rtp_audio_in_media_bytes != null && <DetailRow label="Media Bytes" value={fmtBytes(d.rtp_audio_in_media_bytes)} />}
                  {d.rtp_audio_in_packet_count != null && <DetailRow label="Packets" value={d.rtp_audio_in_packet_count.toLocaleString()} />}
                  {d.packet_loss_count != null && <DetailRow label="Skipped (lost)" value={d.packet_loss_count.toLocaleString()} />}
                </div>
              )}
              {(d.rtp_audio_out_raw_bytes != null || d.rtp_audio_out_packet_count != null) && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ ...rtpGroupLabel, color: '#c084fc' }}>Audio Out (to carrier)</div>
                  {d.rtp_audio_out_raw_bytes != null && <DetailRow label="Raw Bytes" value={fmtBytes(d.rtp_audio_out_raw_bytes)} />}
                  {d.rtp_audio_out_media_bytes != null && <DetailRow label="Media Bytes" value={fmtBytes(d.rtp_audio_out_media_bytes)} />}
                  {d.rtp_audio_out_packet_count != null && <DetailRow label="Packets" value={d.rtp_audio_out_packet_count.toLocaleString()} />}
                </div>
              )}
              {(d.jitter_min_ms != null || d.jitter_max_ms != null || d.jitter_avg_ms != null) && (
                <div style={{ marginBottom: 10 }}>
                  <div style={{ ...rtpGroupLabel, color: GLASS.warning }}>Jitter</div>
                  {d.jitter_min_ms != null && <DetailRow label="Min" value={`${d.jitter_min_ms.toFixed(2)}ms`} />}
                  {d.jitter_max_ms != null && <DetailRow label="Max" value={`${d.jitter_max_ms.toFixed(2)}ms`} />}
                  {d.jitter_avg_ms != null && <DetailRow label="Avg (mean interval)" value={`${d.jitter_avg_ms.toFixed(2)}ms`} />}
                  {d.rtp_audio_in_mean_interval != null && <DetailRow label="Mean Interval" value={`${d.rtp_audio_in_mean_interval.toFixed(2)}ms`} />}
                  {d.rtp_audio_in_jitter_burst_rate != null && <DetailRow label="Jitter Burst Rate" value={d.rtp_audio_in_jitter_burst_rate.toFixed(4)} />}
                  {d.rtp_audio_in_jitter_loss_rate != null && <DetailRow label="Jitter Loss Rate" value={d.rtp_audio_in_jitter_loss_rate.toFixed(4)} />}
                </div>
              )}
              {(d.read_codec != null || d.write_codec != null) && (
                <div>
                  <div style={{ ...rtpGroupLabel, color: GLASS.success }}>Codecs</div>
                  {d.read_codec != null && <DetailRow label="Read Codec" value={d.read_codec} mono />}
                  {d.write_codec != null && <DetailRow label="Write Codec" value={d.write_codec} mono />}
                </div>
              )}
            </PanelSection>
          )}

          <PanelSection title="Billing">
            <DetailRow label="Rate / Min" value={rateFmt} />
            <DetailRow label="Total Cost" value={costFmt} />
          </PanelSection>
        </div>
      </div>
    </div>
  );
}
