/**
 * PaymentsDemoControlPage — the Exec Demo Control Panel (admin).
 *
 * A presenter's cockpit: big scenario buttons on the left, a LIVE reaction pane
 * on the right (world state + balance + streaming ledger) so a click visibly
 * moves the numbers on the same screen. Everything polls via the shared payments
 * query family and co-invalidates on each scenario, so the customer page in
 * another tab reacts simultaneously.
 *
 * Admin-gated by the route (RequireAdmin). Thin composition; scenario logic in
 * ./hooks, presentation in ./components.
 *
 * React #310: all hooks unconditionally at the top.
 */

import { PageHeader } from '../../../components/layout/PageHeader';
import { DemoBadge } from '../../../components/payments/DemoBadge';
import { GLASS } from '../../../components/glass/glass';
import { useBalance, useLedger, useMppSessions, useDemoState } from '../../../components/payments/queries';
import { LedgerCard } from '../../payments/components/LedgerCard';
import { BalanceHero } from '../../payments/components/BalanceHero';
import { X402Visualizer } from '../../payments/machine/X402Visualizer';
import { MppAgentTab } from '../../payments/machine/MppAgentTab';
import { useX402Flow } from '../../payments/machine/hooks';
import { useDemoScenarioRunner } from './hooks';
import { ScenarioCard } from './components/ScenarioCard';
import { DemoStatePanel } from './components/DemoStatePanel';
import {
  Sprout,
  PhoneOff,
  Bot,
  CreditCard,
  RotateCcw,
} from 'lucide-react';
import type { DemoScenario } from '../../../types/payments';

interface ScenarioDef {
  scenario: DemoScenario;
  title: string;
  caption: string;
  icon: React.ReactNode;
  accent: string;
}

const SCENARIOS: ScenarioDef[] = [
  {
    scenario: 'seed',
    title: 'Seed demo',
    caption: 'Provision the demo customer, a card, and a starting balance.',
    icon: <Sprout size={22} strokeWidth={1.8} />,
    accent: GLASS.accent,
  },
  {
    scenario: 'call-drain',
    title: 'Simulate call-drain',
    caption: 'Burn minutes → watch the balance fall past the threshold → auto-recharge fires.',
    icon: <PhoneOff size={22} strokeWidth={1.8} />,
    accent: GLASS.warning,
  },
  {
    scenario: 'agent-usage',
    title: 'Simulate agent usage',
    caption: 'An AI agent streams x402 / MPP micro-charges to the ledger.',
    icon: <Bot size={22} strokeWidth={1.8} />,
    accent: '#a78bfa',
  },
  {
    scenario: 'decline',
    title: 'Simulate decline',
    caption: 'Force an off-session card decline → watch dunning kick in.',
    icon: <CreditCard size={22} strokeWidth={1.8} />,
    accent: GLASS.danger,
  },
  {
    scenario: 'reset',
    title: 'Reset',
    caption: 'Wipe demo ledger, methods, and sessions back to a clean slate.',
    icon: <RotateCcw size={22} strokeWidth={1.8} />,
    accent: GLASS.textMuted,
  },
];

export function PaymentsDemoControlPage() {
  // ── ALL hooks first (React #310) ────────────────────────────────────────────
  const runner = useDemoScenarioRunner();
  const demoStateQ = useDemoState();
  const balanceQ = useBalance();
  const ledgerQ = useLedger(30);
  const mppQ = useMppSessions();
  const x402 = useX402Flow();

  const seeded = demoStateQ.data?.seeded ?? false;
  const busy = runner.runningScenario != null;

  return (
    <>
      <PageHeader
        title="Exec Demo Control Panel"
        subtitle="Fire each payments scenario live and watch every dashboard react. Nothing here touches production call flow — it drives the real ledger through simulation providers."
        actions={<DemoBadge />}
      />

      {/* Two-column cockpit: triggers | live reaction */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(320px, 1.05fr) minmax(300px, 0.95fr)',
          gap: 24,
          alignItems: 'start',
        }}
        className="payments-cockpit"
      >
        {/* Left — scenario triggers */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
              gap: 14,
            }}
          >
            {SCENARIOS.map((s) => (
              <ScenarioCard
                key={s.scenario}
                title={s.title}
                caption={s.caption}
                icon={s.icon}
                accent={s.accent}
                running={runner.runningScenario === s.scenario}
                justRan={runner.lastRun === s.scenario && !busy}
                // Everything is disabled while a scenario runs, except leave the
                // running one interactive-looking. Seed is always allowed.
                disabled={busy && runner.runningScenario !== s.scenario}
                onClick={() => runner.run(s.scenario)}
              />
            ))}
          </div>

          {/* Presenter tip */}
          <div
            style={{
              padding: '14px 16px',
              borderRadius: 12,
              background: 'rgba(255,255,255,0.03)',
              border: '1px solid rgba(255,255,255,0.08)',
              fontSize: '0.78rem',
              color: GLASS.textMuted,
              lineHeight: 1.55,
            }}
          >
            <strong style={{ color: GLASS.text }}>Presenter path:</strong> Seed → Simulate call-drain (watch auto-recharge fire on the right) → Simulate agent usage (watch the machine rails stream) → Simulate decline (watch dunning) → Reset.
          </div>
        </div>

        {/* Right — live reaction pane */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <DemoStatePanel state={demoStateQ.data} seeded={seeded} />
          <BalanceHero
            balance={balanceQ.data?.balance ?? 0}
            currency={balanceQ.data?.currency ?? 'USD'}
            autoRecharge={demoStateQ.data?.auto_recharge ?? undefined}
            onAddFunds={() => runner.run('seed')}
            isFetching={balanceQ.isFetching}
          />
        </div>
      </div>

      {/* Machine rails — full width below the cockpit */}
      <div style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 24 }}>
        <X402Visualizer state={x402.state} onRun={x402.run} onReset={x402.reset} />
        <MppAgentTab sessions={mppQ.data ?? []} />
        <LedgerCard entries={ledgerQ.data ?? []} isLoading={ledgerQ.isLoading} />
      </div>

      {/* Responsive: collapse the cockpit to one column on narrow screens. */}
      <style>{`
        @media (max-width: 1024px) {
          .payments-cockpit { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </>
  );
}
