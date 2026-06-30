/**
 * MediaStatTiles — the three frosted summary tiles above the media-streams
 * table: active stream count, total frames, total bytes.
 */

import { GLASS } from '../../../../components/glass/glass';
import { statTile, statTileLabel, statTileValue, CARD_GAP } from '../../shared/styles';
import { fmtBytes, fmtNum } from '../hooks';

interface MediaStatTilesProps {
  count: number;
  totalFrames: number;
  totalBytes: number;
}

export function MediaStatTiles({ count, totalFrames, totalBytes }: MediaStatTilesProps) {
  const tiles: { label: string; value: string; accent: string }[] = [
    { label: 'Active Streams', value: fmtNum(count), accent: GLASS.accent },
    { label: 'Total Frames', value: fmtNum(totalFrames), accent: GLASS.cyan },
    { label: 'Total Bytes', value: fmtBytes(totalBytes), accent: GLASS.green },
  ];

  return (
    <div
      style={{
        display: 'grid',
        gap: CARD_GAP,
        gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
        marginBottom: 24,
      }}
    >
      {tiles.map((t) => (
        <div key={t.label} style={statTile(t.accent)}>
          <span style={statTileLabel}>{t.label}</span>
          <span style={statTileValue(t.accent)}>{t.value}</span>
        </div>
      ))}
    </div>
  );
}
