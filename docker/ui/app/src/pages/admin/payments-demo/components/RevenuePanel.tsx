/**
 * RevenuePanel — the exec revenue view: a big animated total, per-rail stat
 * tiles, the revenue-by-rail bar chart, and the aggregate metered-usage + ledger
 * reconciliation health. Amounts are dollars; totals animate so a scenario visibly
 * grows revenue on stage.
 *
 * Backend shape (`GET /summary?scope=demo`): { scope, customer_id, revenue:
 * { total_revenue, by_rail: [{ rail, label, revenue, count }] }, usage:
 * { total_usage }, reconciled }. `rail` is a backend ledger source key.
 */

import { GlassPanel, GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { AnimatedNumber } from '../../../../components/payments/AnimatedNumber';
import { RevenueBars } from '../../../../components/payments/RevenueBars';
import { fmtDollars, sourceMeta } from '../../../../components/payments/format';
import type { PaymentsSummary, RevenueByRail } from '../../../../types/payments';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

function RailTile({ rail }: { rail: RevenueByRail }) {
  const meta = sourceMeta(rail.rail);
  return (
    <div
      style={{
        flex: '1 1 170px',
        minWidth: 150,
        padding: '16px 18px',
        borderRadius: 14,
        background: hexToRgba(meta.color, 0.06),
        border: `1px solid ${hexToRgba(meta.color, 0.22)}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ width: 9, height: 9, borderRadius: '50%', background: meta.color, boxShadow: `0 0 8px ${meta.color}` }} />
        <span style={{ fontSize: '0.66rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: GLASS.textMuted }}>
          {rail.label}
        </span>
      </div>
      <AnimatedNumber
        value={rail.revenue}
        format={(v) => fmtDollars(v, 0)}
        style={{ fontSize: '1.65rem', fontWeight: 800, fontFamily: MONO, color: GLASS.text }}
        flashColor={meta.color}
      />
      <div style={{ fontSize: '0.7rem', color: GLASS.textFaint, marginTop: 4 }}>{rail.count} transactions</div>
    </div>
  );
}

export function RevenuePanel({ summary }: { summary: PaymentsSummary }) {
  const byRail = summary.revenue.by_rail ?? [];
  return (
    <GlassPanel padding="26px 28px" radius={22}>
      {/* Total */}
      <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 20, flexWrap: 'wrap', marginBottom: 22 }}>
        <div>
          <div style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: GLASS.textMuted, marginBottom: 8 }}>
            Total revenue · all rails
          </div>
          <AnimatedNumber
            value={summary.revenue.total_revenue}
            format={(v) => fmtDollars(v)}
            style={{ fontSize: 'clamp(2rem, 5vw, 3.2rem)', fontWeight: 800, fontFamily: MONO, color: GLASS.text, letterSpacing: '-0.02em', lineHeight: 1 }}
            flashColor="#bfdbfe"
          />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
            <GlassChip
              label={summary.reconciled ? 'Ledger reconciled' : 'Reconciliation drift'}
              color={summary.reconciled ? GLASS.success : GLASS.danger}
              dot
            />
            <span style={{ fontSize: '0.72rem', color: GLASS.textFaint }}>
              SUM(ledger) === cached balance across the demo
            </span>
          </div>
        </div>

        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: '0.62rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: GLASS.textMuted, marginBottom: 6 }}>
            Metered usage · money out
          </div>
          <AnimatedNumber
            value={summary.usage.total_usage}
            format={(v) => fmtDollars(v)}
            style={{ fontSize: '1.5rem', fontWeight: 800, fontFamily: MONO, color: GLASS.accentSecondary }}
          />
        </div>
      </div>

      {/* Per-rail tiles */}
      <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 24 }}>
        {byRail.map((r) => (
          <RailTile key={r.rail} rail={r} />
        ))}
      </div>

      {/* Bar chart */}
      <div>
        <div style={{ fontSize: '0.66rem', fontWeight: 700, color: GLASS.textFaint, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>
          Revenue by rail
        </div>
        <RevenueBars data={byRail} />
      </div>
    </GlassPanel>
  );
}
