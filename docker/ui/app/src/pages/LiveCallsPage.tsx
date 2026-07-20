/**
 * LiveCallsPage — active calls with in-dialog control, auto-refreshing. Thin
 * composition layer: the polling query lives in `live/live-calls/hooks`, the
 * per-call control state + surfaces in `live/live-calls/components` + the glass
 * kit.
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { AlertCircle, RadioTower, WifiOff } from 'lucide-react';
import { GLASS } from '../components/glass/glass';
import { CARD_GAP } from './live/shared/styles';
import { LiveHero, LivePulse } from './live/shared/LiveHero';
import { GlassStateCard, GlassSkeletonTable } from './live/shared/states';
import { useLiveCalls, POLL_MS } from './live/live-calls/hooks';
import { LiveCallCard } from './live/live-calls/components/LiveCallCard';

export function LiveCallsPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const { isLoading, isError, error, eslOffline, calls, refetch } = useLiveCalls();

  return (
    <>
      <LiveHero
        eyebrow="Control Plane"
        title="Live Calls"
        subtitle={`Active calls with in-dialog control. Auto-refreshes every ${POLL_MS / 1000}s.`}
        actions={<LivePulse label="live" />}
      />

      {isLoading ? (
        <GlassSkeletonTable columns={3} rows={4} />
      ) : isError ? (
        <GlassStateCard
          icon={<AlertCircle size={26} />}
          title="Couldn't load live calls"
          body={error instanceof Error ? error.message : 'The request failed. Check your connection and try again.'}
          accent={GLASS.danger}
        />
      ) : eslOffline ? (
        <GlassStateCard
          icon={<WifiOff size={26} />}
          title="Control plane offline"
          body="The FreeSWITCH event-socket bridge is unreachable, so live calls can't be listed or controlled right now. This view will recover automatically once the bridge is back."
          accent={GLASS.warning}
        />
      ) : calls.length === 0 ? (
        <GlassStateCard icon={<RadioTower size={26} />} title="No active calls right now" accent={GLASS.textFaint} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: CARD_GAP }}>
          {calls.map((call, i) => (
            <LiveCallCard key={call.uuid} call={call} index={i} onActed={refetch} />
          ))}
        </div>
      )}
    </>
  );
}
