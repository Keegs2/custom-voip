/**
 * DemoStatePanel — a live "world state" readout for the presenter: the demo
 * customer, current balance (animated), auto-recharge posture, open agent tabs,
 * and the last scenario fired. Polls via the shared demo-state query so it
 * reflects every scenario the moment it lands.
 */

import { GlassPanel, GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { AnimatedNumber } from '../../../../components/payments/AnimatedNumber';
import { fmtDollars } from '../../../../components/payments/format';
import { rechargeChipShort } from '../../../payments/components/autoRechargeStatus';
import type { DemoState } from '../../../../types/payments';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ flex: '1 1 140px', minWidth: 130 }}>
      <div style={{ fontSize: '0.58rem', fontWeight: 700, letterSpacing: '0.1em', textTransform: 'uppercase', color: GLASS.textMuted, marginBottom: 6 }}>
        {label}
      </div>
      {children}
    </div>
  );
}

export function DemoStatePanel({ state, seeded }: { state?: DemoState; seeded: boolean }) {
  const ar = state?.auto_recharge;
  const arChip = rechargeChipShort(ar);
  // The demo-state read has no dedicated counters; derive them from the payload.
  const openTabs = (state?.mpp_sessions ?? []).filter((s) => s.status === 'open').length;
  const lastScenario = state?.activity && state.activity.length > 0 ? state.activity[0].scenario : null;
  const customerName = state?.customer?.name ?? (seeded ? `#${state?.customer?.id ?? '—'}` : '—');

  return (
    <GlassPanel padding="22px 24px" radius={18}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: seeded ? GLASS.success : GLASS.warning,
            boxShadow: `0 0 8px ${seeded ? GLASS.success : GLASS.warning}`,
          }}
        />
        <span style={{ fontSize: '0.66rem', fontWeight: 800, letterSpacing: '0.12em', textTransform: 'uppercase', color: GLASS.textMuted }}>
          Live demo state {seeded ? '· seeded' : '· not seeded'}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
        <Stat label="Demo customer">
          <div style={{ fontSize: '1rem', fontWeight: 700, color: GLASS.text }}>
            {customerName}
          </div>
        </Stat>

        <Stat label="Balance">
          <AnimatedNumber
            value={state?.balance ?? 0}
            format={(v) => fmtDollars(v)}
            style={{ fontSize: '1.4rem', fontWeight: 800, fontFamily: MONO, color: GLASS.text }}
            flashColor="#bfdbfe"
          />
        </Stat>

        <Stat label="Auto-recharge">
          <GlassChip label={arChip.label} color={arChip.color} dot={ar?.enabled} />
        </Stat>

        <Stat label="Open agent tabs">
          <AnimatedNumber
            value={openTabs}
            format={(v) => String(Math.round(v))}
            style={{ fontSize: '1.4rem', fontWeight: 800, fontFamily: MONO, color: '#c4b5fd' }}
          />
        </Stat>

        <Stat label="Last scenario">
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: lastScenario ? GLASS.accent : GLASS.textFaint }}>
            {lastScenario ?? 'none yet'}
          </div>
        </Stat>
      </div>
    </GlassPanel>
  );
}
