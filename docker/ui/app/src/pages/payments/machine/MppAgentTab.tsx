/**
 * MppAgentTab — the Stripe MPP agent "tab": a spend-limited session that streams
 * batched micro-charges as an AI voice agent consumes minutes/requests, then
 * settles. This is the flagship wow: open a tab, hit "Stream usage", and watch
 * the spend bar fill and micro-charges cascade in real time.
 *
 * Presentational + light local control: opening a tab and starting/stopping the
 * stream come from the machine hooks; live session figures come from the polled
 * MPP sessions query passed in as `sessions`.
 *
 * React #310: all hooks unconditionally at the top.
 */

import { GlassPanel, GlassChip } from '../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import { DemoBadge } from '../../../components/payments/DemoBadge';
import { AnimatedNumber } from '../../../components/payments/AnimatedNumber';
import { fmtMicro, fmtDollars } from '../../../components/payments/format';
import { MONO } from '../styles';
import { IconAgent } from '../components/icons';
import { useCreateMppSession, useMppStreamer } from './hooks';
import type { MppSession } from '../../../types/payments';

const AGENT_NAMES = ['Support voicebot', 'Outbound SDR agent', 'Survey caller', 'Appointment reminder bot'];

function statusMeta(status: MppSession['status']): { color: string; label: string } {
  switch (status) {
    case 'open':
      return { color: GLASS.success, label: 'Open' };
    case 'settled':
      return { color: GLASS.accent, label: 'Settled' };
    default:
      return { color: GLASS.textFaint, label: 'Closed' };
  }
}

