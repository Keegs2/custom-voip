/**
 * StatusGrid — the four at-a-glance stat tiles (Calls / Voicemail / Chat /
 * Devices) for the 360 view. Each tile is an interactive glass card tinted with
 * its own semantic accent.
 */

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { GlassCard } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { countCallsToday, fmtRelativeTime } from '../helpers';
import type { User360Response } from '../types';
import { IconChat, IconDevices, IconPhone, IconVoicemail } from './icons';

interface StatCardProps {
  icon: ReactNode;
  label: string;
  primary: string;
  secondary?: string;
  accent: string;
  index: number;
  linkTo?: string;
  linkLabel?: string;
}

function StatCard({ icon, label, primary, secondary, accent, index, linkTo, linkLabel }: StatCardProps) {
  return (
    <GlassCard accent={accent} index={index} style={{ flex: '1 1 160px', minWidth: 0 }}>
      <div style={{ padding: '18px 20px' }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 10,
            background: hexToRgba(accent, 0.12),
            border: `1px solid ${hexToRgba(accent, 0.28)}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: accent,
            marginBottom: 12,
          }}
        >
          {icon}
        </div>
        <div style={{ fontSize: '0.6rem', fontWeight: 700, color: GLASS.textMuted, textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 4 }}>
          {label}
        </div>
        <div style={{ fontSize: '1rem', fontWeight: 700, color: GLASS.text, fontVariantNumeric: 'tabular-nums', marginBottom: secondary ? 2 : 0 }}>
          {primary}
        </div>
        {secondary && <div style={{ fontSize: '0.72rem', color: GLASS.textMuted }}>{secondary}</div>}
        {linkTo && linkLabel && (
          <Link
            to={linkTo}
            style={{ display: 'inline-block', marginTop: 8, fontSize: '0.7rem', color: accent, textDecoration: 'none', opacity: 0.78, transition: 'opacity 0.1s' }}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.78'; }}
          >
            {linkLabel} →
          </Link>
        )}
      </div>
    </GlassCard>
  );
}

interface StatusGridProps {
  data: User360Response;
}

export function StatusGrid({ data }: StatusGridProps) {
  const { recent_calls, voicemail, chat, devices, extension } = data;

  const todayCount = countCallsToday(recent_calls);
  const lastCall = recent_calls[0] ?? null;

  const callPrimary = `${todayCount} call${todayCount !== 1 ? 's' : ''} today`;
  const callSecondary = lastCall ? `Last call ${fmtRelativeTime(lastCall.timestamp)}` : 'No recent calls';

  const vmPrimary = `${voicemail.unread} unread`;
  const vmSecondary = `${voicemail.total} total`;

  const chatPrimary = `${chat.total_conversations} conversation${chat.total_conversations !== 1 ? 's' : ''}`;
  const chatSecondary = chat.unread_messages > 0 ? `${chat.unread_messages} unread` : 'All read';

  const devicePrimary = devices.length === 0 ? 'No devices' : `${devices.length} registered`;
  const deviceSecondary = devices.length > 0 ? `via ${devices[0].user_agent.split('/')[0]}` : 'SIP endpoint not connected';

  const didLookupLink = extension?.did ? `/admin/did-search?did=${encodeURIComponent(extension.did)}` : undefined;

  return (
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      <StatCard
        index={0}
        accent="#0ea5e9"
        label="Calls"
        primary={callPrimary}
        secondary={callSecondary}
        linkTo={didLookupLink}
        linkLabel={didLookupLink ? 'View in DID Lookup' : undefined}
        icon={<IconPhone />}
      />
      <StatCard index={1} accent={GLASS.warning} label="Voicemail" primary={vmPrimary} secondary={vmSecondary} icon={<IconVoicemail />} />
      <StatCard index={2} accent="#8b5cf6" label="Chat" primary={chatPrimary} secondary={chatSecondary} icon={<IconChat />} />
      <StatCard
        index={3}
        accent={devices.length > 0 ? GLASS.success : GLASS.textFaint}
        label="Devices"
        primary={devicePrimary}
        secondary={deviceSecondary}
        icon={<IconDevices />}
      />
    </div>
  );
}
