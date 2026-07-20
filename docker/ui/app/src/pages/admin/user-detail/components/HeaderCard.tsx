/**
 * HeaderCard — the identity hero for the 360 view: avatar + name/role/status,
 * the big extension/DID readout, presence, last-login, and the edit toggle.
 * Wrapped in the canonical blue glass panel.
 */

import { Link } from 'react-router-dom';
import { GlassPanel, GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { Badge } from '../../../../components/ui/Badge';
import { fmt } from '../../../../utils/format';
import { fmtRelativeTime } from '../helpers';
import { PRESENCE_CONFIG, ROLE_CONFIG, ACCOUNT_TYPE_CONFIG } from '../constants';
import type { User360Response } from '../types';
import { MONO } from '../styles';
import { Avatar } from './Avatar';
import { IconExternal, IconPencil, IconX } from './icons';

interface HeaderCardProps {
  data: User360Response;
  isEditing: boolean;
  onEditToggle: () => void;
}

export function HeaderCard({ data, isEditing, onEditToggle }: HeaderCardProps) {
  const { user, extension, presence } = data;
  const presenceCfg = PRESENCE_CONFIG[presence?.status ?? 'offline'];
  const roleCfg = ROLE_CONFIG[user.role];
  const accountTypeCfg = user.account_type ? ACCOUNT_TYPE_CONFIG[user.account_type] : null;

  return (
    <GlassPanel padding="24px 28px" style={{ display: 'flex' }}>
      <div style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'center', width: '100%' }}>
        {/* Left: Avatar + identity */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, flex: '1 1 240px', minWidth: 0 }}>
          <Avatar name={user.name} size={60} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
              <h2
                style={{
                  margin: 0,
                  fontSize: '1.2rem',
                  fontWeight: 800,
                  color: GLASS.text,
                  letterSpacing: '-0.02em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {user.name}
              </h2>
              <GlassChip label={roleCfg.label} color={roleCfg.color} />
              <Badge variant={user.status === 'active' ? 'active' : user.status === 'suspended' ? 'suspended' : 'disabled'}>
                {user.status}
              </Badge>
              {accountTypeCfg && <GlassChip label={accountTypeCfg.label} color={accountTypeCfg.color} />}
            </div>
            <div style={{ fontSize: '0.8rem', color: GLASS.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {user.email}
            </div>
          </div>
        </div>

        {/* Center: Extension & DID */}
        <div style={{ flex: '1 1 200px', textAlign: 'center', minWidth: 0 }}>
          {extension ? (
            <>
              <div
                style={{
                  fontSize: '2rem',
                  fontWeight: 800,
                  color: '#60a5fa',
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: '-0.03em',
                  lineHeight: 1,
                  marginBottom: 4,
                  textShadow: `0 0 18px ${hexToRgba(GLASS.accent, 0.35)}`,
                }}
              >
                Ext {extension.number}
              </div>
              {extension.did && (
                <div style={{ fontSize: '0.8rem', color: GLASS.textMuted, fontFamily: MONO }}>
                  {fmt(extension.did)}
                </div>
              )}
              <Link
                to={`/admin/customers/${user.customer_id}`}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  marginTop: 6,
                  fontSize: '0.78rem',
                  color: '#60a5fa',
                  textDecoration: 'none',
                  transition: 'color 0.1s',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = '#93c5fd'; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = '#60a5fa'; }}
              >
                {user.customer_name}
                <IconExternal />
              </Link>
            </>
          ) : (
            <div style={{ fontSize: '0.82rem', color: GLASS.textFaint, fontStyle: 'italic' }}>
              No extension assigned
            </div>
          )}
        </div>

        {/* Right: edit toggle + presence + last login */}
        <div style={{ flex: '0 0 auto', textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <button
            type="button"
            onClick={onEditToggle}
            title={isEditing ? 'Close editor' : 'Edit this user'}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '6px 12px',
              borderRadius: 9,
              background: isEditing ? hexToRgba(GLASS.accent, 0.18) : 'rgba(255,255,255,0.05)',
              border: `1px solid ${isEditing ? hexToRgba(GLASS.accent, 0.45) : 'rgba(255,255,255,0.1)'}`,
              color: isEditing ? '#93c5fd' : GLASS.textMuted,
              fontSize: '0.78rem',
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'background 0.15s, border-color 0.15s, color 0.15s',
              marginBottom: 8,
            }}
            onMouseEnter={(e) => {
              if (!isEditing) {
                e.currentTarget.style.background = hexToRgba(GLASS.accent, 0.1);
                e.currentTarget.style.borderColor = hexToRgba(GLASS.accent, 0.3);
                e.currentTarget.style.color = '#60a5fa';
              }
            }}
            onMouseLeave={(e) => {
              if (!isEditing) {
                e.currentTarget.style.background = 'rgba(255,255,255,0.05)';
                e.currentTarget.style.borderColor = 'rgba(255,255,255,0.1)';
                e.currentTarget.style.color = GLASS.textMuted;
              }
            }}
          >
            {isEditing ? <><IconX />Close</> : <><IconPencil />Edit User</>}
          </button>

          {/* Presence */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', marginBottom: 4 }}>
            <span
              style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: presenceCfg.color,
                flexShrink: 0,
                boxShadow: `0 0 8px ${presenceCfg.color}80`,
              }}
            />
            <span style={{ fontSize: '0.85rem', fontWeight: 600, color: GLASS.text }}>{presenceCfg.label}</span>
          </div>

          {presence?.message && (
            <div style={{ fontSize: '0.72rem', color: GLASS.textMuted, fontStyle: 'italic', marginBottom: 4, maxWidth: 180, textAlign: 'right' }}>
              &ldquo;{presence.message}&rdquo;
            </div>
          )}

          <div style={{ fontSize: '0.7rem', color: GLASS.textFaint }}>
            Last login: {fmtRelativeTime(user.last_login)}
          </div>

          {presence?.updated_at && (
            <div style={{ fontSize: '0.68rem', color: GLASS.textFaint, marginTop: 2 }}>
              Status updated {fmtRelativeTime(presence.updated_at)}
            </div>
          )}
        </div>
      </div>
    </GlassPanel>
  );
}
