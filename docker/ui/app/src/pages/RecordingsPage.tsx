/**
 * RecordingsPage — tenant-scoped call recordings (programmable voice, ad-hoc
 * calls, conferences). Thin composition layer: top-level filter state only; the
 * query + derived filtering live in `live/recordings/hooks`, the surfaces in the
 * glass kit + `live/recordings/components`. Mirrors the rcf-glass architecture.
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { useState } from 'react';
import { AlertCircle, Mic } from 'lucide-react';
import { GLASS } from '../components/glass/glass';
import { LiveHero } from './live/shared/LiveHero';
import { GlassStateCard, GlassSkeletonTable } from './live/shared/states';
import { useRecordings } from './live/recordings/hooks';
import { RecordingsControls } from './live/recordings/components/RecordingsControls';
import { RecordingsTable } from './live/recordings/components/RecordingsTable';
import type { KindFilter } from './live/recordings/types';

export function RecordingsPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const [kind, setKind] = useState<KindFilter>('');
  const [callFilter, setCallFilter] = useState('');
  const { isLoading, isError, error, recordings, filtered } = useRecordings({ kind, callFilter });

  return (
    <>
      <LiveHero
        eyebrow="Media Plane"
        title="Call Recordings"
        subtitle="Tenant-scoped recordings from programmable voice, ad-hoc calls, and conferences. Audio is served over short-lived presigned URLs."
      />

      <RecordingsControls kind={kind} onKind={setKind} callFilter={callFilter} onCallFilter={setCallFilter} />

      {isLoading ? (
        <GlassSkeletonTable columns={5} />
      ) : isError ? (
        <GlassStateCard
          icon={<AlertCircle size={26} />}
          title="Couldn't load recordings"
          body={error instanceof Error ? error.message : 'The request failed. Check your connection and try again.'}
          accent={GLASS.danger}
        />
      ) : filtered.length === 0 ? (
        <GlassStateCard
          icon={<Mic size={26} />}
          title={recordings.length === 0 ? 'No recordings yet' : 'No recordings match your filter'}
          body={recordings.length === 0 ? 'Recorded calls will appear here.' : 'Try a different call or recording UUID.'}
          accent={recordings.length === 0 ? GLASS.accent : GLASS.textFaint}
        />
      ) : (
        <RecordingsTable recordings={filtered} />
      )}
    </>
  );
}
