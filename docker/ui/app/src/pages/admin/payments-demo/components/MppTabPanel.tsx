/**
 * MppTabPanel — the interactive Stripe MPP agent "tab": open a spend-limited
 * session, stream micro-charges as a (simulated) voice agent works, watch the
 * spend meter fill, hit the enforced limit (a refused 409 overrun), then
 * batch-settle the whole tab as ONE ledger entry.
 *
 * Sessions come from the polled demo-state read; streaming is local +
 * co-invalidating (hooks.useMppStreamer). React #310: hooks at the top.
 */

import { useState } from 'react';
import { Bot, Plus } from 'lucide-react';
import { useToast } from '../../../../components/ui/Toast';
import { ApiError } from '../../../../api/client';
import { Spinner } from '../../../../components/ui/Spinner';
import { chargeMppSession, createMppSession } from '../api';
import { useMppStreamer, usePaymentsInvalidate } from '../hooks';
import { fmtDollars, fmtMicro, fmtRef } from '../format';
import type { MppSessionState } from '../types';

const TAB_LIMIT = 5; // $5.00 spend cap per walkthrough tab
const AGENT_NAMES = ['Support voicebot', 'Outbound SDR agent', 'Survey caller', 'Reminder bot'];

function statusPill(status: MppSessionState['status']): { cls: string; label: string } {
  switch (status) {
    case 'open':
      return { cls: 'dl-pill dl-pill-on', label: 'Open' };
    case 'settled':
      return { cls: 'dl-tag', label: 'Settled' };
    default:
      return { cls: 'dl-tag dl-tag-slate', label: 'Closed' };
  }
}

interface SessionRowProps {
  session: MppSessionState;
  streaming: boolean;
  overran: boolean;
  recent: { amount: number; reason: string }[];
  settling: boolean;
  onStream: () => void;
  onStop: () => void;
  onSettle: () => void;
}

