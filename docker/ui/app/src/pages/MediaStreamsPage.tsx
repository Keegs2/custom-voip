/**
 * MediaStreamsPage — live media taps pumped by the media plane (one row per
 * captured call leg), plus a transcription-ready info banner. Thin composition
 * layer: the polling query + rollups live in `live/media-streams/hooks`, the
 * surfaces in the glass kit + `live/media-streams/components`.
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { AlertCircle, Waves, WifiOff } from 'lucide-react';
import { GLASS } from '../components/glass/glass';
import { LiveHero, LivePulse } from './live/shared/LiveHero';
import { GlassStateCard, GlassSkeletonTable } from './live/shared/states';
import { useMediaStreams } from './live/media-streams/hooks';
import { TranscriptionNote } from './live/media-streams/components/TranscriptionNote';
import { MediaStatTiles } from './live/media-streams/components/MediaStatTiles';
import { MediaStreamsTable } from './live/media-streams/components/MediaStreamsTable';

export function MediaStreamsPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const { isLoading, isError, error, eslOffline, streams, totalBytes, totalFrames } = useMediaStreams();

  return (
    <>
      <LiveHero
        eyebrow="Media Plane"
        title="Media & Transcription Monitor"
        subtitle="Live media taps pumped by the media plane — one row per captured call leg."
        actions={<LivePulse label="live" />}
      />

      <TranscriptionNote />

      {isLoading ? (
        <GlassSkeletonTable columns={5} />
      ) : isError ? (
        <GlassStateCard
          icon={<AlertCircle size={26} />}
          title="Couldn't load media streams"
          body={error instanceof Error ? error.message : 'The request failed. Check your connection and try again.'}
          accent={GLASS.danger}
        />
      ) : eslOffline ? (
        <GlassStateCard
          icon={<WifiOff size={26} />}
          title="Media plane offline"
          body="The media control bridge is unreachable, so active streams can't be listed right now."
          accent={GLASS.warning}
        />
      ) : (
        <>
          <MediaStatTiles count={streams.length} totalFrames={totalFrames} totalBytes={totalBytes} />
          {streams.length === 0 ? (
            <GlassStateCard icon={<Waves size={26} />} title="No active media streams" accent={GLASS.textFaint} />
          ) : (
            <MediaStreamsTable streams={streams} />
          )}
        </>
      )}
    </>
  );
}
