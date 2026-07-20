/**
 * MediaStreamsTable — the frosted table of live media taps, one row per captured
 * call leg with its frame / byte / duration counters.
 */

import type { MediaStream } from '../../../../types/mediaStream';
import { GlassTable } from '../../shared/GlassTable';
import { GLASS } from '../../../../components/glass/glass';
import { th, thRight, tdMono, tdNum, td, theadRow, truncId } from '../../shared/styles';
import { fmtBytes, fmtStreamDurationMs, fmtNum } from '../hooks';

export function MediaStreamsTable({ streams }: { streams: MediaStream[] }) {
  return (
    <GlassTable
      head={
        <thead>
          <tr style={theadRow}>
            <th style={th}>Call</th>
            <th style={thRight}>Frames</th>
            <th style={thRight}>Bytes</th>
            <th style={thRight}>Duration</th>
            <th style={thRight}>Started</th>
          </tr>
        </thead>
      }
    >
      {streams.map((s) => (
        <tr key={s.call_uuid}>
          <td style={tdMono} title={s.call_uuid}>{truncId(s.call_uuid, 20)}</td>
          <td style={tdNum}>{fmtNum(s.frames)}</td>
          <td style={tdNum}>{fmtBytes(s.bytes)}</td>
          <td style={tdNum}>{fmtStreamDurationMs(s.duration_ms)}</td>
          <td style={{ ...td, textAlign: 'right', whiteSpace: 'nowrap', color: GLASS.textMuted, fontSize: '0.78rem' }}>
            {new Date(s.started_at).toLocaleTimeString()}
          </td>
        </tr>
      ))}
    </GlassTable>
  );
}
