/**
 * PaymentsDemoControlPage — the Machine Payments Demo control panel (admin).
 *
 * A standalone daylight page at /admin/payments-demo (its own `dl-scope`
 * canvas, outside the Customer/Platform tab shells): scenario triggers on the
 * left, a live world-state pane on the right, the ledger streaming below,
 * then the two machine rails (the x402 handshake as a framed dark technical
 * inset, and the interactive MPP agent tab), and the folded-in revenue +
 * compliance dashboard section.
 *
 * Everything drives the REAL Wave-1 ledger through simulation providers —
 * no live Stripe/Coinbase money moves, and no carrier/call path is touched.
 * When PAYMENTS_DEMO_MODE is off the whole router 404s; the page renders a
 * composed "demo off" state with the enable instruction.
 *
 * React #310: ALL hooks unconditionally at the top.
 */

import {
  Sprout,
  PhoneOff,
  Bot,
  CreditCard,
  ListChecks,
  RotateCcw,
  WalletMinimal,
  TerminalSquare,
} from 'lucide-react';
import { ApiError } from '../../../api/client';
import { Spinner } from '../../../components/ui/Spinner';
import { useComplianceStatus, useDemoState, usePaymentsSummary, useScenarioRunner, useX402Flow } from './hooks';
import { fmtDollars } from './format';
import { ScenarioCard, type ScenarioTone } from './components/ScenarioCard';
import { DemoStatePanel } from './components/DemoStatePanel';
import { LedgerPanel } from './components/LedgerPanel';
import { X402Visualizer } from './components/X402Visualizer';
import { MppTabPanel } from './components/MppTabPanel';
import { RevenueCompliance } from './components/RevenueCompliance';
import type { DemoScenario } from './types';
import '../../../styles/dl-admin.css';
import '../../../styles/dl-payments.css';

interface ScenarioDef {
  scenario: DemoScenario;
  title: string;
  caption: string;
  icon: React.ReactNode;
  tone: ScenarioTone;
}

const SCENARIOS: ScenarioDef[] = [
  {
    scenario: 'seed',
    title: 'Seed',
    caption: 'Provision "DEMO — Acme Robotics": $250 balance, a demo Visa on file, auto-recharge armed.',
    icon: <Sprout size={18} strokeWidth={1.8} />,
    tone: 'azure',
  },
  {
    scenario: 'call-drain',
    title: 'Call drain → auto-recharge',
    caption: 'Burn call minutes past the $50 threshold and watch the off-session top-up fire.',
    icon: <PhoneOff size={18} strokeWidth={1.8} />,
    tone: 'amber',
  },
  {
    scenario: 'agent-usage',
    title: 'Agent usage — x402 batch',
    caption: 'An AI agent settles 25 metered USDC micro-charges as one aggregate ledger entry.',
    icon: <Bot size={18} strokeWidth={1.8} />,
    tone: 'green',
  },
  {
    scenario: 'mpp',
    title: 'MPP tab walkthrough',
    caption: 'Open a $5 agent tab, stream charges, hit the enforced limit (409), batch-settle.',
    icon: <ListChecks size={18} strokeWidth={1.8} />,
    tone: 'cyan',
  },
  {
    scenario: 'decline',
    title: 'Card decline → dunning',
    caption: 'Force an off-session decline and watch the failure counter and dunning state update.',
    icon: <CreditCard size={18} strokeWidth={1.8} />,
    tone: 'red',
  },
  {
    scenario: 'reset',
    title: 'Reset',
    caption: 'Wipe every demo customer, ledger entry, method, and session back to a clean slate.',
    icon: <RotateCcw size={18} strokeWidth={1.8} />,
    tone: 'slate',
  },
];

/** Composed state when PAYMENTS_DEMO_MODE is off (the router 404s). */
function DemoOffState() {
  return (
    <div className="dl-panel">
      <div className="dl-center">
        <span className="dl-center-icon">
          <WalletMinimal size={26} strokeWidth={1.6} />
        </span>
        <div style={{ fontFamily: '"Archivo", sans-serif', fontWeight: 700, fontSize: '1.05rem', color: 'var(--rcf-ink)' }}>
          Demo mode is off
        </div>
        <p style={{ fontSize: '0.8rem', lineHeight: 1.6, color: 'var(--rcf-ink-soft)', maxWidth: '52ch', margin: 0 }}>
          The payments demo router is dormant (404) until the API starts with{' '}
          <code style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: '0.74rem', color: 'var(--rcf-azure-deep)' }}>
            PAYMENTS_DEMO_MODE=true
          </code>{' '}
          in its environment. Set it in the local <code style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: '0.74rem' }}>.env</code>,
          restart the API container, and this panel comes alive. Nothing here ever runs in a normal
          deployment.
        </p>
      </div>
    </div>
  );
}

