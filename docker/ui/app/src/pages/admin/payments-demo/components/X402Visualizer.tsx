/**
 * X402Visualizer — animates the real x402 handshake against the live metered
 * endpoint: request → 402 PAYMENT-REQUIRED → signed retry → 200 + settlement.
 * The run genuinely calls `GET /demo/metered` twice (the second with a
 * PAYMENT-SIGNATURE), so the settled micro-charge lands in the ledger.
 *
 * Treatment: a framed DARK technical inset (the SIP-ladder / code-block
 * family) — the machine wire exchange reads best on the console ground,
 * seated on the light page with one crisp keyline and the azure tick.
 */

import { Spinner } from '../../../../components/ui/Spinner';
import { fmtMicro } from '../format';
import type { X402FlowState, X402Step } from '../hooks';

const STEP_META: Record<X402Step['kind'], { side: 'agent' | 'endpoint'; cls: string; tag: string }> = {
  request: { side: 'agent', cls: 'dlx9-x4-request', tag: 'Agent →' },
  challenge: { side: 'endpoint', cls: 'dlx9-x4-challenge', tag: '← Endpoint · 402' },
  retry: { side: 'agent', cls: 'dlx9-x4-request', tag: 'Agent →' },
  settle: { side: 'endpoint', cls: 'dlx9-x4-settle', tag: '← Endpoint · 200' },
};

function StepRow({ step }: { step: X402Step }) {
  const meta = STEP_META[step.kind];
  return (
    <div className={`dlx9-x4step dlx9-x4step-${meta.side}`}>
      <div className={`dlx9-x4bubble ${meta.cls}`}>
        <div className="dlx9-x4kind">{meta.tag}</div>
        <div className="dlx9-x4label">{step.label}</div>
        {step.detail && <div className="dlx9-x4detail">{step.detail}</div>}
      </div>
    </div>
  );
}

export function X402Visualizer({
  state,
  onRun,
  onReset,
}: {
  state: X402FlowState;
  onRun: () => void;
  onReset: () => void;
}) {
  const settled = Boolean(state.settlement);

  return (
    <section className="dlx9-x4frame">
      <div className="dlx9-x4head">
        <span className="dlx9-x4title">x402 pay-per-request — live handshake</span>
        <span className="dlx9-x4sub">GET /v1/payments/demo/metered · USDC on Base · EIP-3009</span>
        {state.steps.length > 0 && (
          <button
            type="button"
            className="dlx9-x4btn dlx9-x4btn-ghost"
            onClick={onReset}
            disabled={state.running}
          >
            Clear
          </button>
        )}
        <button type="button" className="dlx9-x4btn" onClick={onRun} disabled={state.running}>
          {state.running ? <Spinner size="xs" /> : null}
          {state.running ? 'Running…' : settled ? 'Run again' : 'Run 402 flow'}
        </button>
      </div>

      <div className="dlx9-x4body">
        <div className="dlx9-x4rails">
          <span className="dlx9-x4rail-label">AI agent</span>
          <span className="dlx9-x4rail-label">Metered endpoint</span>
        </div>

        {state.steps.length === 0 ? (
          <div className="dlx9-x4empty">
            Run the flow to watch an agent hit the metered endpoint, receive the 402 challenge, sign
            the authorization, and settle a {fmtMicro(0.01)} USDC micro-charge to the ledger — payer
            to payee direct, never held by the platform.
          </div>
        ) : (
          <div className="dlx9-x4steps">
            {state.steps.map((s) => (
              <StepRow key={s.id} step={s} />
            ))}
          </div>
        )}

        {state.settlement && (
          <div className="dlx9-x4settled">
            <span className="dlx9-x4settled-tag">Settled</span>
            <span>
              {fmtMicro(state.charged ?? 0)} USDC · tx {state.settlement.tx_hash.slice(0, 14)}…
            </span>
            <span style={{ color: '#8b99b0' }}>
              {state.settlement.network} · payer {state.settlement.payer.slice(0, 10)}…
            </span>
          </div>
        )}
      </div>
    </section>
  );
}
