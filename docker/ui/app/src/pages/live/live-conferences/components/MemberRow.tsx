/**
 * MemberRow — one live conference participant with moderator controls (mute /
 * kick). Talking members are highlighted with the accent. Control state comes
 * from `useMemberControl`.
 *
 * React #310: the control hook is the first call in the component.
 */

import { Mic, MicOff, PhoneOff } from 'lucide-react';
import type { LiveConferenceMember } from '../../../../types/conferenceLive';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { useMemberControl, memberName } from '../hooks';

interface MemberRowProps {
  room: string;
  member: LiveConferenceMember;
  onActed: () => void;
}

const ctrlBtn = (color: string, danger = false): React.CSSProperties => ({
  width: 30,
  height: 30,
  borderRadius: 8,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: hexToRgba(color, danger ? 0.08 : 0.06),
  border: `1px solid ${hexToRgba(color, danger ? 0.2 : 0.12)}`,
  color,
  cursor: 'pointer',
});

export function MemberRow({ room, member, onActed }: MemberRowProps) {
  const { busy, run } = useMemberControl(room, member, onActed);
  const name = memberName(member);
  const talking = !!member.talking;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 14px',
        borderRadius: 10,
        background: talking ? hexToRgba(GLASS.accent, 0.08) : 'rgba(255,255,255,0.02)',
        border: `1px solid ${talking ? hexToRgba(GLASS.accent, 0.25) : 'rgba(255,255,255,0.06)'}`,
        transition: 'background 0.2s, border-color 0.2s',
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 700,
          fontSize: '0.9rem',
          color: '#bfdbfe',
          flexShrink: 0,
          background: `linear-gradient(135deg, ${hexToRgba(GLASS.accent, 0.3)} 0%, ${hexToRgba(GLASS.cyan, 0.25)} 100%)`,
          border: talking ? `1.5px solid ${GLASS.accent}` : '1.5px solid transparent',
        }}
      >
        {name.charAt(0).toUpperCase()}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: '0.88rem', fontWeight: 600, color: GLASS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
        {talking && <div style={{ fontSize: '0.72rem', color: GLASS.success, fontWeight: 600 }}>Speaking</div>}
      </div>
      {member.muted && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 8px', borderRadius: 6, background: hexToRgba(GLASS.danger, 0.1), border: `1px solid ${hexToRgba(GLASS.danger, 0.2)}` }}>
          <MicOff size={11} color={GLASS.danger} />
          <span style={{ fontSize: '0.62rem', color: GLASS.danger, fontWeight: 700 }}>Muted</span>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6 }}>
        <button type="button" onClick={() => void run('mute')} disabled={busy !== null} title={member.muted ? 'Unmute' : 'Mute'} style={{ ...ctrlBtn(GLASS.textMuted), opacity: busy ? 0.5 : 1 }}>
          {member.muted ? <Mic size={13} /> : <MicOff size={13} />}
        </button>
        <button type="button" onClick={() => void run('kick')} disabled={busy !== null} title="Remove from conference" style={{ ...ctrlBtn(GLASS.danger, true), opacity: busy ? 0.5 : 1 }}>
          <PhoneOff size={13} />
        </button>
      </div>
    </div>
  );
}
