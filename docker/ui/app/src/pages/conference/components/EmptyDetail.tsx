/**
 * EmptyDetail — the right-panel placeholder shown when no room is selected.
 * A frosted glass shell with an ambient pulsing hero icon.
 */

import { Video } from 'lucide-react';
import { GLASS } from '../../../components/glass/glass';
import { GlassSheen } from '../../../components/glass/GlassCard';
import { panelShell, emptyHeroIcon } from '../styles';

export function EmptyDetail() {
  return (
    <div style={{ ...panelShell(), flex: 1, alignItems: 'center', justifyContent: 'center', padding: 48 }}>
      <GlassSheen />
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 18,
        }}
      >
        <div style={emptyHeroIcon()}>
          <Video size={36} strokeWidth={1.5} />
        </div>
        <div style={{ textAlign: 'center', maxWidth: 300 }}>
          <div
            style={{
              fontSize: '1.1rem',
              fontWeight: 700,
              color: GLASS.text,
              marginBottom: 8,
              letterSpacing: '-0.02em',
            }}
          >
            Select a meeting room
          </div>
          <div style={{ fontSize: '0.85rem', color: GLASS.textMuted, lineHeight: 1.6 }}>
            Pick a room from the list to see live status, schedule meetings, and manage participants.
          </div>
        </div>
      </div>
    </div>
  );
}
