/**
 * Glass stat tiles. `StatTile` is the reusable frosted metric chip (accent top
 * line + label + value). `AccountOverviewTiles` renders the customer's headline
 * figures (balance / limits / fraud / created), with the billing fields hidden
 * for RCF accounts exactly as before.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import type { Customer } from '../../../../types/customer';
import { statAccentLine, statLabel, statValue } from '../styles';

interface StatTileProps {
  label: string;
  value: ReactNode;
  accent?: string;
}

export function StatTile({ label, value, accent = GLASS.accent }: StatTileProps) {
  return (
    <GlassPanel
      accent={accent}
      radius={14}
      blur={14}
      padding="18px 22px"
      style={{ flex: '1 1 150px', minWidth: 0 }}
    >
      <div style={statAccentLine(accent)} />
      <div style={statLabel}>{label}</div>
      <div style={statValue}>{value}</div>
    </GlassPanel>
  );
}

const ROW: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 14 };

export function AccountOverviewTiles({ customer }: { customer: Customer }) {
  const isRcf = customer.account_type === 'rcf';
  return (
    <div style={ROW}>
      {/* Balance / credit / limit fields are meaningless for RCF accounts. */}
      {!isRcf && (
        <>
          <StatTile
            label="Balance"
            accent={customer.balance < 0 ? GLASS.danger : GLASS.success}
            value={
              <span style={{ color: customer.balance < 0 ? '#f87171' : '#4ade80' }}>
                ${customer.balance.toFixed(2)}
              </span>
            }
          />
          <StatTile label="Credit Limit" value={`$${customer.credit_limit.toFixed(2)}`} />
          <StatTile
            label="Daily Limit"
            value={customer.daily_limit != null ? `$${customer.daily_limit.toFixed(2)}` : '--'}
          />
          <StatTile
            label="CPM Limit"
            value={customer.cpm_limit != null ? String(customer.cpm_limit) : '--'}
          />
        </>
      )}
      <StatTile
        label="Fraud Score"
        accent={customer.fraud_score > 70 ? GLASS.danger : GLASS.accent}
        value={
          <span style={{ color: customer.fraud_score > 70 ? '#f87171' : GLASS.text }}>
            {customer.fraud_score ?? 0}
          </span>
        }
      />
      <StatTile
        label="Created"
        value={
          customer.created_at
            ? new Date(customer.created_at).toLocaleDateString(undefined, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })
            : '--'
        }
      />
    </div>
  );
}
