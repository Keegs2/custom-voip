/**
 * RecordingsTable — the frosted table of tenant-scoped recordings. Each row
 * shows date / kind / duration / call id plus an inline audio player and a
 * download affordance. The player follows the 307 → presigned URL transparently.
 */

import { Download } from 'lucide-react';
import type { Recording } from '../../../../types/recording';
import { recordingAudioUrl } from '../../../../api/recordings';
import { GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { GlassTable } from '../../shared/GlassTable';
import { MONO, td, th, thRight, theadRow, tdMono, truncId } from '../../shared/styles';
import { KIND_COLOR } from '../types';
import { fmtDurationMs, fmtRecordingDate } from '../hooks';

export function RecordingsTable({ recordings }: { recordings: Recording[] }) {
  return (
    <GlassTable
      head={
        <thead>
          <tr style={theadRow}>
            <th style={th}>Date</th>
            <th style={th}>Kind</th>
            <th style={th}>Duration</th>
            <th style={th}>Call</th>
            <th style={thRight}>Audio</th>
          </tr>
        </thead>
      }
    >
      {recordings.map((r) => {
        const href = recordingAudioUrl(r.id);
        const id = r.call_uuid ?? r.recording_uuid;
        return (
          <tr key={r.id}>
            <td style={{ ...td, whiteSpace: 'nowrap' }}>{fmtRecordingDate(r.created_at)}</td>
            <td style={td}>
              <GlassChip label={r.kind} color={KIND_COLOR[r.kind] ?? GLASS.textMuted} />
            </td>
            <td style={{ ...td, fontFamily: MONO, color: GLASS.textMuted }}>{fmtDurationMs(r.duration_ms)}</td>
            <td style={tdMono} title={id}>{truncId(id)}</td>
            <td style={td}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 12 }}>
                <audio controls preload="none" src={href} style={{ height: 32, maxWidth: 240 }} />
                <a
                  href={href}
                  download={`recording-${r.recording_uuid}.wav`}
                  title="Download"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    borderRadius: 8,
                    border: '1px solid rgba(255,255,255,0.10)',
                    background: 'rgba(255,255,255,0.04)',
                    color: GLASS.textMuted,
                  }}
                >
                  <Download size={15} />
                </a>
              </div>
            </td>
          </tr>
        );
      })}
    </GlassTable>
  );
}
