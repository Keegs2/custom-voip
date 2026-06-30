/**
 * ConferenceCard — one active conference room inside a frosted card: a header
 * (room icon, name, member count) over the live member roster.
 */

import { Video, Users } from 'lucide-react';
import type { LiveConference } from '../../../../types/conferenceLive';
import { GlassCard } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { MemberRow } from './MemberRow';

interface ConferenceCardProps {
  conference: LiveConference;
  index: number;
  onActed: () => void;
}

export function ConferenceCard({ conference, index, onActed }: ConferenceCardProps) {
  return (
    <GlassCard index={index} style={{ padding: '20px 22px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
            color: GLASS.blue,
            background: hexToRgba(GLASS.accent, 0.12),
            border: `1px solid ${hexToRgba(GLASS.accent, 0.25)}`,
          }}
        >
          <Video size={16} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '0.95rem', fontWeight: 700, color: GLASS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{conference.name}</div>
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '0.78rem', color: GLASS.textMuted }}>
          <Users size={13} color={GLASS.textFaint} />
          {conference.member_count} {conference.member_count === 1 ? 'member' : 'members'}
        </span>
      </div>

      {conference.members.length === 0 ? (
        <div style={{ fontSize: '0.85rem', color: GLASS.textFaint, padding: '6px 2px' }}>Room is active but reports no members.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {conference.members.map((m) => (
            <MemberRow key={m.id} room={conference.name} member={m} onActed={onActed} />
          ))}
        </div>
      )}
    </GlassCard>
  );
}
