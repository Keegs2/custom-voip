/**
 * X402Visualizer — animates the x402 machine-payment handshake: an AI agent hits
 * a metered endpoint, gets a 402 PAYMENT-REQUIRED challenge, signs & retries with
 * a PAYMENT-SIGNATURE, and a USDC micro-charge settles to the ledger. Rendered as
 * a two-column "agent ⇄ endpoint" timeline whose steps light up in sequence — the
 * "our AI agents pay per-request" story, legible from across a room.
 *
 * Presentational: the flow state + the run/reset actions come from useX402Flow.
 */

import { GlassPanel, GlassChip } from '../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import { DemoBadge } from '../../../components/payments/DemoBadge';
import { fmtMicro } from '../../../components/payments/format';
import { IconAgent, IconZap } from '../components/icons';
import type { X402State, X402Step } from './hooks';

const STEP_META: Record<X402Step['kind'], { color: string; side: 'agent' | 'endpoint'; arrow: string }> = {
  request: { color: GLASS.accentSecondary, side: 'agent', arrow: '→' },
  challenge: { color: GLASS.warning, side: 'endpoint', arrow: '←' },
  retry: { color: GLASS.accentSecondary, side: 'agent', arrow: '→' },
  settle: { color: GLASS.success, side: 'endpoint', arrow: '←' },
};

function StepRow({ step, index }: { step: X402Step; index: number }) {
  const meta = STEP_META[step.kind];
  const fromAgent = meta.side === 'agent';
  return (
    <div
      className="glass-rise"
      style={{
        display: 'flex',
        justifyContent: fromAgent ? 'flex-start' : 'flex-end',
        animation: 'glass-rise 0.4s cubic-bezier(0.2,0.7,0.3,1) both',
        animationDelay: `${index * 40}ms`,
      }}
    >
      <div
        style={{
          maxWidth: '78%',
          padding: '11px 14px',
          borderRadius: 14,
          background: hexToRgba(meta.color, 0.09),
          border: `1px solid ${hexToRgba(meta.color, 0.3)}`,
          boxShadow: `0 8px 24px -14px ${hexToRgba(meta.color, 0.6)}`,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontSize: '0.58rem',
              fontWeight: 800,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: meta.color,
            }}
          >
            {fromAgent ? 'Agent' : 'Endpoint'} {meta.arrow}
          </span>
        </div>
        <div style={{ fontSize: '0.85rem', fontWeight: 700, color: GLASS.text, marginTop: 3 }}>{step.label}</div>
        {step.detail && (
          <div style={{ fontSize: '0.7rem', color: GLASS.textMuted, marginTop: 3, fontFamily: 'ui-monospace, monospace' }}>
            {step.detail}
          </div>
        )}
      </div>
    </div>
  );
}

export function X402Visualizer({
  state,
  onRun,
  onReset,
}: {
  state: X402State;
  onRun: () => void;
  onReset: () => void;
}) {
  const settled = Boolean(state.settlement);
  return (
    <GlassPanel padding="24px 26px" radius={20} accent={GLASS.accentSecondary}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: hexToRgba(GLASS.accentSecondary, 0.85), marginBottom: 6 }}>
            Crypto-native · USDC on Base
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ color: GLASS.accentSecondary }}><IconAgent /></span>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: GLASS.text, margin: 0 }}>x402 pay-per-request</h2>
            <DemoBadge size="xs" />
          </div>
          <p style={{ fontSize: '0.82rem', color: GLASS.textMuted, margin: '4px 0 0', lineHeight: 1.5, maxWidth: 560 }}>
            An agent calls a metered endpoint → <strong style={{ color: GLASS.warning }}>402</strong> challenge → it signs a gasless EIP-3009 authorization → the endpoint settles a micro-charge to our ledger. Payer→payee direct; we never take custody.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {state.steps.length > 0 && (
            <button
              type="button"
              onClick={onReset}
              disabled={state.running}
              style={{
                padding: '9px 14px',
                borderRadius: 11,
                border: '1px solid rgba(255,255,255,0.12)',
                background: 'rgba(255,255,255,0.03)',
                color: GLASS.textMuted,
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: state.running ? 'not-allowed' : 'pointer',
                fontFamily: 'inherit',
              }}
            >
              Reset
            </button>
          )}
          <button
            type="button"
            onClick={onRun}
            disabled={state.running}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 18px',
              borderRadius: 12,
              border: 'none',
              background: `linear-gradient(135deg, ${GLASS.accentSecondary} 0%, ${hexToRgba(GLASS.accentSecondary, 0.75)} 100%)`,
              color: '#04121a',
              fontSize: '0.82rem',
              fontWeight: 800,
              cursor: state.running ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              boxShadow: `0 8px 22px -8px ${hexToRgba(GLASS.accentSecondary, 0.6)}`,
              opacity: state.running ? 0.7 : 1,
            }}
          >
            <IconZap />
            {state.running ? 'Running…' : settled ? 'Run again' : 'Run 402 flow'}
          </button>
        </div>
      </div>

      {/* Timeline */}
      {state.steps.length === 0 ? (
        <div
          style={{
            padding: '30px 20px',
            textAlign: 'center',
            color: GLASS.textMuted,
            fontSize: '0.85rem',
            border: '1px dashed rgba(255,255,255,0.12)',
            borderRadius: 14,
          }}
        >
          Press <strong style={{ color: GLASS.accentSecondary }}>Run 402 flow</strong> to watch an agent pay for a metered request in real time.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {state.steps.map((s, i) => (
            <StepRow key={s.id} step={s} index={i} />
          ))}
        </div>
      )}

      {/* Settlement badge */}
      {state.settlement && (
        <div
          style={{
            marginTop: 16,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '14px 16px',
            borderRadius: 14,
            background: hexToRgba(GLASS.success, 0.08),
            border: `1px solid ${hexToRgba(GLASS.success, 0.3)}`,
          }}
        >
          <GlassChip label="Settled" color={GLASS.success} dot />
          <span style={{ fontSize: '0.85rem', color: GLASS.text, fontWeight: 700, fontFamily: 'ui-monospace, monospace' }}>
            {fmtMicro(state.settlement.charged)} {state.settlement.asset}
          </span>
          <span style={{ fontSize: '0.72rem', color: GLASS.textMuted, fontFamily: 'ui-monospace, monospace' }}>
            {state.settlement.tx_hash.slice(0, 14)}…
          </span>
          <span style={{ marginLeft: 'auto', fontSize: '0.66rem', color: GLASS.success, fontWeight: 700 }}>
            CDP VERIFIED
          </span>
        </div>
      )}
    </GlassPanel>
  );
}