function SessionRow({
  session,
  streaming,
  onStream,
  onStop,
  recentIds,
}: {
  session: MppSession;
  streaming: boolean;
  onStream: () => void;
  onStop: () => void;
  recentIds: string[];
}) {
  const pct = Math.min(100, (session.total_charged / Math.max(0.0001, session.spend_limit)) * 100);
  const meta = statusMeta(session.status);
  const isOpen = session.status === 'open';
  const idStr = String(session.id);
  return (
    <div
      style={{
        padding: '16px 18px',
        borderRadius: 16,
        background: streaming ? hexToRgba(GLASS.accent, 0.06) : 'rgba(255,255,255,0.03)',
        border: `1px solid ${streaming ? hexToRgba(GLASS.accent, 0.3) : 'rgba(255,255,255,0.08)'}`,
        transition: 'background 0.3s, border-color 0.3s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12, flexWrap: 'wrap' }}>
        <span
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: hexToRgba('#a78bfa', 0.14),
            border: `1px solid ${hexToRgba('#a78bfa', 0.3)}`,
            color: '#a78bfa',
            flexShrink: 0,
          }}
        >
          <IconAgent />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: '0.92rem', fontWeight: 700, color: GLASS.text }}>{session.label ?? `Agent tab #${idStr}`}</div>
          <div style={{ fontSize: '0.68rem', color: GLASS.textFaint, fontFamily: MONO }}>
            Shared Payment Token (card) · {session.provider_session_id.slice(0, 16)}…
          </div>
        </div>
        <GlassChip label={meta.label} color={meta.color} dot={isOpen} />
      </div>

      {/* Spend bar */}
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 6 }}>
        <AnimatedNumber
          value={session.total_charged}
          format={(v) => fmtDollars(v, 4)}
          style={{ fontSize: '1.35rem', fontWeight: 800, fontFamily: MONO, color: GLASS.text }}
          flashColor="#c4b5fd"
        />
        <span style={{ fontSize: '0.72rem', color: GLASS.textMuted, fontFamily: MONO }}>
          / {fmtDollars(session.spend_limit, 2)} limit
        </span>
      </div>
      <div style={{ height: 8, borderRadius: 999, background: 'rgba(255,255,255,0.06)', overflow: 'hidden', border: '1px solid rgba(255,255,255,0.06)' }}>
        <div
          style={{
            width: `${pct}%`,
            height: '100%',
            borderRadius: 999,
            background: `linear-gradient(90deg, #a78bfa, ${GLASS.accentSecondary})`,
            boxShadow: `0 0 14px -2px ${hexToRgba('#a78bfa', 0.8)}`,
            transition: 'width 0.6s cubic-bezier(0.2,0.7,0.3,1)',
          }}
        />
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        {isOpen && !streaming && (
          <button
            type="button"
            onClick={onStream}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '8px 14px',
              borderRadius: 10,
              border: 'none',
              background: `linear-gradient(135deg, #a78bfa, #8b5cf6)`,
              color: '#fff',
              fontSize: '0.78rem',
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
              boxShadow: `0 6px 18px -6px ${hexToRgba('#a78bfa', 0.7)}`,
            }}
          >
            Stream usage
          </button>
        )}
        {streaming && (
          <button
            type="button"
            onClick={onStop}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              padding: '8px 14px',
              borderRadius: 10,
              border: `1px solid ${hexToRgba(GLASS.warning, 0.4)}`,
              background: hexToRgba(GLASS.warning, 0.1),
              color: GLASS.warning,
              fontSize: '0.78rem',
              fontWeight: 700,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            <span style={{ width: 7, height: 7, borderRadius: '50%', background: GLASS.warning, boxShadow: `0 0 8px ${GLASS.warning}`, animation: 'glass-shimmer 1s ease-in-out infinite' }} />
            Streaming — stop
          </button>
        )}
        {!isOpen && (
          <span style={{ fontSize: '0.74rem', color: GLASS.textMuted, alignSelf: 'center' }}>
            {session.settlement_ref ? `Batch-settled · ${session.settlement_ref.slice(0, 14)}…` : 'Session complete'}
          </span>
        )}
      </div>

      {/* Recently-streamed charges for the active tab */}
      {streaming && recentIds.length > 0 && (
        <div style={{ marginTop: 10, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {recentIds.slice(0, 6).map((label, i) => (
            <span
              key={`${label}-${i}`}
              className="glass-rise"
              style={{
                fontSize: '0.64rem',
                fontFamily: MONO,
                color: '#c4b5fd',
                background: hexToRgba('#a78bfa', 0.1),
                border: `1px solid ${hexToRgba('#a78bfa', 0.24)}`,
                borderRadius: 999,
                padding: '3px 9px',
                animation: 'glass-rise 0.35s ease both',
              }}
            >
              {label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function MppAgentTab({ sessions }: { sessions: MppSession[] }) {
  // ── ALL hooks first (React #310) ────────────────────────────────────────────
  const streamer = useMppStreamer();
  const createSession = useCreateMppSession((s) => streamer.start(s.id));

  const openNewTab = () => {
    const name = AGENT_NAMES[Math.floor(Math.random() * AGENT_NAMES.length)];
    createSession.mutate({
      label: `${name} #${Math.floor(Math.random() * 900 + 100)}`,
      spend_limit: 5, // $5.00 spend cap
    });
  };

  // Newest sessions first for the stage.
  const ordered = [...sessions].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const recentLabels = streamer.recent.map((c) => `${fmtMicro(c.amount)} · ${c.reason}`);

  return (
    <GlassPanel padding="24px 26px" radius={20}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, marginBottom: 18, flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '0.6rem', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: hexToRgba('#a78bfa', 0.9), marginBottom: 6 }}>
            Stripe MPP · agent tabs
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <h2 style={{ fontSize: '1.05rem', fontWeight: 700, color: GLASS.text, margin: 0 }}>AI agents pay per-request</h2>
            <DemoBadge size="xs" />
          </div>
          <p style={{ fontSize: '0.82rem', color: GLASS.textMuted, margin: '4px 0 0', lineHeight: 1.5, maxWidth: 560 }}>
            Each autonomous agent opens a spend-limited tab and streams micro-charges as it works, then batch-settles. Payment-method-agnostic: a Shared Payment Token (card) or stablecoin on Tempo.
          </p>
        </div>
        <button
          type="button"
          onClick={openNewTab}
          disabled={createSession.isPending}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '10px 18px',
            borderRadius: 12,
            border: 'none',
            background: `linear-gradient(135deg, #a78bfa, #8b5cf6)`,
            color: '#fff',
            fontSize: '0.82rem',
            fontWeight: 700,
            cursor: createSession.isPending ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            boxShadow: `0 8px 22px -8px ${hexToRgba('#a78bfa', 0.6)}`,
            opacity: createSession.isPending ? 0.7 : 1,
            flexShrink: 0,
          }}
        >
          <IconAgent />
          {createSession.isPending ? 'Opening…' : 'Open agent tab'}
        </button>
      </div>

      {ordered.length === 0 ? (
        <div
          style={{
            padding: '30px 20px',
            textAlign: 'center',
            color: GLASS.textMuted,
            fontSize: '0.85rem',
            border: '1px dashed rgba(167,139,250,0.3)',
            borderRadius: 14,
          }}
        >
          No agent tabs yet. Open one to watch an AI agent stream micro-charges as it works.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {ordered.map((s) => (
            <SessionRow
              key={s.id}
              session={s}
              streaming={streamer.streamingId === s.id}
              recentIds={recentLabels}
              onStream={() => streamer.start(s.id)}
              onStop={streamer.stop}
            />
          ))}
        </div>
      )}
    </GlassPanel>
  );
}
