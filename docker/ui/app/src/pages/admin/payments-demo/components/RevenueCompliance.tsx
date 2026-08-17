/**
 * RevenueCompliance — the dashboard section folded into the control page:
 * revenue-by-rail tiles (from GET /summary) and the three compliance gates
 * (from GET /compliance) as informational daylight cards. The gates copy is
 * the backend's own — it carries live evidence (schema scan, cap check).
 */

import { ShieldCheck, Landmark, Coins } from 'lucide-react';
import type { ComplianceGate, ComplianceStatus, PaymentsSummary } from '../types';
import { fmtDollars, railClass, railLabel } from '../format';

const GATE_ICON: Record<string, React.ReactNode> = {
  pci_saq_a: <ShieldCheck size={17} strokeWidth={1.8} />,
  closed_loop_prepaid: <Landmark size={17} strokeWidth={1.8} />,
  non_custodial_crypto: <Coins size={17} strokeWidth={1.8} />,
};

function GateCard({ gate }: { gate: ComplianceGate }) {
  const green = gate.status === 'green';
  return (
    <div className="dl-panel">
      <div className="dl-panel-body">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span
            className={`dlx9-scen-icon ${green ? 'dlx9-tone-green' : 'dlx9-tone-red'}`}
            style={{ width: 34, height: 34 }}
          >
            {GATE_ICON[gate.id] ?? <ShieldCheck size={17} strokeWidth={1.8} />}
          </span>
          <span className={green ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
            {green ? 'Verified' : 'Review'}
          </span>
        </div>
        <div style={{ fontSize: '0.84rem', fontWeight: 700, color: 'var(--rcf-ink)', lineHeight: 1.35 }}>
          {gate.name}
        </div>
        <p style={{ fontSize: '0.72rem', lineHeight: 1.55, color: 'var(--rcf-ink-soft)', margin: '8px 0 0' }}>
          {gate.detail}
        </p>
        {gate.evidence && Object.keys(gate.evidence).length > 0 && (
          <div className="dlx9-gate-evidence">
            {Object.entries(gate.evidence)
              .map(([k, v]) => `${k}=${String(v)}`)
              .join(' · ')}
          </div>
        )}
      </div>
    </div>
  );
}

export function RevenueCompliance({
  summary,
  compliance,
}: {
  summary?: PaymentsSummary;
  compliance?: ComplianceStatus;
}) {
  const byRail = summary?.revenue.by_rail ?? [];
  const gates = compliance?.gates ?? [];
  const allGreen = compliance?.all_green ?? false;

  return (
    <div className="dl-stack">
      {/* ── Revenue by rail ── */}
      <section className="dl-panel">
        <div className="dl-panel-head">
          <span className="dl-panel-title">Revenue by rail</span>
          {summary && (
            <span
              className={summary.reconciled ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}
              title="Ledger sum vs cached balance"
            >
              {summary.reconciled ? 'Ledger reconciled' : 'Reconciliation drift'}
            </span>
          )}
          <p className="dl-panel-sub">
            Money-in grouped by settlement rail across the demo, next to total metered usage — the
            same query an exec revenue board would run.
          </p>
        </div>
        <div className="dl-panel-body">
          {byRail.length === 0 ? (
            <div className="dl-empty">No revenue yet — Seed posts the first USDC top-up.</div>
          ) : (
            <div className="dlx9-rev-grid">
              <div className="dl-tile">
                <span className="dl-tile-label">Total revenue</span>
                <span className="dl-tile-value">{fmtDollars(summary?.revenue.total_revenue ?? 0)}</span>
                <span className="dl-tile-hint">All rails, demo scope</span>
              </div>
              {byRail.map((r) => (
                <div key={r.rail} className="dl-tile">
                  <span className={railClass(r.rail)} style={{ alignSelf: 'flex-start' }}>
                    {railLabel(r.rail)}
                  </span>
                  <span className="dl-tile-value">{fmtDollars(r.revenue)}</span>
                  <span className="dl-tile-hint">
                    {r.count} transaction{r.count === 1 ? '' : 's'} · {r.label}
                  </span>
                </div>
              ))}
              <div className="dl-tile">
                <span className="dl-tile-label">Metered usage</span>
                <span className="dl-tile-value">{fmtDollars(summary?.usage.total_usage ?? 0)}</span>
                <span className="dl-tile-hint">Money out — calls, x402, agent tabs</span>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* ── Compliance gates ── */}
      <div>
        <div className="dl-section-title" style={{ marginBottom: 12 }}>
          Compliance gates
          {compliance && (
            <span className={allGreen ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
              {allGreen ? 'All green' : 'Review needed'}
            </span>
          )}
        </div>
        {gates.length === 0 ? (
          <div className="dl-empty">Compliance status unavailable.</div>
        ) : (
          <div className="dlx9-gates">
            {gates.map((g) => (
              <GateCard key={g.id} gate={g} />
            ))}
          </div>
        )}
        <p className="dlx9-footnote">
          Not legal advice. Gates reflect the design posture (PCI SSC, FinCEN closed-loop exclusion,
          non-custodial facilitator model) with live evidence where the platform can self-check; they
          must be confirmed with qualified payments counsel before holding customer funds or taking
          custody of any stablecoin.
        </p>
      </div>
    </div>
  );
}
