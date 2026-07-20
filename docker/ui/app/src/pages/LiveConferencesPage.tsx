/**
 * LiveConferencesPage — every active conference room across the tenant with live
 * moderator controls. Thin composition layer: the polling query lives in
 * `live/live-conferences/hooks`, the surfaces in `live/live-conferences/
 * components` + the glass kit.
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { AlertCircle, Video, WifiOff } from 'lucide-react';
import { GLASS } from '../components/glass/glass';
import { CARD_GAP } from './live/shared/styles';
import { LiveHero, LivePulse } from './live/shared/LiveHero';
import { GlassStateCard, GlassSkeletonTable } from './live/shared/states';
import { useLiveConferences } from './live/live-conferences/hooks';
import { ConferenceCard } from './live/live-conferences/components/ConferenceCard';

export function LiveConferencesPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const { isLoading, isError, error, eslOffline, count, conferences, refetch } = useLiveConferences();

  return (
    <>
      <LiveHero
        eyebrow="Collaboration"
        title="Live Conferences"
        subtitle="Every active conference room across your tenant, with live moderator controls."
        actions={<LivePulse label={isLoading ? 'live' : `${count} active`} />}
      />

      {isLoading ? (
        <GlassSkeletonTable columns={3} rows={3} />
      ) : isError ? (
        <GlassStateCard
          icon={<AlertCircle size={26} />}
          title="Couldn't load conferences"
          body={error instanceof Error ? error.message : 'The request failed. Check your connection and try again.'}
          accent={GLASS.danger}
        />
      ) : eslOffline ? (
        <GlassStateCard
          icon={<WifiOff size={26} />}
          title="Conference bridge offline"
          body="The FreeSWITCH event-socket bridge is unreachable, so live rooms can't be listed or controlled right now."
          accent={GLASS.warning}
        />
      ) : conferences.length === 0 ? (
        <GlassStateCard icon={<Video size={26} />} title="No conferences are currently in session" accent={GLASS.textFaint} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: CARD_GAP }}>
          {conferences.map((conf, i) => (
            <ConferenceCard key={conf.name} conference={conf} index={i} onActed={refetch} />
          ))}
        </div>
      )}
    </>
  );
}
