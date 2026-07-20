/**
 * UsageCard — a compact metered-usage summary by rail (money OUT), sourced from
 * the authoritative ledger. Shows total metered spend, the number of metered
 * entries, and a per-source split (telephony minutes / x402 metered API / agent
 * tab). Mirrors what Stripe Meters would invoice — but the ledger stays the
 * source of truth.
 *
 * Backend shape (`GET /usage`): { customer_id, currency, total_usage, by_source:
 * [{ source, label, usage, count }], entry_count }. All money is dollars.
 */

import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import { fmtMicro, fmtDollars, sourceMeta } from '../../../components/payments/format';
import { sectionEyebrow, sectionTitle, sectionDesc, MONO } from '../styles';
import { IconTrend } from './icons';
import type { UsageSummary } from '../../../types/payments';

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div style={{ flex: '1 1 130px', minWidth: 120 }}>
      <div style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: GLASS.textMuted, marginBottom: 5 }}>
        {label}
      </div>
      <div style={{ fontSize: '1.5rem', fontWeight: 800, fontFamily: MONO, color: GLASS.text, lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: '0.7rem', color: GLASS.textFaint, marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

export function UsageCard({ usage }: { usage: UsageSummary }) {
  const sources = usage.by_source ?? [];
  return (
    <GlassPanel padding="24px 26px" radius={20}>
      <div style={{ marginBottom: 18 }}>
        <div style={sectionEyebrow()}>Metered usage · money out</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: GLASS.accent }}><IconTrend /></span>
          <h2 style={sectionTitle}>Usage</h2>
        </div>
        <p style={sectionDesc}>Metered spend by rail, aggregated from the ledger — mirrored to Stripe Meters for invoicing while the ledger stays authoritative.</p>
      </div>

      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', marginBottom: sources.length ? 18 : 0 }}>
        <Metric label={`Usage spend · ${usage.currency}`} value={fmtDollars(usage.total_usage)} />
        <Metric label="Metered entries" value={usage.entry_count.toLocaleString()} />
        <Metric label="Rails used" value={String(sources.length)} />
      </div>

      {sources.length > 0 ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {sources.map((r) => {
            const meta = sourceMeta(r.source);
            return (
              <span
                key={r.source}
                title={`${r.count} entr${r.count === 1 ? 'y' : 'ies'}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '6px 12px',
                  borderRadius: 999,
                  background: hexToRgba(meta.color, 0.08),
                  border: `1px solid ${hexToRgba(meta.color, 0.22)}`,
                  fontSize: '0.72rem',
                  color: GLASS.text,
                }}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: meta.color }} />
                <span style={{ fontWeight: 600 }}>{r.label}</span>
                <span style={{ fontFamily: MONO, color: GLASS.textMuted }}>{fmtMicro(r.usage)}</span>
              </span>
            );
          })}
        </div>
      ) : (
        <div style={{ fontSize: '0.8rem', color: GLASS.textMuted }}>
          No metered usage yet — run a call-drain or agent-usage scenario to see spend by rail.
        </div>
      )}

      <div style={{ fontSize: '0.68rem', color: GLASS.textFaint, marginTop: 14 }}>
        {usage.entry_count.toLocaleString()} metered ledger {usage.entry_count === 1 ? 'entry' : 'entries'} ·{' '}
        {fmtDollars(usage.total_usage)} total metered spend
      </div>
    </GlassPanel>
  );
}