export function PaymentsDemoControlPage() {
  // ── ALL hooks first (React #310) ─────────────────────────────────────────
  const stateQ = useDemoState();
  const runner = useScenarioRunner();
  const x402 = useX402Flow();
  const demoOff = stateQ.isError && stateQ.error instanceof ApiError && stateQ.error.status === 404;
  // Only light up the dashboard queries once the state probe has SUCCEEDED —
  // during load (or with the flag off) they'd just poll 404s.
  const demoOn = !stateQ.isError && stateQ.data != null;
  const summaryQ = usePaymentsSummary(demoOn && Boolean(stateQ.data?.seeded));
  const complianceQ = useComplianceStatus(demoOn);

  const state = stateQ.data;
  const seeded = state?.seeded ?? false;
  const busy = runner.running != null;
  const scenariosRun = state?.activity?.length ?? 0;

  return (
    <div className="dl-scope">
      <div className="dl-shell">
        {/* ── Quiet page header ── */}
        <header className="dl-header fx-load">
          <div className="dl-header-id">
            <div className="dl-crumb">
              <span>Machine Payments Demo</span>
              <span className="dl-crumb-sep" aria-hidden="true">/</span>
              <span>Granite CRAG</span>
            </div>
            <h1 className="dl-title">Payments Control Panel</h1>
            <p className="dl-sub">
              Fire each monetary scenario live and watch the ledger react. Simulation providers drive
              the real append-only ledger — no live money moves, and the call path is never touched.
            </p>
          </div>
          {demoOn && seeded && (
            <div className="dl-metrics">
              <div className="dl-metric">
                <div className="dl-metric-value">{fmtDollars(state?.balance ?? 0)}</div>
                <div className="dl-metric-label">Prepaid balance</div>
              </div>
              <div className="dl-metric">
                <div className="dl-metric-value">{state?.revenue?.by_rail.length ?? 0}</div>
                <div className="dl-metric-label">Revenue rails</div>
              </div>
              <div className="dl-metric">
                <div className="dl-metric-value">{scenariosRun}</div>
                <div className="dl-metric-label">Scenarios run</div>
              </div>
            </div>
          )}
        </header>

        {stateQ.isLoading ? (
          <div className="dl-center">
            <Spinner size="lg" />
            <span style={{ fontSize: '0.8rem', color: 'var(--rcf-ink-dim)' }}>Probing demo mode…</span>
          </div>
        ) : demoOff ? (
          <DemoOffState />
        ) : stateQ.isError ? (
          <div className="dl-banner dl-banner-err">
            Could not reach the payments API: {(stateQ.error as Error).message}
          </div>
        ) : (
          <div className="fx-load fx-load-d1">
            {/* ── Cockpit: scenario triggers | live state ── */}
            <div className="dlx9-cockpit">
              <div>
                <div className="dlx9-scen-grid">
                  {SCENARIOS.map((s) => (
                    <ScenarioCard
                      key={s.scenario}
                      title={s.title}
                      caption={s.caption}
                      icon={s.icon}
                      tone={s.tone}
                      running={runner.running === s.scenario}
                      disabled={busy && runner.running !== s.scenario}
                      result={runner.results[s.scenario]}
                      onClick={() => void runner.run(s.scenario)}
                    />
                  ))}
                </div>

                <div className="dl-note" style={{ marginTop: 14 }}>
                  <TerminalSquare size={15} strokeWidth={1.8} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>
                    <strong>Presenter path:</strong> Seed → Call drain → Agent usage → MPP walkthrough
                    → Decline → Reset. A parallel x402 pay-per-call gate also fronts{' '}
                    <code style={{ fontFamily: '"IBM Plex Mono", monospace', fontSize: '0.7rem' }}>
                      POST /v1/calls
                    </code>{' '}
                    — that one is demoed from curl/Postman (a 402-then-pay call origination), not from
                    this panel.
                  </span>
                </div>
              </div>

              <DemoStatePanel state={state} />
            </div>

            {/* ── Ledger ── */}
            <div className="dl-stack">
              <LedgerPanel entries={state?.transactions ?? []} />

              {/* ── Machine rails ── */}
              <X402Visualizer state={x402.state} onRun={() => void x402.run()} onReset={x402.reset} />
              <MppTabPanel sessions={state?.mpp_sessions ?? []} />

              {/* ── Dashboard section: revenue + compliance ──
                  The summary is withheld while unseeded so a Reset doesn't
                  leave stale cached revenue on the tiles. */}
              <RevenueCompliance summary={seeded ? summaryQ.data : undefined} compliance={complianceQ.data} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