function SessionRow({
  session,
  streaming,
  overran,
  recent,
  settling,
  onStream,
  onStop,
  onSettle,
}: SessionRowProps) {
  const pct = Math.min(100, (session.total_charged / Math.max(0.0001, session.spend_limit)) * 100);
  const pill = statusPill(session.status);
  const isOpen = session.status === 'open';

  return (
    <div className="dl-item dlx9-tab-row">
      <div className="dlx9-tab-head">
        <span className="dlx9-scen-icon dlx9-tone-cyan" style={{ width: 32, height: 32 }}>
          <Bot size={16} strokeWidth={1.8} />
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: '0.84rem', fontWeight: 700, color: 'var(--rcf-ink)' }}>
            {session.label ?? `Agent tab #${session.id}`}
          </div>
          <div className="dlx9-ref" style={{ marginTop: 1 }}>
            {session.provider_session_id.slice(0, 18)}… · {session.charge_count} charge
            {session.charge_count === 1 ? '' : 's'}
          </div>
        </div>
        <span className={pill.cls}>{pill.label}</span>
      </div>

      <div>
        <div className="dlx9-tab-figures">
          <span className="dlx9-tab-total">{fmtDollars(session.total_charged)}</span>
          <span className="dlx9-tab-limit">of {fmtDollars(session.spend_limit)} limit</span>
        </div>
        <div className="dl-meter" style={{ marginTop: 6 }}>
          <div
            className="dl-meter-fill"
            style={{
              width: `${pct}%`,
              background: 'linear-gradient(90deg, #0e7490, var(--rcf-azure))',
            }}
          />
        </div>
      </div>

      {overran && (
        <span className="dlx-warnchip">Overrun refused — spend limit enforced (409)</span>
      )}

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {isOpen && !streaming && (
          <button type="button" className="dl-btn dl-btn-primary dlx-btn-sm" onClick={onStream}>
            Stream usage
          </button>
        )}
        {streaming && (
          <button type="button" className="dl-btn dl-btn-ghost dlx-btn-sm" onClick={onStop}>
            <Spinner size="xs" /> Streaming — stop
          </button>
        )}
        {isOpen && (
          <button
            type="button"
            className="dl-btn dl-btn-ghost dlx-btn-sm"
            onClick={onSettle}
            disabled={settling || streaming}
          >
            {settling ? 'Settling…' : 'Settle tab'}
          </button>
        )}
        {!isOpen && session.settlement_ref && (
          <span style={{ fontSize: '0.7rem', color: 'var(--rcf-ink-dim)' }}>
            Batch-settled as one ledger entry · {fmtRef(session.settlement_ref)}
          </span>
        )}
      </div>

      {streaming && recent.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {recent.map((t, i) => (
            <span key={`${t.reason}-${i}`} className="dlx9-tick">
              {fmtMicro(t.amount)} · {t.reason}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function MppTabPanel({ sessions }: { sessions: MppSessionState[] }) {
  // ── ALL hooks first (React #310) ─────────────────────────────────────────
  const streamer = useMppStreamer();
  const invalidate = usePaymentsInvalidate();
  const { toastOk, toastErr } = useToast();
  const [opening, setOpening] = useState(false);
  const [settlingId, setSettlingId] = useState<number | null>(null);

  const openTab = async () => {
    setOpening(true);
    try {
      const name = AGENT_NAMES[Math.floor(Math.random() * AGENT_NAMES.length)];
      const s = await createMppSession({
        spend_limit: TAB_LIMIT,
        label: `${name} #${Math.floor(Math.random() * 900 + 100)}`,
      });
      toastOk(`Agent tab opened · ${s.label ?? `#${s.id}`} · ${fmtDollars(TAB_LIMIT)} cap`);
      await invalidate();
      streamer.start(s.id);
    } catch (err) {
      toastErr(err instanceof Error ? err.message : 'Could not open agent tab');
    } finally {
      setOpening(false);
    }
  };

  const settleTab = async (id: number) => {
    setSettlingId(id);
    try {
      streamer.stop();
      // There is no standalone settle endpoint — settlement rides the last
      // charge (`settle: true`), so add one final small tick and close.
      const r = await chargeMppSession(id, { amount: 0.01, settle: true });
      toastOk(`Tab settled · ${fmtDollars(r.settlement?.amount ?? r.total_charged)} posted as one entry`);
      await invalidate();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        toastErr('Tab is exactly at its limit — the final settling tick was refused');
      } else {
        toastErr(err instanceof Error ? err.message : 'Settle failed');
      }
    } finally {
      setSettlingId(null);
    }
  };

  const ordered = [...sessions].sort((a, b) => b.id - a.id);

  return (
    <section className="dl-panel">
      <div className="dl-panel-head">
        <span className="dl-panel-title">Agent tabs — Stripe MPP</span>
        <span className="dl-count">{ordered.length}</span>
        <span style={{ marginLeft: 'auto' }}>
          <button
            type="button"
            className="dl-btn dl-btn-primary dlx-btn-sm"
            onClick={() => void openTab()}
            disabled={opening}
          >
            <Plus size={13} strokeWidth={2.4} />
            {opening ? 'Opening…' : `Open ${fmtDollars(TAB_LIMIT)} tab`}
          </button>
        </span>
        <p className="dl-panel-sub">
          A spend-limited session an autonomous agent streams micro-charges onto, then batch-settles
          as one ledger entry. The limit is enforced server-side — an overrunning charge is refused.
        </p>
      </div>

      <div className="dl-panel-body">
        {ordered.length === 0 ? (
          <div className="dl-empty">
            No agent tabs yet. Open one and stream usage to watch the spend meter fill until the
            limit refuses the overrun.
          </div>
        ) : (
          <div className="dl-stack" style={{ gap: 12 }}>
            {ordered.map((s) => (
              <SessionRow
                key={s.id}
                session={s}
                streaming={streamer.streamingId === s.id}
                overran={streamer.overrunId === s.id}
                recent={streamer.recent}
                settling={settlingId === s.id}
                onStream={() => streamer.start(s.id)}
                onStop={streamer.stop}
                onSettle={() => void settleTab(s.id)}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
