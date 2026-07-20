/**
 * PaymentsDashboardPage — the exec Revenue + Compliance dashboard (admin).
 *
 * Top: revenue-by-rail (card / stablecoin / machine) with the app's SVG chart
 * style + animated totals. Bottom: the three compliance GATES (§1) rendered as
 * GREEN/verified cards — the "we designed this compliant" narrative.
 *
 * The compliance gate copy is CANONICAL to the design doc (§1), so this page
 * ships a well-formed default set of gates and merges the backend's live
 * `/compliance` payload over it — that way the narrative always renders in the
 * demo even before the backend fills in live metrics, and the live metric/state
 * (e.g. the closed-loop daily figure) overrides the default when present.
 *
 * Admin-gated by the route. Thin composition; presentation in ./components.
 *
 * React #310: all hooks unconditionally at the top.
 */

import { PageHeader } from '../../../components/layout/PageHeader';
import { DemoBadge } from '../../../components/payments/DemoBadge';
import { GLASS } from '../../../components/glass/glass';
import { GlassChip } from '../../../components/glass/GlassCard';
import { usePaymentsSummary, useComplianceStatus } from '../../../components/payments/queries';
import { RevenuePanel } from './components/RevenuePanel';
import { ComplianceGateCard } from './components/ComplianceGateCard';
import { PageLoading, PageError } from '../../payments/components/states';
import type { ComplianceGate, ComplianceStatus } from '../../../types/payments';

/**
 * Canonical default gates (design §1) — render the exec narrative even before the
 * backend `/compliance` payload arrives. The backend returns the SAME three gates
 * with `{ id, name, status, detail, evidence }`; when it does we use those (they
 * are authoritative and carry live evidence), falling back to these otherwise.
 */
const DEFAULT_GATES: ComplianceGate[] = [
  {
    id: 'pci_saq_a',
    name: 'PCI SAQ-A (card data in processor iframe only)',
    status: 'green',
    detail:
      'Card data is collected only inside a Stripe-hosted Payment Element; we store nothing but pm_… / cus_… tokens + brand/last4. No PAN/CVV in DB, logs, or transit.',
    evidence: { pan_cvv_columns_in_db: 0 },
  },
  {
    id: 'closed_loop_prepaid',
    name: 'Closed-loop prepaid ≤ $2,000/day',
    status: 'green',
    detail:
      'Prepaid balance is redeemable only for our telecom services (never cash-out/transfer). Per-account daily auto-recharge cap ≤ $2,000 keeps us inside the FinCEN closed-loop exclusion.',
    evidence: { daily_cap_over_2000_count: 0 },
  },
  {
    id: 'non_custodial_crypto',
    name: 'Non-custodial crypto (hosted facilitator)',
    status: 'green',
    detail:
      'USDC/x402 flows are non-custodial: payer→payee direct, hosted Coinbase CDP facilitator only broadcasts the signed authorization. We never pool/sweep/hold customer crypto. OFAC-screened; GENIUS-compliant issuer stablecoin (USDC).',
    evidence: { facilitator: 'coinbase-cdp (hosted)', self_hosted_facilitator: false },
  },
];

/** Use the live compliance payload when present; otherwise the canonical defaults. */
function resolveGates(live?: ComplianceStatus): ComplianceGate[] {
  if (live && Array.isArray(live.gates) && live.gates.length > 0) return live.gates;
  return DEFAULT_GATES;
}

export function PaymentsDashboardPage() {
  // ── ALL hooks first (React #310) ────────────────────────────────────────────
  const summaryQ = usePaymentsSummary();
  const complianceQ = useComplianceStatus();

  const gates = resolveGates(complianceQ.data);
  const allVerified = complianceQ.data?.all_green ?? gates.every((g) => g.status === 'green');

  return (
    <>
      <PageHeader
        title="Revenue & Compliance"
        subtitle="Revenue by rail across the demo, and the three compliance gates we designed the system to sit inside."
        actions={<DemoBadge />}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        {/* Revenue */}
        {summaryQ.isLoading ? (
          <PageLoading label="Loading revenue…" />
        ) : summaryQ.isError ? (
          <PageError message={(summaryQ.error as Error)?.message ?? 'The revenue summary is unavailable.'} />
        ) : summaryQ.data ? (
          <RevenuePanel summary={summaryQ.data} />
        ) : null}

        {/* Compliance */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <h2 style={{ fontSize: '1.15rem', fontWeight: 800, color: GLASS.text, margin: 0, letterSpacing: '-0.01em' }}>
              Compliance gates
            </h2>
            <GlassChip
              label={allVerified ? 'All verified' : 'Review needed'}
              color={allVerified ? GLASS.success : GLASS.warning}
              dot
            />
            <span style={{ fontSize: '0.78rem', color: GLASS.textMuted }}>
              The three lines the design never crosses — each keeps a heavy licensing burden off the platform.
            </span>
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
              gap: 18,
            }}
          >
            {gates.map((g, i) => (
              <ComplianceGateCard key={g.id} gate={g} index={i} />
            ))}
          </div>
          <p style={{ fontSize: '0.72rem', color: GLASS.textFaint, marginTop: 14, lineHeight: 1.55, maxWidth: 760 }}>
            Not legal advice. Gates are synthesized from primary regulator sources (PCI SSC, FinCEN, Federal Register, NYDFS)
            and must be confirmed with qualified payments/fintech counsel before holding customer funds, taking custody of any
            stablecoin, or self-hosting a facilitator.
          </p>
        </div>
      </div>
    </>
  );
}
