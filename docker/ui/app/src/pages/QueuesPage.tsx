/**
 * QueuesPage — live ACD queue depth; expand a queue to inspect waiting callers.
 * Thin composition layer: the polling query lives in `live/queues/hooks`, the
 * surfaces in the glass kit + `live/queues/components`. Only top-level expanded
 * state is held here.
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { useState } from 'react';
import { AlertCircle, ListOrdered, WifiOff } from 'lucide-react';
import { GLASS } from '../components/glass/glass';
import { CARD_GAP } from './live/shared/styles';
import { LiveHero, LivePulse } from './live/shared/LiveHero';
import { GlassStateCard, GlassSkeletonTable } from './live/shared/states';
import { useQueues } from './live/queues/hooks';
import { QueueRow } from './live/queues/components/QueueRow';

export function QueuesPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const [expanded, setExpanded] = useState<string | null>(null);
  const { isLoading, isError, error, eslOffline, queues } = useQueues();

  return (
    <>
      <LiveHero
        eyebrow="Contact Center"
        title="Call Queues"
        subtitle="Live ACD queue depth. Expand a queue to inspect the waiting callers."
        actions={<LivePulse label="live" />}
      />

      {isLoading ? (
        <GlassSkeletonTable columns={3} rows={5} />
      ) : isError ? (
        <GlassStateCard
          icon={<AlertCircle size={26} />}
          title="Couldn't load queues"
          body={error instanceof Error ? error.message : 'The request failed. Check your connection and try again.'}
          accent={GLASS.danger}
        />
      ) : eslOffline ? (
        <GlassStateCard
          icon={<WifiOff size={26} />}
          title="Queue engine offline"
          body="The FreeSWITCH event-socket bridge is unreachable, so queue depth can't be read right now. This view recovers automatically once the bridge is back."
          accent={GLASS.warning}
        />
      ) : queues.length === 0 ? (
        <GlassStateCard icon={<ListOrdered size={26} />} title="No queues configured" accent={GLASS.textFaint} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: CARD_GAP }}>
          {queues.map((q, i) => (
            <QueueRow
              key={q.name}
              queue={q}
              index={i}
              isOpen={expanded === q.name}
              onToggle={() => setExpanded(expanded === q.name ? null : q.name)}
            />
          ))}
        </div>
      )}
    </>
  );
}
