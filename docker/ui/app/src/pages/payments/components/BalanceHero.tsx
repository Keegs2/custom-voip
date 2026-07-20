/**
 * BalanceHero — the room-legible centrepiece of the customer Billing page: the
 * live prepaid balance, animated so it visibly ROLLS as (simulated) calls drain
 * it or a top-up lands. Shows the auto-recharge status chip and the primary
 * "Add funds" action. Presentation only — data + callbacks arrive via props.
 */

import { GlassPanel, GlassChip } from '../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import { AnimatedNumber } from '../../../components/payments/AnimatedNumber';
import { fmtDollars } from '../../../components/payments/format';
import { DemoBadge } from '../../../components/payments/DemoBadge';
import { heroBalanceLabel, heroBalanceValue, primaryBtn } from '../styles';
import { IconPlus, IconWallet } from './icons';
import { rechargeChip } from './autoRechargeStatus';
import type { AutoRechargeSettings } from '../../../types/payments';

interface BalanceHeroProps {
  /** Prepaid balance in dollars. */
  balance: number;
  currency: string;
  autoRecharge?: AutoRechargeSettings;
  onAddFunds: () => void;
  isFetching?: boolean;
}

export function BalanceHero({ balance, currency, autoRecharge, onAddFunds, isFetching }: BalanceHeroProps) {
  const chip = rechargeChip(autoRecharge);
  const low =
    autoRecharge?.enabled &&
    autoRecharge.threshold != null &&
    balance < autoRecharge.threshold;

  return (
    <GlassPanel padding="30px 32px" radius={22}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 24,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
            <span
              style={{
                width: 34,
                height: 34,
                borderRadius: 10,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: hexToRgba(GLASS.accent, 0.12),
                border: `1px solid ${hexToRgba(GLASS.accent, 0.26)}`,
                color: GLASS.accent,
              }}
            >
              <IconWallet />
            </span>
            <span style={heroBalanceLabel}>Prepaid balance · {currency}</span>
            {isFetching && (
              <span
                aria-label="refreshing"
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  border: `2px solid ${hexToRgba(GLASS.accent, 0.25)}`,
                  borderTopColor: GLASS.accent,
                  animation: 'glass-spin 0.7s linear infinite',
                  display: 'inline-block',
                }}
              />
            )}
          </div>

          <AnimatedNumber
            value={balance}
            format={(v) => fmtDollars(v)}
            style={heroBalanceValue}
            flashColor="#bfdbfe"
          />

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
            <GlassChip label={chip.label} color={chip.color} dot />
            {low && <GlassChip label="Below threshold — recharge pending" color={GLASS.warning} dot />}
            <DemoBadge size="xs" />
          </div>
        </div>

        <button type="button" onClick={onAddFunds} style={primaryBtn()}>
          <IconPlus />
          Add funds
        </button>
      </div>
    </GlassPanel>
  );
}
