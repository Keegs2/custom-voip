/**
 * RecordingsControls — the kind selector + call-uuid search inside a glass
 * control bar. Stateless apart from the search field's focus (purely visual);
 * driven entirely by props.
 */

import { useState } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { filterLabel, glassInput, selectStyle } from '../../shared/styles';
import { KIND_OPTIONS, type KindFilter } from '../types';

interface RecordingsControlsProps {
  kind: KindFilter;
  onKind: (k: KindFilter) => void;
  callFilter: string;
  onCallFilter: (v: string) => void;
}

export function RecordingsControls({ kind, onKind, callFilter, onCallFilter }: RecordingsControlsProps) {
  const [focused, setFocused] = useState(false);

  return (
    <GlassPanel padding="14px 16px" style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div>
          <label style={filterLabel}>Kind</label>
          <select value={kind} onChange={(e) => onKind(e.target.value as KindFilter)} style={selectStyle}>
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div style={{ flex: '1 1 240px', minWidth: 200 }}>
          <label style={filterLabel}>Filter by call</label>
          <input
            value={callFilter}
            onChange={(e) => onCallFilter(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Call UUID or recording UUID…"
            style={glassInput(focused)}
          />
        </div>
      </div>
    </GlassPanel>
  );
}
