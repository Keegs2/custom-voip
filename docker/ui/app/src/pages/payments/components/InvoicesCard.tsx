/**
 * InvoicesCard — the customer's monthly invoices (plan fee + metered usage). One
 * row per invoice with period, amount, and a status chip. Postpaid/plan-fee
 * accounts see rows here; prepaid-only accounts may see an empty state.
 */

import { GlassPanel, GlassChip } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { fmtDollars } from '../../../components/payments/format';
import { sectionEyebrow, sectionTitle, sectionDesc, th, td, tdMono } from '../styles';
import { IconInvoice } from './icons';
import type { Invoice, InvoiceStatus } from '../../../types/payments';

const STATUS_META: Record<InvoiceStatus, { color: string; label: string }> = {
  paid: { color: GLASS.success, label: 'Paid' },
  open: { color: GLASS.accent, label: 'Open' },
  draft: { color: GLASS.textMuted, label: 'Draft' },
  past_due: { color: GLASS.danger, label: 'Past due' },
  void: { color: GLASS.textFaint, label: 'Void' },
};

function fmtPeriod(startIso: string, endIso: string): string {
  const s = new Date(startIso);
  const e = new Date(endIso);
  if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return `${startIso} – ${endIso}`;
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' };
  return `${s.toLocaleDateString(undefined, opts)} – ${e.toLocaleDateString(undefined, { ...opts, year: 'numeric' })}`;
}

export function InvoicesCard({ invoices }: { invoices: Invoice[] }) {
  return (
    <GlassPanel padding={0} radius={20}>
      <div style={{ padding: '22px 24px 14px' }}>
        <div style={sectionEyebrow()}>Monthly billing</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: GLASS.accent }}><IconInvoice /></span>
          <h2 style={sectionTitle}>Invoices</h2>
        </div>
        <p style={sectionDesc}>Plan fees and metered usage, invoiced monthly via Stripe. Your prepaid ledger stays authoritative.</p>
      </div>

      {invoices.length === 0 ? (
        <div style={{ padding: '10px 24px 26px', color: GLASS.textMuted, fontSize: '0.85rem' }}>
          No invoices yet.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>Invoice</th>
                <th style={th}>Period</th>
                <th style={th}>Status</th>
                <th style={{ ...th, textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => {
                const meta = STATUS_META[inv.status] ?? { color: GLASS.textMuted, label: inv.status };
                return (
                  <tr key={String(inv.id)}>
                    <td style={{ ...tdMono, color: GLASS.text }}>{inv.provider_invoice_id ?? `#${inv.id}`}</td>
                    <td style={{ ...td, color: GLASS.textMuted, fontSize: '0.8rem', whiteSpace: 'nowrap' }}>
                      {fmtPeriod(inv.period_start, inv.period_end)}
                    </td>
                    <td style={td}>
                      <GlassChip label={meta.label} color={meta.color} dot={inv.status === 'past_due'} />
                    </td>
                    <td style={{ ...tdMono, textAlign: 'right', fontWeight: 700, color: GLASS.text }}>
                      {fmtDollars(inv.amount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </GlassPanel>
  );
}
