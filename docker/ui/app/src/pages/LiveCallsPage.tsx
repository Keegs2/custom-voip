import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { PhoneOff, ArrowRightLeft, Link2, Hash, RadioTower, WifiOff } from 'lucide-react';
import { listLiveCalls, updateCall } from '../api/liveCalls';
import type { LiveCall, CallAction, CallUpdateResponse } from '../types/liveCall';
import { ApiError } from '../api/client';
import { PageHeader } from '../components/layout/PageHeader';
import { CenteredSpinner } from '../components/ui/Spinner';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { useToast } from '../components/ui/ToastContext';

const POLL_MS = 4000;

/* ─── Helpers ────────────────────────────────────────────── */

function fmtSince(iso: string | null): string {
  if (!iso) return 'ringing';
  const secs = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

const inputCls =
  'text-xs px-2 py-1.5 rounded-md h-8 border border-[#2a2f45] bg-[#1e2130] text-[#e2e8f0] outline-none focus:border-[#3b82f6] placeholder:text-[#4a5568]';

/* ─── Per-call control row ───────────────────────────────── */

interface LiveCallRowProps {
  call: LiveCall;
  onActed: () => void;
}

function LiveCallRow({ call, onActed }: LiveCallRowProps) {
  // ALL hooks above any early return (React #310).
  const { toastOk, toastErr } = useToast();
  const [transferDest, setTransferDest] = useState('');
  const [voiceUrl, setVoiceUrl] = useState('');
  const [digits, setDigits] = useState('');
  const [busy, setBusy] = useState<CallAction | null>(null);
  const [lastResult, setLastResult] = useState<CallUpdateResponse | null>(null);

  const act = async (action: CallAction, extra: Record<string, string> = {}) => {
    setBusy(action);
    setLastResult(null);
    try {
      const res = await updateCall(call.uuid, { action, ...extra });
      setLastResult(res);
      if (res.ok) {
        toastOk(
          res.confirmed
            ? `${action} confirmed by FreeSWITCH`
            : `${action} sent (awaiting confirmation)`,
        );
      } else {
        toastErr(`${action} was not accepted`);
      }
      onActed();
    } catch (err) {
      toastErr(err instanceof ApiError ? err.message : `Failed to ${action} call`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div
      className="rounded-xl p-4"
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
      }}
    >
      {/* Call summary */}
      <div className="flex items-center gap-3 flex-wrap mb-3">
        <Badge variant={call.direction === 'inbound' ? 'inbound' : 'outbound'}>
          {call.direction}
        </Badge>
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono text-[#e2e8f0]">{call.caller}</span>
          <ArrowRightLeft size={13} className="text-[#475569]" />
          <span className="font-mono text-[#e2e8f0]">{call.dest}</span>
        </div>
        <span
          className="text-[0.65rem] font-bold uppercase tracking-wide px-2 py-1 rounded-md"
          style={{ color: '#94a3b8', background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(42,47,69,0.6)' }}
        >
          {call.state}
        </span>
        <span className="text-xs text-[#64748b] tabular-nums ml-auto">
          {call.answered_at ? `answered ${fmtSince(call.answered_at)}` : 'unanswered'}
        </span>
      </div>

      <div className="font-mono text-[0.65rem] text-[#475569] mb-3 truncate" title={call.uuid}>
        {call.uuid}
      </div>

      {/* Controls */}
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))' }}>
        {/* Hangup */}
        <div className="flex items-center">
          <Button
            variant="danger"
            size="sm"
            icon={<PhoneOff size={13} />}
            loading={busy === 'hangup'}
            disabled={busy !== null}
            onClick={() => void act('hangup')}
          >
            Hangup
          </Button>
        </div>

        {/* Transfer */}
        <div className="flex items-center gap-2">
          <input
            className={`${inputCls} flex-1`}
            placeholder="Transfer to number"
            value={transferDest}
            onChange={(e) => setTransferDest(e.target.value)}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={<ArrowRightLeft size={13} />}
            loading={busy === 'transfer'}
            disabled={busy !== null || !transferDest.trim()}
            onClick={() => void act('transfer', { destination: transferDest.trim() })}
          >
            Transfer
          </Button>
        </div>

        {/* Redirect */}
        <div className="flex items-center gap-2">
          <input
            className={`${inputCls} flex-1`}
            placeholder="Redirect voice_url"
            value={voiceUrl}
            onChange={(e) => setVoiceUrl(e.target.value)}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={<Link2 size={13} />}
            loading={busy === 'redirect'}
            disabled={busy !== null || !voiceUrl.trim()}
            onClick={() => void act('redirect', { voice_url: voiceUrl.trim() })}
          >
            Redirect
          </Button>
        </div>

        {/* DTMF */}
        <div className="flex items-center gap-2">
          <input
            className={`${inputCls} flex-1`}
            placeholder="DTMF digits"
            value={digits}
            onChange={(e) => setDigits(e.target.value.replace(/[^0-9*#A-Da-d]/g, ''))}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={<Hash size={13} />}
            loading={busy === 'dtmf'}
            disabled={busy !== null || !digits.trim()}
            onClick={() => void act('dtmf', { digits: digits.trim() })}
          >
            Send
          </Button>
        </div>
      </div>

      {/* Confirmation feedback */}
      {lastResult && (
        <div
          className="mt-3 text-xs px-3 py-2 rounded-md"
          style={{
            color: lastResult.confirmed ? '#6ee7b7' : '#fbbf24',
            background: lastResult.confirmed ? 'rgba(16,185,129,0.08)' : 'rgba(245,158,11,0.08)',
            border: `1px solid ${lastResult.confirmed ? 'rgba(16,185,129,0.2)' : 'rgba(245,158,11,0.2)'}`,
          }}
        >
          ok: {String(lastResult.ok)} · confirmed: {String(lastResult.confirmed)}
        </div>
      )}
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────── */

export function LiveCallsPage() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['live-calls'],
    queryFn: listLiveCalls,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });

  const calls = useMemo(() => data?.calls ?? [], [data]);
  // esl_connected is only "offline" when explicitly false; undefined = unknown/ok.
  const eslOffline = data?.esl_connected === false;

  return (
    <>
      <PageHeader
        title="Live Calls"
        subtitle={`Active calls with in-dialog control. Auto-refreshes every ${POLL_MS / 1000}s.`}
        actions={
          <span className="inline-flex items-center gap-1.5 text-xs text-[#64748b]">
            <RadioTower size={13} className="text-[#22c55e]" />
            live
          </span>
        }
      />

      {isLoading ? (
        <CenteredSpinner label="Loading live calls…" />
      ) : isError ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.08] text-red-300 text-sm px-4 py-3">
          {error instanceof Error ? error.message : 'Failed to load live calls.'}
        </div>
      ) : eslOffline ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-[#64748b]">
          <WifiOff size={34} strokeWidth={1.5} className="text-[#f59e0b]" />
          <div className="text-base font-semibold text-[#94a3b8]">Control plane offline</div>
          <div className="text-sm text-center max-w-sm">
            The FreeSWITCH event-socket bridge is unreachable, so live calls can't be
            listed or controlled right now. This view will recover automatically once
            the bridge is back.
          </div>
        </div>
      ) : calls.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-[#475569]">
          <RadioTower size={34} strokeWidth={1.5} />
          <div className="text-sm">No active calls right now.</div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {calls.map((call) => (
            <LiveCallRow key={call.uuid} call={call} onActed={() => void refetch()} />
          ))}
        </div>
      )}
    </>
  );
}
