/**
 * LedgerCard — the live transaction history. Renders append-only ledger rows
 * newest-first, each with its entry type, source rail, signed amount (credits
 * green / debits red), and the running balance after. Polls via the shared
 * query family, so rows stream in as (simulated) usage and top-ups post.
 */

import { GlassPanel, GlassChip } from '../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import { signedDollars, fmtDollars } from '../../../components/payments/format';
import { sectionEyebrow, sectionTitle, sectionDesc, th, td, tdMono } from '../styles';
import { IconActivity } from './icons';
import type { LedgerEntry, LedgerEntryType, PaymentSource } from '../../../types/payments';

const ENTRY_LABEL: Record<LedgerEntryType, string> = {
  topup: 'Top-up',
  usage: 'Usage',
  fee: 'Fee',
  refund: 'Refund',
  adjustment: 'Adjustment',
  promo: 'Promo',
  chargeback: 'Chargeback',
};

const SOURCE_LABEL: Record<PaymentSource, string> = {
  stripe_card: 'Card',
  stripe_crypto: 'USDC',
  stripe_mpp: 'MPP',
  x402: 'x402',
  admin: 'Admin',
  rating: 'Call rating',
};

function entryColor(t: LedgerEntryType): string {
  if (t === 'topup' || t === 'promo' || t === 'refund') return GLASS.success;
  if (t === 'usage' || t === 'fee') return GLASS.accent;
  if (t === 'chargeback') return GLASS.danger;
  return GLASS.textMuted;
}

function fmtWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function LedgerCard({ entries, isLoading }: { entries: LedgerEntry[]; isLoading?: boolean }) {
  return (
    <GlassPanel padding={0} radius={20} blur={20}>
      <div style={{ padding: '22px 24px 16px' }}>
        <div style={sectionEyebrow()}>Real-time ledger · source of truth</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={sectionTitle}>Transaction history</h2>
        </div>
        <p style={sectionDesc}>
          Every credit and debit posts an append-only entry. Balance is the running sum — this is what authorizes calls in real time.
        </p>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={th}>When</th>
              <th style={th}>Type</th>
              <th style={th}>Source</th>
              <th style={{ ...th, textAlign: 'right' }}>Amount</th>
              <th style={{ ...th, textAlign: 'right' }}>Balance after</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && !isLoading && (
              <tr>
                <td colSpan={5} style={{ ...td, textAlign: 'center', color: GLASS.textMuted, padding: '28px 16px' }}>
                  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                    <IconActivity />
                    No activity yet — add funds or run a demo scenario to see entries stream in.
                  </div>
                </td>
              </tr>
            )}
            {entries.map((e) => {
              const amt = signedDollars(e.amount);
              return (
                <tr key={String(e.id)}>
                  <td style={{ ...tdMono, color: GLASS.textMuted, fontSize: '0.76rem', whiteSpace: 'nowrap' }}>
                    {fmtWhen(e.created_at)}
                  </td>
                  <td style={td}>
                    <GlassChip label={ENTRY_LABEL[e.entry_type] ?? e.entry_type} color={entryColor(e.entry_type)} />
                  </td>
                  <td style={{ ...td, color: GLASS.textMuted, fontSize: '0.78rem' }}>
                    {SOURCE_LABEL[e.source] ?? e.source}
                    {e.external_ref && (
                      <span style={{ display: 'block', fontFamily: 'ui-monospace, monospace', fontSize: '0.66rem', color: GLASS.textFaint, marginTop: 2 }}>
                        {e.external_ref.length > 22 ? `${e.external_ref.slice(0, 10)}…${e.external_ref.slice(-8)}` : e.external_ref}
                      </span>
                    )}
                  </td>
                  <td
                    style={{
                      ...tdMono,
                      textAlign: 'right',
                      fontWeight: 700,
                      color: amt.positive ? GLASS.success : '#fca5a5',
                    }}
                  >
                    {amt.text}
                  </td>
                  <td style={{ ...tdMono, textAlign: 'right', color: GLASS.text }}>
                    {fmtDollars(e.balance_after)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {isLoading && entries.length === 0 && (
        <div style={{ padding: '18px 24px', display: 'flex', alignItems: 'center', gap: 10, color: GLASS.textMuted, fontSize: '0.82rem' }}>
          <span
            style={{
              width: 14,
              height: 14,
              borderRadius: '50%',
              border: `2px solid ${hexToRgba(GLASS.accent, 0.25)}`,
              borderTopColor: GLASS.accent,
              animation: 'glass-spin 0.7s linear infinite',
              display: 'inline-block',
            }}
          />
          Loading ledger…
        </div>
      )}
    </GlassPanel>
  );
}
