import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest } from '../../api/client';
import { listUsers } from '../../api/auth';
import { listCustomers } from '../../api/customers';
import type { User } from '../../types/auth';
import type { Customer as PlatformCustomer } from '../../types/customer';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { fmt, fmtDuration } from '../../utils/format';

// ─── Types ───────────────────────────────────────────────────────────────────

type PresenceStatus = 'available' | 'away' | 'busy' | 'dnd' | 'offline';
type CallDirection = 'inbound' | 'outbound';
type CallResult = 'answered' | 'failed' | 'busy' | 'no-answer' | 'cancelled';
type UserRole = 'admin' | 'user' | 'readonly';
type AccountType = 'RCF' | 'API' | 'Trunk' | 'UCaaS' | 'Hybrid';

interface Customer {
  id: number;
  name: string;
  account_type: string;
  status: string;
}

interface RecentCall {
  id: string;
  direction: CallDirection;
  caller: string;
  callee: string;
  duration: number;
  result: CallResult;
  timestamp: string;
}

interface Device {
  id: string;
  user_agent: string;
  ip_address: string;
  registered_at: string;
  expires_at: string;
}

interface RcfProduct {
  id: number;
  did: string;
  name: string | null;
  forward_to: string;
  enabled: boolean;
  ring_timeout: number;
  failover_to: string | null;
  pass_caller_id: boolean;
}

interface ApiDidProduct {
  did: string;
  voice_url: string;
  enabled: boolean;
}

interface TrunkProduct {
  id: number;
  trunk_name: string;
  max_channels: number;
  enabled: boolean;
  did_count: number;
  ip_count: number;
}

interface User360Response {
  user: {
    id: number;
    name: string;
    email: string;
    role: UserRole;
    customer_id: number;
    customer_name: string;
    account_type: AccountType | null;
    status: 'active' | 'disabled' | 'suspended';
    last_login: string | null;
  };
  extension: {
    number: string;
    did: string | null;
    voicemail_enabled: boolean;
    dnd: boolean;
    forward_on_busy: string | null;
    forward_on_no_answer: string | null;
    forward_timeout_sec: number | null;
  } | null;
  presence: {
    status: PresenceStatus;
    message: string | null;
    updated_at: string | null;
  } | null;
  voicemail: {
    total: number;
    unread: number;
  };
  chat: {
    total_conversations: number;
    unread_messages: number;
  };
  recent_calls: RecentCall[];
  devices: Device[];
  products: {
    rcf: RcfProduct[];
    api_dids: ApiDidProduct[];
    trunks: TrunkProduct[];
  };
}

interface UpdateUserPayload {
  name?: string;
  email?: string;
  role?: UserRole;
  status?: 'active' | 'disabled';
  customer_id?: number;
  password?: string;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PRESENCE_CONFIG: Record<PresenceStatus, { label: string; color: string }> = {
  available: { label: 'Available',      color: '#22c55e' },
  away:      { label: 'Away',           color: '#f59e0b' },
  busy:      { label: 'Busy',           color: '#ef4444' },
  dnd:       { label: 'Do Not Disturb', color: '#ef4444' },
  offline:   { label: 'Offline',        color: '#64748b' },
};

const CALL_RESULT_COLOR: Record<CallResult, string> = {
  answered:    '#22c55e',
  failed:      '#ef4444',
  busy:        '#f59e0b',
  'no-answer': '#64748b',
  cancelled:   '#64748b',
};

const ROLE_CONFIG: Record<UserRole, { label: string; color: string }> = {
  admin:    { label: 'Admin',     color: '#a855f7' },
  user:     { label: 'User',      color: '#0ea5e9' },
  readonly: { label: 'Read-Only', color: '#64748b' },
};

const ACCOUNT_TYPE_CONFIG: Record<AccountType, { label: string; color: string }> = {
  RCF:    { label: 'RCF',    color: '#22c55e' },
  API:    { label: 'API',    color: '#a855f7' },
  Trunk:  { label: 'Trunk',  color: '#f59e0b' },
  UCaaS:  { label: 'UCaaS',  color: '#0ea5e9' },
  Hybrid: { label: 'Hybrid', color: '#3b82f6' },
};

const AVATAR_COLORS = [
  '#3b82f6', '#8b5cf6', '#06b6d4', '#10b981',
  '#f59e0b', '#ef4444', '#ec4899', '#6366f1',
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getAvatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = (hash * 31 + name.charCodeAt(i)) & 0xffffffff;
  }
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

function fmtRelativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtTimestamp(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// ─── API ──────────────────────────────────────────────────────────────────────

async function fetchCustomers(): Promise<Customer[]> {
  return apiRequest<Customer[]>('GET', '/customers');
}

async function fetchUser360(userId: number): Promise<User360Response> {
  return apiRequest<User360Response>('GET', `/search/user/${userId}/360`);
}

// ─── Avatar ───────────────────────────────────────────────────────────────────

interface AvatarProps {
  name: string;
  size?: number;
}

function Avatar({ name, size = 64 }: AvatarProps) {
  const color = getAvatarColor(name);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.25,
        background: `linear-gradient(135deg, ${color}30 0%, ${color}18 100%)`,
        border: `2px solid ${color}50`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.4,
        fontWeight: 800,
        color: color,
        flexShrink: 0,
        letterSpacing: '-0.02em',
        boxShadow: `0 0 24px ${color}20`,
      }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

// ─── Header Card ──────────────────────────────────────────────────────────────

interface HeaderCardProps {
  data: User360Response;
  isEditing: boolean;
  onEditToggle: () => void;
}

function HeaderCard({ data, isEditing, onEditToggle }: HeaderCardProps) {
  const { user, extension, presence } = data;
  const presenceCfg   = PRESENCE_CONFIG[presence?.status ?? 'offline'];
  const roleCfg       = ROLE_CONFIG[user.role];
  const accountTypeCfg = user.account_type ? ACCOUNT_TYPE_CONFIG[user.account_type] : null;

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(26,29,39,0.95) 0%, rgba(15,17,23,1) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        padding: '24px 28px',
        position: 'relative',
        overflow: 'hidden',
        boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
        display: 'flex',
        gap: 28,
        flexWrap: 'wrap',
        alignItems: 'center',
      }}
    >
      {/* Top accent */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 40,
          right: 40,
          height: 2,
          background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.8), transparent)',
          opacity: 0.5,
        }}
      />

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
                color: '#e2e8f0',
                letterSpacing: '-0.02em',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {user.name}
            </h2>
            <span
              style={{
                fontSize: '0.65rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
                padding: '2px 8px',
                borderRadius: 5,
                color: roleCfg.color,
                background: `${roleCfg.color}18`,
                border: `1px solid ${roleCfg.color}35`,
                flexShrink: 0,
              }}
            >
              {roleCfg.label}
            </span>
            <Badge variant={user.status === 'active' ? 'active' : user.status === 'suspended' ? 'suspended' : 'disabled'}>
              {user.status}
            </Badge>
            {accountTypeCfg && (
              <span
                style={{
                  fontSize: '0.65rem',
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  padding: '2px 8px',
                  borderRadius: 5,
                  color: accountTypeCfg.color,
                  background: `${accountTypeCfg.color}18`,
                  border: `1px solid ${accountTypeCfg.color}35`,
                  flexShrink: 0,
                }}
              >
                {accountTypeCfg.label}
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.8rem', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
              }}
            >
              Ext {extension.number}
            </div>
            {extension.did && (
              <div style={{ fontSize: '0.8rem', color: '#94a3b8', fontFamily: 'monospace' }}>
                {fmt(extension.did)}
              </div>
            )}
            <Link
              to={`/admin/customers/${user.customer_id}`}
              style={{
                display: 'inline-block',
                marginTop: 6,
                fontSize: '0.78rem',
                color: '#60a5fa',
                textDecoration: 'none',
                transition: 'color 0.1s',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#93c5fd'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = '#60a5fa'; }}
            >
              {user.customer_name}
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 11, height: 11, marginLeft: 4, verticalAlign: 'middle' }}>
                <path d="M6 3h7v7M13 3 3 13" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </Link>
          </>
        ) : (
          <div style={{ fontSize: '0.82rem', color: '#4a5568', fontStyle: 'italic' }}>
            No extension assigned
          </div>
        )}
      </div>

      {/* Right: Presence + last login + edit toggle */}
      <div style={{ flex: '0 0 auto', textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
        {/* Edit button */}
        <button
          type="button"
          onClick={onEditToggle}
          title={isEditing ? 'Close editor' : 'Edit this user'}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 12px',
            borderRadius: 8,
            background: isEditing ? 'rgba(59,130,246,0.18)' : 'rgba(255,255,255,0.05)',
            border: `1px solid ${isEditing ? 'rgba(59,130,246,0.45)' : 'rgba(255,255,255,0.1)'}`,
            color: isEditing ? '#93c5fd' : '#94a3b8',
            fontSize: '0.78rem',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'background 0.15s, border-color 0.15s, color 0.15s',
            marginBottom: 8,
          }}
          onMouseEnter={(e) => {
            if (!isEditing) {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(59,130,246,0.1)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(59,130,246,0.3)';
              (e.currentTarget as HTMLButtonElement).style.color = '#60a5fa';
            }
          }}
          onMouseLeave={(e) => {
            if (!isEditing) {
              (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)';
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.1)';
              (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8';
            }
          }}
        >
          {isEditing ? (
            <>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 12, height: 12 }}>
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
              Close
            </>
          ) : (
            <>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 12, height: 12 }}>
                <path d="M11.5 2.5a2.121 2.121 0 0 1 3 3L5 15l-4 1 1-4 9.5-9.5Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Edit User
            </>
          )}
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
          <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#e2e8f0' }}>
            {presenceCfg.label}
          </span>
        </div>

        {/* Presence message */}
        {presence?.message && (
          <div style={{ fontSize: '0.72rem', color: '#64748b', fontStyle: 'italic', marginBottom: 4, maxWidth: 180, textAlign: 'right' }}>
            &ldquo;{presence.message}&rdquo;
          </div>
        )}

        {/* Last login */}
        <div style={{ fontSize: '0.7rem', color: '#475569' }}>
          Last login: {fmtRelativeTime(user.last_login)}
        </div>

        {/* Presence updated */}
        {presence?.updated_at && (
          <div style={{ fontSize: '0.68rem', color: '#334155', marginTop: 2 }}>
            Status updated {fmtRelativeTime(presence.updated_at)}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Stat Cards ───────────────────────────────────────────────────────────────

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  primary: string;
  secondary?: string;
  accent: string;
  linkTo?: string;
  linkLabel?: string;
}

function StatCard({ icon, label, primary, secondary, accent, linkTo, linkLabel }: StatCardProps) {
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 14,
        padding: '18px 20px',
        position: 'relative',
        overflow: 'hidden',
        flex: '1 1 160px',
        minWidth: 0,
      }}
    >
      {/* Top accent */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accent}99, transparent)`,
        }}
      />

      {/* Icon */}
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 10,
          background: `${accent}14`,
          border: `1px solid ${accent}28`,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: accent,
          marginBottom: 12,
        }}
      >
        {icon}
      </div>

      {/* Label */}
      <div
        style={{
          fontSize: '0.6rem',
          fontWeight: 700,
          color: '#4a5568',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
          marginBottom: 4,
        }}
      >
        {label}
      </div>

      {/* Primary */}
      <div
        style={{
          fontSize: '1rem',
          fontWeight: 700,
          color: '#e2e8f0',
          fontVariantNumeric: 'tabular-nums',
          marginBottom: secondary ? 2 : 0,
        }}
      >
        {primary}
      </div>

      {/* Secondary */}
      {secondary && (
        <div style={{ fontSize: '0.72rem', color: '#64748b' }}>
          {secondary}
        </div>
      )}

      {/* Link */}
      {linkTo && linkLabel && (
        <Link
          to={linkTo}
          style={{
            display: 'inline-block',
            marginTop: 8,
            fontSize: '0.7rem',
            color: accent,
            textDecoration: 'none',
            opacity: 0.7,
            transition: 'opacity 0.1s',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.opacity = '1'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.opacity = '0.7'; }}
        >
          {linkLabel} →
        </Link>
      )}
    </div>
  );
}

// ─── Status Grid ─────────────────────────────────────────────────────────────

interface StatusGridProps {
  data: User360Response;
}

function StatusGrid({ data }: StatusGridProps) {
  const { recent_calls, voicemail, chat, devices, extension } = data;

  // Derive call stats
  const now = Date.now();
  const todayCalls = recent_calls.filter((c) => {
    const diff = now - new Date(c.timestamp).getTime();
    return diff < 86_400_000; // 24 hours
  });
  const lastCall = recent_calls[0] ?? null;

  const callPrimary   = `${todayCalls.length} call${todayCalls.length !== 1 ? 's' : ''} today`;
  const callSecondary = lastCall ? `Last call ${fmtRelativeTime(lastCall.timestamp)}` : 'No recent calls';

  const vmPrimary   = `${voicemail.unread} unread`;
  const vmSecondary = `${voicemail.total} total`;

  const chatPrimary   = `${chat.total_conversations} conversation${chat.total_conversations !== 1 ? 's' : ''}`;
  const chatSecondary = chat.unread_messages > 0 ? `${chat.unread_messages} unread` : 'All read';

  const devicePrimary   = devices.length === 0 ? 'No devices' : `${devices.length} registered`;
  const deviceSecondary = devices.length > 0 ? `via ${devices[0].user_agent.split('/')[0]}` : 'SIP endpoint not connected';

  // Link for DID lookup
  const didLookupLink = extension?.did
    ? `/admin/did-search?did=${encodeURIComponent(extension.did)}`
    : undefined;

  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {/* Calls */}
      <StatCard
        accent="#0ea5e9"
        label="Calls"
        primary={callPrimary}
        secondary={callSecondary}
        linkTo={didLookupLink}
        linkLabel={didLookupLink ? 'View in DID Lookup' : undefined}
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 18, height: 18 }}>
            <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.05 6.05l1.96-1.84a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 14.92Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        }
      />

      {/* Voicemail */}
      <StatCard
        accent="#f59e0b"
        label="Voicemail"
        primary={vmPrimary}
        secondary={vmSecondary}
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 18, height: 18 }}>
            <circle cx="6.5" cy="12" r="4.5" />
            <circle cx="17.5" cy="12" r="4.5" />
            <line x1="6.5" y1="16.5" x2="17.5" y2="16.5" />
          </svg>
        }
      />

      {/* Chat */}
      <StatCard
        accent="#8b5cf6"
        label="Chat"
        primary={chatPrimary}
        secondary={chatSecondary}
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 18, height: 18 }}>
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        }
      />

      {/* Devices */}
      <StatCard
        accent={devices.length > 0 ? '#22c55e' : '#64748b'}
        label="Devices"
        primary={devicePrimary}
        secondary={deviceSecondary}
        icon={
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 18, height: 18 }}>
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8M12 17v4" strokeLinecap="round" />
          </svg>
        }
      />
    </div>
  );
}

// ─── Extension Config Card ───────────────────────────────────────────────────

interface ExtensionConfigCardProps {
  extension: NonNullable<User360Response['extension']>;
}

function ExtensionConfigCard({ extension }: ExtensionConfigCardProps) {
  const fields: Array<{ label: string; value: React.ReactNode; accent?: string }> = [
    {
      label: 'Extension',
      value: <span style={{ fontFamily: 'monospace', color: '#60a5fa', fontSize: '0.95rem', fontWeight: 700 }}>{extension.number}</span>,
    },
    {
      label: 'Assigned DID',
      value: extension.did
        ? <span style={{ fontFamily: 'monospace', color: '#e2e8f0' }}>{fmt(extension.did)}</span>
        : <span style={{ color: '#4a5568', fontStyle: 'italic' }}>None</span>,
    },
    {
      label: 'Voicemail',
      value: extension.voicemail_enabled
        ? <span style={{ color: '#22c55e', fontWeight: 600 }}>Enabled</span>
        : <span style={{ color: '#64748b' }}>Disabled</span>,
    },
    {
      label: 'Do Not Disturb',
      value: extension.dnd
        ? <span style={{ color: '#ef4444', fontWeight: 600 }}>On</span>
        : <span style={{ color: '#64748b' }}>Off</span>,
    },
    {
      label: 'Forward on Busy',
      value: extension.forward_on_busy
        ? <span style={{ fontFamily: 'monospace', color: '#e2e8f0' }}>{fmt(extension.forward_on_busy)}</span>
        : <span style={{ color: '#4a5568', fontStyle: 'italic' }}>Not configured</span>,
    },
    {
      label: 'Forward on No Answer',
      value: extension.forward_on_no_answer
        ? <span style={{ fontFamily: 'monospace', color: '#e2e8f0' }}>{fmt(extension.forward_on_no_answer)}</span>
        : <span style={{ color: '#4a5568', fontStyle: 'italic' }}>Not configured</span>,
    },
    {
      label: 'Forward Timeout',
      value: extension.forward_timeout_sec != null
        ? <span style={{ color: '#94a3b8' }}>{extension.forward_timeout_sec}s</span>
        : <span style={{ color: '#4a5568', fontStyle: 'italic' }}>—</span>,
    },
  ];

  return (
    <SectionCard accent="#0ea5e9" title="Extension Configuration" icon={
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 16, height: 16 }}>
        <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    }>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
          gap: 8,
        }}
      >
        {fields.map(({ label, value }) => (
          <div
            key={label}
            style={{
              padding: '12px 16px',
              borderRadius: 10,
              background: 'rgba(255,255,255,0.02)',
              border: '1px solid rgba(255,255,255,0.04)',
            }}
          >
            <div
              style={{
                fontSize: '0.58rem',
                fontWeight: 700,
                color: '#4a5568',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
                marginBottom: 6,
              }}
            >
              {label}
            </div>
            <div style={{ fontSize: '0.85rem' }}>{value}</div>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ─── Devices Card ─────────────────────────────────────────────────────────────

interface DevicesCardProps {
  devices: Device[];
}

function DevicesCard({ devices }: DevicesCardProps) {
  return (
    <SectionCard accent="#22c55e" title="Registered Devices" icon={
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 16, height: 16 }}>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" strokeLinecap="round" />
      </svg>
    }>
      {devices.length === 0 ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '20px 0',
            color: '#4a5568',
            fontSize: '0.82rem',
          }}
        >
          <span style={{ fontSize: '1.2rem', opacity: 0.3 }}>○</span>
          No SIP endpoints currently registered. The user may not be logged into a softphone or device.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {devices.map((device) => (
            <div
              key={device.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 16,
                padding: '12px 16px',
                borderRadius: 10,
                background: 'rgba(34,197,94,0.04)',
                border: '1px solid rgba(34,197,94,0.12)',
              }}
            >
              <div
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: '#22c55e',
                  flexShrink: 0,
                  boxShadow: '0 0 6px rgba(34,197,94,0.6)',
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {device.user_agent}
                </div>
                <div style={{ fontSize: '0.7rem', color: '#64748b', marginTop: 2 }}>
                  {device.ip_address} · Registered {fmtRelativeTime(device.registered_at)} · Expires {fmtRelativeTime(device.expires_at)}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ─── Recent Calls Card ────────────────────────────────────────────────────────

interface RecentCallsCardProps {
  calls: RecentCall[];
}

function RecentCallsCard({ calls }: RecentCallsCardProps) {
  if (calls.length === 0) {
    return (
      <SectionCard accent="#64748b" title="Recent Calls" icon={
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 16, height: 16 }}>
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.05 6.05l1.96-1.84a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 14.92Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      }>
        <div style={{ padding: '20px 0', textAlign: 'center', color: '#4a5568', fontSize: '0.82rem', fontStyle: 'italic' }}>
          No recent calls found for this user.
        </div>
      </SectionCard>
    );
  }

  return (
    <SectionCard accent="#0ea5e9" title={`Recent Calls (${calls.length})`} icon={
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 16, height: 16 }}>
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.05 6.05l1.96-1.84a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 14.92Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    }>
      <div
        style={{
          borderRadius: 10,
          border: '1px solid rgba(255,255,255,0.05)',
          overflow: 'hidden',
          background: 'rgba(0,0,0,0.2)',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              {['Dir', 'Caller', '', 'Callee', 'Duration', 'Result', 'Time'].map((col) => (
                <th
                  key={col}
                  style={{
                    padding: '9px 12px',
                    textAlign: 'left',
                    fontSize: '0.58rem',
                    fontWeight: 700,
                    color: '#334155',
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    background: 'rgba(0,0,0,0.06)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calls.map((call, i) => {
              const resultColor = CALL_RESULT_COLOR[call.result] ?? '#64748b';
              return (
                <tr
                  key={call.id}
                  style={{
                    background: i % 2 === 1 ? 'rgba(255,255,255,0.015)' : 'transparent',
                    borderBottom: '1px solid rgba(255,255,255,0.03)',
                  }}
                >
                  {/* Direction */}
                  <td style={{ padding: '8px 12px', width: 36 }}>
                    <span
                      title={call.direction}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        background: call.direction === 'inbound'
                          ? 'rgba(14,165,233,0.12)'
                          : 'rgba(168,85,247,0.12)',
                        color: call.direction === 'inbound' ? '#0ea5e9' : '#a855f7',
                      }}
                    >
                      {call.direction === 'inbound' ? (
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 10, height: 10 }}>
                          <path d="M14 2L2 14M2 14h8M2 14V6" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 10, height: 10 }}>
                          <path d="M2 14L14 2M14 2H6M14 2v8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      )}
                    </span>
                  </td>
                  {/* Caller */}
                  <td style={{ padding: '8px 12px', fontSize: '0.8rem', color: '#cbd5e0', fontFamily: 'monospace' }}>
                    {fmt(call.caller)}
                  </td>
                  {/* Arrow */}
                  <td style={{ padding: '8px 4px', color: '#334155', fontSize: '0.75rem' }}>→</td>
                  {/* Callee */}
                  <td style={{ padding: '8px 12px', fontSize: '0.8rem', color: '#cbd5e0', fontFamily: 'monospace' }}>
                    {fmt(call.callee)}
                  </td>
                  {/* Duration */}
                  <td style={{ padding: '8px 12px', fontSize: '0.78rem', color: '#64748b', textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {call.duration > 0 ? fmtDuration(call.duration) : '—'}
                  </td>
                  {/* Result badge */}
                  <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                    <span
                      style={{
                        fontSize: '0.63rem',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        color: resultColor,
                        background: `${resultColor}14`,
                        border: `1px solid ${resultColor}28`,
                        borderRadius: 4,
                        padding: '2px 7px',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {call.result}
                    </span>
                  </td>
                  {/* Time */}
                  <td style={{ padding: '8px 12px', fontSize: '0.72rem', color: '#475569', whiteSpace: 'nowrap', textAlign: 'right' }}>
                    {fmtTimestamp(call.timestamp)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ─── Quick Actions ────────────────────────────────────────────────────────────

interface QuickActionsProps {
  data: User360Response;
}

function QuickActions({ data }: QuickActionsProps) {
  const { user, extension } = data;

  const didSearchUrl = extension?.did
    ? `/admin/did-search?did=${encodeURIComponent(extension.did)}`
    : '/admin/did-search';

  return (
    <SectionCard accent="#a855f7" title="Quick Actions" icon={
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 16, height: 16 }}>
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    }>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {/* View Customer */}
        <Link
          to={`/admin/customers/${user.customer_id}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '9px 16px',
            borderRadius: 9,
            background: 'rgba(59,130,246,0.1)',
            border: '1px solid rgba(59,130,246,0.25)',
            color: '#60a5fa',
            textDecoration: 'none',
            fontSize: '0.82rem',
            fontWeight: 600,
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => {
            const el = e.currentTarget as HTMLAnchorElement;
            el.style.background = 'rgba(59,130,246,0.18)';
            el.style.borderColor = 'rgba(59,130,246,0.45)';
          }}
          onMouseLeave={(e) => {
            const el = e.currentTarget as HTMLAnchorElement;
            el.style.background = 'rgba(59,130,246,0.1)';
            el.style.borderColor = 'rgba(59,130,246,0.25)';
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" strokeLinecap="round" />
          </svg>
          View Customer
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 11, height: 11, opacity: 0.6 }}>
            <path d="M6 3h7v7M13 3 3 13" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </Link>

        {/* View in DID Lookup */}
        <Link
          to={didSearchUrl}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '9px 16px',
            borderRadius: 9,
            background: 'rgba(14,165,233,0.1)',
            border: '1px solid rgba(14,165,233,0.25)',
            color: '#38bdf8',
            textDecoration: 'none',
            fontSize: '0.82rem',
            fontWeight: 600,
            transition: 'background 0.15s, border-color 0.15s',
          }}
          onMouseEnter={(e) => {
            const el = e.currentTarget as HTMLAnchorElement;
            el.style.background = 'rgba(14,165,233,0.18)';
            el.style.borderColor = 'rgba(14,165,233,0.45)';
          }}
          onMouseLeave={(e) => {
            const el = e.currentTarget as HTMLAnchorElement;
            el.style.background = 'rgba(14,165,233,0.1)';
            el.style.borderColor = 'rgba(14,165,233,0.25)';
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
            <circle cx="11" cy="11" r="7" />
            <path d="m21 21-4.35-4.35" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          View in DID Lookup
        </Link>

        {/* Toggle DND — placeholder */}
        <button
          type="button"
          disabled
          title="Coming soon"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '9px 16px',
            borderRadius: 9,
            background: 'rgba(239,68,68,0.06)',
            border: '1px solid rgba(239,68,68,0.15)',
            color: '#64748b',
            fontSize: '0.82rem',
            fontWeight: 600,
            cursor: 'not-allowed',
            opacity: 0.55,
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
            <circle cx="12" cy="12" r="10" />
            <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
          </svg>
          Toggle DND
          <span style={{ fontSize: '0.58rem', color: '#475569', letterSpacing: '0.04em', textTransform: 'uppercase' }}>soon</span>
        </button>

        {/* Reset Extension — placeholder */}
        <button
          type="button"
          disabled
          title="Coming soon"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '9px 16px',
            borderRadius: 9,
            background: 'rgba(245,158,11,0.06)',
            border: '1px solid rgba(245,158,11,0.15)',
            color: '#64748b',
            fontSize: '0.82rem',
            fontWeight: 600,
            cursor: 'not-allowed',
            opacity: 0.55,
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
            <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" strokeLinecap="round" strokeLinejoin="round" />
            <path d="M3 3v5h5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Reset Extension
          <span style={{ fontSize: '0.58rem', color: '#475569', letterSpacing: '0.04em', textTransform: 'uppercase' }}>soon</span>
        </button>
      </div>
    </SectionCard>
  );
}

// ─── Section Card Wrapper ─────────────────────────────────────────────────────

interface SectionCardProps {
  children: React.ReactNode;
  accent?: string;
  title: string;
  icon?: React.ReactNode;
}

function SectionCard({ children, accent = '#3b82f6', title, icon }: SectionCardProps) {
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(26,29,39,0.95) 0%, rgba(15,17,23,1) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        padding: '22px 24px',
        position: 'relative',
        overflow: 'hidden',
        boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
      }}
    >
      {/* Top accent */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 40,
          right: 40,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accent}, transparent)`,
          opacity: 0.5,
        }}
      />

      {/* Section header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 16,
        }}
      >
        {icon && (
          <span style={{ color: accent, display: 'flex', alignItems: 'center' }}>
            {icon}
          </span>
        )}
        <h3
          style={{
            margin: 0,
            fontSize: '0.72rem',
            fontWeight: 700,
            color: '#64748b',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
          }}
        >
          {title}
        </h3>
      </div>

      {children}
    </div>
  );
}

// ─── RCF Numbers Card ─────────────────────────────────────────────────────────

interface RcfCardProps {
  rcf: RcfProduct[];
}

function RcfCard({ rcf }: RcfCardProps) {
  const accent = '#22c55e';
  return (
    <SectionCard
      accent={accent}
      title={`RCF Numbers (${rcf.length})`}
      icon={
        // PhoneForwarded
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 16, height: 16 }}>
          <polyline points="19 8 23 12 19 16" strokeLinecap="round" strokeLinejoin="round" />
          <line x1="23" y1="12" x2="13" y2="12" strokeLinecap="round" />
          <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.05 6.05l1.96-1.84a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 14.92Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      }
    >
      <div
        style={{
          borderRadius: 10,
          border: '1px solid rgba(255,255,255,0.05)',
          overflow: 'hidden',
          background: 'rgba(0,0,0,0.2)',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              {['DID', 'Name', 'Forward To', 'Timeout', 'Failover', 'Caller ID', 'Status'].map((col) => (
                <th
                  key={col}
                  style={{
                    padding: '9px 12px',
                    textAlign: 'left',
                    fontSize: '0.58rem',
                    fontWeight: 700,
                    color: '#334155',
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    background: 'rgba(0,0,0,0.06)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rcf.map((r, i) => (
              <tr
                key={r.id}
                style={{
                  background: i % 2 === 1 ? 'rgba(255,255,255,0.015)' : 'transparent',
                  borderBottom: '1px solid rgba(255,255,255,0.03)',
                }}
              >
                <td style={{ padding: '8px 12px', fontSize: '0.8rem', color: '#cbd5e0', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                  {fmt(r.did)}
                </td>
                <td style={{ padding: '8px 12px', fontSize: '0.8rem', color: '#94a3b8' }}>
                  {r.name ?? <span style={{ color: '#4a5568', fontStyle: 'italic' }}>—</span>}
                </td>
                <td style={{ padding: '8px 12px', fontSize: '0.8rem', color: '#e2e8f0', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                  {fmt(r.forward_to)}
                </td>
                <td style={{ padding: '8px 12px', fontSize: '0.78rem', color: '#64748b', whiteSpace: 'nowrap' }}>
                  {r.ring_timeout}s
                </td>
                <td style={{ padding: '8px 12px', fontSize: '0.78rem', color: '#94a3b8', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                  {r.failover_to ? fmt(r.failover_to) : <span style={{ color: '#4a5568', fontStyle: 'italic' }}>None</span>}
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                  <span style={{ fontSize: '0.72rem', color: r.pass_caller_id ? '#22c55e' : '#64748b' }}>
                    {r.pass_caller_id ? 'Pass' : 'Strip'}
                  </span>
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                  <span
                    style={{
                      fontSize: '0.63rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: r.enabled ? accent : '#64748b',
                      background: r.enabled ? `${accent}14` : 'rgba(100,116,139,0.1)',
                      border: `1px solid ${r.enabled ? `${accent}28` : 'rgba(100,116,139,0.2)'}`,
                      borderRadius: 4,
                      padding: '2px 7px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {r.enabled ? 'Active' : 'Disabled'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ─── API DIDs Card ────────────────────────────────────────────────────────────

interface ApiDidCardProps {
  api_dids: ApiDidProduct[];
}

function ApiDidCard({ api_dids }: ApiDidCardProps) {
  const accent = '#a855f7';
  return (
    <SectionCard
      accent={accent}
      title={`API DIDs (${api_dids.length})`}
      icon={
        // Code brackets
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 16, height: 16 }}>
          <polyline points="16 18 22 12 16 6" strokeLinecap="round" strokeLinejoin="round" />
          <polyline points="8 6 2 12 8 18" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      }
    >
      <div
        style={{
          borderRadius: 10,
          border: '1px solid rgba(255,255,255,0.05)',
          overflow: 'hidden',
          background: 'rgba(0,0,0,0.2)',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              {['DID', 'Voice URL', 'Status'].map((col) => (
                <th
                  key={col}
                  style={{
                    padding: '9px 12px',
                    textAlign: 'left',
                    fontSize: '0.58rem',
                    fontWeight: 700,
                    color: '#334155',
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    background: 'rgba(0,0,0,0.06)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {api_dids.map((d, i) => (
              <tr
                key={d.did}
                style={{
                  background: i % 2 === 1 ? 'rgba(255,255,255,0.015)' : 'transparent',
                  borderBottom: '1px solid rgba(255,255,255,0.03)',
                }}
              >
                <td style={{ padding: '8px 12px', fontSize: '0.8rem', color: '#cbd5e0', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                  {fmt(d.did)}
                </td>
                <td style={{ padding: '8px 12px', maxWidth: 320 }}>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      fontFamily: 'monospace',
                      color: '#94a3b8',
                      display: 'block',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    title={d.voice_url}
                  >
                    {d.voice_url}
                  </span>
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                  <span
                    style={{
                      fontSize: '0.63rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: d.enabled ? accent : '#64748b',
                      background: d.enabled ? `${accent}14` : 'rgba(100,116,139,0.1)',
                      border: `1px solid ${d.enabled ? `${accent}28` : 'rgba(100,116,139,0.2)'}`,
                      borderRadius: 4,
                      padding: '2px 7px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {d.enabled ? 'Active' : 'Disabled'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ─── SIP Trunks Card ──────────────────────────────────────────────────────────

interface TrunksCardProps {
  trunks: TrunkProduct[];
}

function TrunksCard({ trunks }: TrunksCardProps) {
  const accent = '#f59e0b';
  return (
    <SectionCard
      accent={accent}
      title={`SIP Trunks (${trunks.length})`}
      icon={
        // Network / share icon
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 16, height: 16 }}>
          <circle cx="18" cy="5" r="3" />
          <circle cx="6" cy="12" r="3" />
          <circle cx="18" cy="19" r="3" />
          <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" strokeLinecap="round" />
          <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" strokeLinecap="round" />
        </svg>
      }
    >
      <div
        style={{
          borderRadius: 10,
          border: '1px solid rgba(255,255,255,0.05)',
          overflow: 'hidden',
          background: 'rgba(0,0,0,0.2)',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              {['Trunk Name', 'Max Channels', 'DIDs', 'Auth IPs', 'Status'].map((col) => (
                <th
                  key={col}
                  style={{
                    padding: '9px 12px',
                    textAlign: 'left',
                    fontSize: '0.58rem',
                    fontWeight: 700,
                    color: '#334155',
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    background: 'rgba(0,0,0,0.06)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trunks.map((t, i) => (
              <tr
                key={t.id}
                style={{
                  background: i % 2 === 1 ? 'rgba(255,255,255,0.015)' : 'transparent',
                  borderBottom: '1px solid rgba(255,255,255,0.03)',
                }}
              >
                <td style={{ padding: '8px 12px', fontSize: '0.82rem', fontWeight: 600, color: '#e2e8f0' }}>
                  {t.trunk_name}
                </td>
                <td style={{ padding: '8px 12px', fontSize: '0.8rem', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                  {t.max_channels}
                </td>
                <td style={{ padding: '8px 12px', fontSize: '0.8rem', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                  {t.did_count}
                </td>
                <td style={{ padding: '8px 12px', fontSize: '0.8rem', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                  {t.ip_count}
                </td>
                <td style={{ padding: '8px 12px', textAlign: 'center' }}>
                  <span
                    style={{
                      fontSize: '0.63rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.04em',
                      color: t.enabled ? accent : '#64748b',
                      background: t.enabled ? `${accent}14` : 'rgba(100,116,139,0.1)',
                      border: `1px solid ${t.enabled ? `${accent}28` : 'rgba(100,116,139,0.2)'}`,
                      borderRadius: 4,
                      padding: '2px 7px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {t.enabled ? 'Active' : 'Disabled'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ─── Edit User Panel ──────────────────────────────────────────────────────────

interface EditUserPanelProps {
  userId: number;
  user: User360Response['user'];
  onSuccess: () => void;
  onCancel: () => void;
}

function EditUserPanel({ userId, user, onSuccess, onCancel }: EditUserPanelProps) {
  // ALL hooks before any early returns (React #310)
  const [name, setName]           = useState(user.name);
  const [email, setEmail]         = useState(user.email);
  const [role, setRole]           = useState<UserRole>(user.role);
  const [status, setStatus]       = useState<'active' | 'disabled'>(
    user.status === 'suspended' ? 'active' : user.status,
  );
  const [customerId, setCustomerId] = useState<number>(user.customer_id);
  const [password, setPassword]   = useState('');
  const [saving, setSaving]       = useState(false);
  const [banner, setBanner]       = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const { data: customers, isLoading: customersLoading } = useQuery({
    queryKey: ['customers'],
    queryFn:  fetchCustomers,
    staleTime: 60_000,
  });

  const sortedCustomers = [...(customers ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  async function handleSave() {
    setSaving(true);
    setBanner(null);

    // Build payload with only changed fields
    const payload: UpdateUserPayload = {};
    if (name.trim()    !== user.name)         payload.name        = name.trim();
    if (email.trim()   !== user.email)        payload.email       = email.trim();
    if (role           !== user.role)         payload.role        = role;
    if (status         !== user.status && !(user.status === 'suspended' && status === 'active')) {
      payload.status = status;
    }
    if (customerId     !== user.customer_id)  payload.customer_id = customerId;
    if (password.trim().length > 0)           payload.password    = password.trim();

    // If nothing changed, just close
    if (Object.keys(payload).length === 0) {
      onSuccess();
      return;
    }

    try {
      await apiRequest('PUT', `/auth/users/${userId}`, payload);
      setBanner({ type: 'success', message: 'User updated successfully.' });
      setSaving(false);
      // Brief delay so the user sees the success banner before panel closes
      setTimeout(onSuccess, 800);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'An unexpected error occurred.';
      setBanner({ type: 'error', message: msg });
      setSaving(false);
    }
  }

  const inputStyle: React.CSSProperties = {
    width: '100%',
    boxSizing: 'border-box',
    padding: '9px 12px',
    fontSize: '0.875rem',
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 6,
    color: '#e2e8f0',
    outline: 'none',
    fontFamily: 'inherit',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  };

  const labelStyle: React.CSSProperties = {
    display: 'block',
    fontSize: '0.68rem',
    fontWeight: 700,
    color: '#64748b',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: 6,
  };

  function handleInputFocus(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
    e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)';
    e.currentTarget.style.boxShadow   = '0 0 0 3px rgba(59,130,246,0.1)';
  }

  function handleInputBlur(e: React.FocusEvent<HTMLInputElement | HTMLSelectElement>) {
    e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
    e.currentTarget.style.boxShadow   = 'none';
  }

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(26,29,39,0.98) 0%, rgba(15,17,23,1) 100%)',
        border: '1px solid rgba(59,130,246,0.2)',
        borderRadius: 16,
        padding: '24px 28px',
        position: 'relative',
        overflow: 'hidden',
        boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
      }}
    >
      {/* Top accent - blue to indicate edit mode */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 40,
          right: 40,
          height: 2,
          background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.9), transparent)',
          opacity: 0.7,
        }}
      />

      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
        <span style={{ color: '#3b82f6', display: 'flex', alignItems: 'center' }}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
            <path d="M11.5 2.5a2.121 2.121 0 0 1 3 3L5 15l-4 1 1-4 9.5-9.5Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <h3
          style={{
            margin: 0,
            fontSize: '0.72rem',
            fontWeight: 700,
            color: '#64748b',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
          }}
        >
          Edit User
        </h3>
      </div>

      {/* Banner */}
      {banner && (
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 8,
            marginBottom: 20,
            background: banner.type === 'success' ? 'rgba(34,197,94,0.08)' : 'rgba(239,68,68,0.08)',
            border: `1px solid ${banner.type === 'success' ? 'rgba(34,197,94,0.25)' : 'rgba(239,68,68,0.25)'}`,
            color: banner.type === 'success' ? '#4ade80' : '#f87171',
            fontSize: '0.82rem',
            fontWeight: 500,
          }}
        >
          {banner.message}
        </div>
      )}

      {/* Form grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
          gap: '16px 20px',
          marginBottom: 20,
        }}
      >
        {/* Name */}
        <div>
          <label style={labelStyle}>Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            style={inputStyle}
            disabled={saving}
            placeholder="Full name"
          />
        </div>

        {/* Email */}
        <div>
          <label style={labelStyle}>Email</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            style={inputStyle}
            disabled={saving}
            placeholder="user@example.com"
          />
        </div>

        {/* Role */}
        <div>
          <label style={labelStyle}>Role</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            disabled={saving}
            style={{
              ...inputStyle,
              appearance: 'none',
              WebkitAppearance: 'none',
              cursor: 'pointer',
              paddingRight: 32,
            }}
          >
            <option value="admin"    style={{ background: '#1a1d2e', color: '#e2e8f0' }}>Admin</option>
            <option value="user"     style={{ background: '#1a1d2e', color: '#e2e8f0' }}>User</option>
            <option value="readonly" style={{ background: '#1a1d2e', color: '#e2e8f0' }}>Read-Only</option>
          </select>
        </div>

        {/* Status */}
        <div>
          <label style={labelStyle}>Status</label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as 'active' | 'disabled')}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            disabled={saving}
            style={{
              ...inputStyle,
              appearance: 'none',
              WebkitAppearance: 'none',
              cursor: 'pointer',
              paddingRight: 32,
            }}
          >
            <option value="active"   style={{ background: '#1a1d2e', color: '#e2e8f0' }}>Active</option>
            <option value="disabled" style={{ background: '#1a1d2e', color: '#e2e8f0' }}>Disabled</option>
          </select>
        </div>

        {/* Customer */}
        <div>
          <label style={labelStyle}>Customer</label>
          <select
            value={customerId}
            onChange={(e) => setCustomerId(parseInt(e.target.value, 10))}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            disabled={saving || customersLoading}
            style={{
              ...inputStyle,
              appearance: 'none',
              WebkitAppearance: 'none',
              cursor: saving || customersLoading ? 'wait' : 'pointer',
              paddingRight: 32,
              color: customersLoading ? '#64748b' : '#e2e8f0',
            }}
          >
            {customersLoading ? (
              <option value={customerId} style={{ background: '#1a1d2e', color: '#64748b' }}>
                Loading customers…
              </option>
            ) : (
              sortedCustomers.map((c) => (
                <option key={c.id} value={c.id} style={{ background: '#1a1d2e', color: '#e2e8f0' }}>
                  {c.name}{c.status !== 'active' ? ` (${c.status})` : ''}
                </option>
              ))
            )}
          </select>
        </div>

        {/* New Password */}
        <div>
          <label style={labelStyle}>New Password (leave blank to keep current)</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onFocus={handleInputFocus}
            onBlur={handleInputBlur}
            style={inputStyle}
            disabled={saving}
            placeholder="Leave blank to keep current"
            autoComplete="new-password"
          />
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '9px 20px',
            borderRadius: 8,
            background: saving ? 'rgba(59,130,246,0.5)' : '#3b82f6',
            border: '1px solid rgba(59,130,246,0.4)',
            color: '#fff',
            fontSize: '0.85rem',
            fontWeight: 600,
            cursor: saving ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            transition: 'background 0.15s',
          }}
          onMouseEnter={(e) => {
            if (!saving) (e.currentTarget as HTMLButtonElement).style.background = '#2563eb';
          }}
          onMouseLeave={(e) => {
            if (!saving) (e.currentTarget as HTMLButtonElement).style.background = '#3b82f6';
          }}
        >
          {saving ? (
            <>
              <Spinner size="sm" />
              Saving…
            </>
          ) : (
            <>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 12, height: 12 }}>
                <path d="M13 2H5L2 5v9h12V2Z" strokeLinecap="round" strokeLinejoin="round" />
                <path d="M10 2v4H5V2M5 9h6" strokeLinecap="round" />
              </svg>
              Save Changes
            </>
          )}
        </button>

        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '9px 16px',
            borderRadius: 8,
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.08)',
            color: '#94a3b8',
            fontSize: '0.85rem',
            fontWeight: 600,
            cursor: saving ? 'not-allowed' : 'pointer',
            fontFamily: 'inherit',
            transition: 'border-color 0.15s, color 0.15s',
          }}
          onMouseEnter={(e) => {
            if (!saving) {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.18)';
              (e.currentTarget as HTMLButtonElement).style.color = '#e2e8f0';
            }
          }}
          onMouseLeave={(e) => {
            if (!saving) {
              (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(255,255,255,0.08)';
              (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8';
            }
          }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── 360 View ─────────────────────────────────────────────────────────────────

interface User360ViewProps {
  userId: number;
}

function User360View({ userId }: User360ViewProps) {
  // ALL hooks must be declared before any early returns (React #310)
  const queryClient = useQueryClient();
  const [isEditing, setIsEditing] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['user-360', userId],
    queryFn:  () => fetchUser360(userId),
    staleTime: 30_000,
    retry: 1,
  });

  function handleEditSuccess() {
    setIsEditing(false);
    queryClient.invalidateQueries({ queryKey: ['user-360', userId] });
  }

  if (isLoading) {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: '72px 0',
          color: '#64748b',
          fontSize: '0.875rem',
        }}
      >
        <Spinner size="md" />
        <span>Loading user details…</span>
      </div>
    );
  }

  if (isError) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    return (
      <div
        style={{
          padding: '16px 20px',
          borderRadius: 12,
          background: 'rgba(239,68,68,0.06)',
          border: '1px solid rgba(239,68,68,0.18)',
          color: '#f87171',
          fontSize: '0.875rem',
        }}
      >
        <strong style={{ display: 'block', marginBottom: 4 }}>Failed to load user details</strong>
        {msg}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* Header card */}
      <HeaderCard
        data={data}
        isEditing={isEditing}
        onEditToggle={() => setIsEditing((prev) => !prev)}
      />

      {/* Edit panel — shown below header when editing */}
      {isEditing && (
        <EditUserPanel
          userId={userId}
          user={data.user}
          onSuccess={handleEditSuccess}
          onCancel={() => setIsEditing(false)}
        />
      )}

      {/* Status grid */}
      <StatusGrid data={data} />

      {/* Extension config + Devices (two-column where space allows) */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))', gap: 16 }}>
        {data.extension ? (
          <ExtensionConfigCard extension={data.extension} />
        ) : (
          <SectionCard accent="#64748b" title="Extension Configuration" icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 16, height: 16 }}>
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          }>
            <div style={{ color: '#4a5568', fontSize: '0.82rem', fontStyle: 'italic', padding: '8px 0' }}>
              No extension assigned to this user.
            </div>
          </SectionCard>
        )}

        <DevicesCard devices={data.devices} />
      </div>

      {/* Recent calls */}
      <RecentCallsCard calls={data.recent_calls} />

      {/* Product-specific sections — rendered only when data is present */}
      {data.products.rcf.length > 0 && (
        <RcfCard rcf={data.products.rcf} />
      )}
      {data.products.api_dids.length > 0 && (
        <ApiDidCard api_dids={data.products.api_dids} />
      )}
      {data.products.trunks.length > 0 && (
        <TrunksCard trunks={data.products.trunks} />
      )}

      {/* Quick actions */}
      <QuickActions data={data} />
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

// ─── All Users Table ──────────────────────────────────────────────────────────

interface AllUsersTableProps {
  users: User[];
  searchTerm: string;
  onSelectUser: (userId: number) => void;
}

function AllUsersTable({ users, searchTerm, onSelectUser }: AllUsersTableProps) {
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);

  const term = searchTerm.trim().toLowerCase();
  const filtered = term.length === 0
    ? users
    : users.filter((u) => {
        return (
          u.name.toLowerCase().includes(term) ||
          u.email.toLowerCase().includes(term) ||
          u.role.toLowerCase().includes(term) ||
          u.status.toLowerCase().includes(term) ||
          (u.customer_name ?? '').toLowerCase().includes(term) ||
          (u.account_type ?? '').toLowerCase().includes(term)
        );
      });

  if (filtered.length === 0) {
    return (
      <div
        style={{
          padding: '40px 20px',
          textAlign: 'center',
          color: '#4a5568',
          fontSize: '0.85rem',
          fontStyle: 'italic',
        }}
      >
        {term.length > 0
          ? `No users match "${searchTerm}"`
          : 'No users found.'}
      </div>
    );
  }

  return (
    <div
      style={{
        borderRadius: 10,
        border: '1px solid rgba(255,255,255,0.05)',
        overflow: 'hidden',
        background: 'rgba(0,0,0,0.2)',
      }}
    >
      {/* Row count label */}
      <div
        style={{
          padding: '9px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.04)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span
          style={{
            fontSize: '0.68rem',
            color: '#4a5568',
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            fontWeight: 700,
          }}
        >
          {filtered.length} user{filtered.length !== 1 ? 's' : ''}
          {term.length > 0 && users.length !== filtered.length && (
            <span style={{ color: '#334155', fontWeight: 400, marginLeft: 6 }}>
              of {users.length} total
            </span>
          )}
        </span>
        <span style={{ fontSize: '0.68rem', color: '#334155' }}>Click a row to open 360 view</span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              {['Name', 'Email', 'Role', 'Customer', 'Status', 'Last Login'].map((col) => (
                <th
                  key={col}
                  style={{
                    padding: '9px 12px',
                    textAlign: 'left',
                    fontSize: '0.58rem',
                    fontWeight: 700,
                    color: '#334155',
                    textTransform: 'uppercase',
                    letterSpacing: '0.1em',
                    background: 'rgba(0,0,0,0.06)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => {
              const avatarColor = getAvatarColor(u.name);
              const isHovered = hoveredRow === u.id;
              const roleCfg = ROLE_CONFIG[u.role] ?? ROLE_CONFIG.user;

              return (
                <tr
                  key={u.id}
                  onClick={() => onSelectUser(u.id)}
                  onMouseEnter={() => setHoveredRow(u.id)}
                  onMouseLeave={() => setHoveredRow(null)}
                  style={{
                    background: isHovered ? 'rgba(255,255,255,0.025)' : 'transparent',
                    borderBottom: '1px solid rgba(255,255,255,0.03)',
                    cursor: 'pointer',
                    transition: 'background 0.1s',
                  }}
                >
                  {/* Name + mini avatar */}
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
                      <div
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 7,
                          background: `${avatarColor}22`,
                          border: `1px solid ${avatarColor}44`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '0.75rem',
                          fontWeight: 700,
                          color: avatarColor,
                          flexShrink: 0,
                        }}
                      >
                        {u.name.charAt(0).toUpperCase()}
                      </div>
                      <span style={{ fontSize: '0.82rem', color: '#e2e8f0', fontWeight: 500 }}>
                        {u.name}
                      </span>
                    </div>
                  </td>

                  {/* Email */}
                  <td style={{ padding: '10px 12px', fontSize: '0.78rem', color: '#94a3b8', maxWidth: 220 }}>
                    <span
                      style={{
                        display: 'block',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={u.email}
                    >
                      {u.email}
                    </span>
                  </td>

                  {/* Role */}
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    <span
                      style={{
                        fontSize: '0.63rem',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        color: roleCfg.color,
                        background: `${roleCfg.color}18`,
                        border: `1px solid ${roleCfg.color}35`,
                        borderRadius: 4,
                        padding: '2px 7px',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {roleCfg.label}
                    </span>
                  </td>

                  {/* Customer */}
                  <td style={{ padding: '10px 12px', fontSize: '0.8rem', color: '#94a3b8', maxWidth: 180 }}>
                    {u.customer_name ? (
                      <span
                        style={{
                          display: 'block',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={u.customer_name}
                      >
                        {u.customer_name}
                      </span>
                    ) : (
                      <span style={{ color: '#334155', fontStyle: 'italic' }}>—</span>
                    )}
                  </td>

                  {/* Status */}
                  <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                    <Badge variant={u.status === 'active' ? 'active' : 'disabled'}>
                      {u.status}
                    </Badge>
                  </td>

                  {/* Last Login */}
                  <td style={{ padding: '10px 12px', fontSize: '0.75rem', color: '#64748b', whiteSpace: 'nowrap' }}>
                    {fmtRelativeTime(u.last_login)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── User Lookup Panel (all-users table + filter bar) ─────────────────────────

interface UserLookupPanelProps {
  onSelectUser: (userId: number) => void;
  customerId?: number | null;
}

function UserLookupPanel({ onSelectUser, customerId }: UserLookupPanelProps) {
  // ALL hooks above any early returns (React #310)
  const [searchTerm, setSearchTerm] = useState('');

  const { data: allUsers, isLoading, isError, error } = useQuery({
    queryKey: ['all-users'],
    queryFn: listUsers,
    staleTime: 30_000,
    retry: 1,
  });

  // When a customerId is provided, filter to only that customer's users
  const users = customerId != null
    ? (allUsers ?? []).filter((u) => u.customer_id === customerId)
    : allUsers;

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(26,29,39,0.95) 0%, rgba(15,17,23,1) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        padding: '20px 20px',
        boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Top accent */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 40,
          right: 40,
          height: 2,
          background: 'linear-gradient(90deg, transparent, rgba(168,85,247,0.7), transparent)',
          opacity: 0.5,
        }}
      />

      {/* Section header + search bar row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 16,
          marginBottom: 16,
          flexWrap: 'wrap',
        }}
      >
        {/* Title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          <span style={{ color: '#a855f7', display: 'flex', alignItems: 'center' }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 15, height: 15 }}>
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" strokeLinecap="round" />
            </svg>
          </span>
          <h3
            style={{
              margin: 0,
              fontSize: '0.72rem',
              fontWeight: 700,
              color: '#64748b',
              textTransform: 'uppercase',
              letterSpacing: '0.1em',
            }}
          >
            All Users
          </h3>
        </div>

        {/* Filter search input */}
        <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
          {/* Search icon */}
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 12,
              top: '50%',
              transform: 'translateY(-50%)',
              color: '#475569',
              display: 'flex',
              alignItems: 'center',
              pointerEvents: 'none',
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 15, height: 15 }}>
              <circle cx="11" cy="11" r="7" />
              <path d="m21 21-4.35-4.35" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </span>

          <input
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Filter by name, email, role, customer, status…"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '8px 36px 8px 34px',
              fontSize: '0.82rem',
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 8,
              color: '#e2e8f0',
              outline: 'none',
              fontFamily: 'inherit',
              transition: 'border-color 0.15s, box-shadow 0.15s',
            }}
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)';
              e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.12)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
              e.currentTarget.style.boxShadow = 'none';
            }}
          />

          {/* Clear button */}
          {searchTerm.length > 0 && (
            <button
              type="button"
              onClick={() => setSearchTerm('')}
              title="Clear filter"
              style={{
                position: 'absolute',
                right: 8,
                top: '50%',
                transform: 'translateY(-50%)',
                background: 'transparent',
                border: 'none',
                color: '#475569',
                cursor: 'pointer',
                padding: 3,
                borderRadius: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#475569'; }}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 12, height: 12 }}>
                <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
              </svg>
            </button>
          )}
        </div>
      </div>

      {/* Content area */}
      {isLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '40px 20px',
            color: '#64748b',
            fontSize: '0.875rem',
            justifyContent: 'center',
          }}
        >
          <Spinner size="md" />
          <span>Loading users…</span>
        </div>
      )}

      {isError && (
        <div
          style={{
            padding: '14px 18px',
            borderRadius: 10,
            background: 'rgba(239,68,68,0.06)',
            border: '1px solid rgba(239,68,68,0.18)',
            color: '#f87171',
            fontSize: '0.82rem',
          }}
        >
          <strong style={{ display: 'block', marginBottom: 3 }}>Failed to load users</strong>
          {error instanceof Error ? error.message : 'Unknown error'}
        </div>
      )}

      {!isLoading && !isError && users != null && (
        <AllUsersTable
          users={users}
          searchTerm={searchTerm}
          onSelectUser={onSelectUser}
        />
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

// ─── Customer Picker Table ────────────────────────────────────────────────────

const CUSTOMER_PAGE_SIZE = 25;
const CUSTOMER_COL_COUNT = 7;

const pickerTdStyle: React.CSSProperties = {
  padding: '13px 16px',
  borderBottom: '1px solid rgba(42,47,69,0.45)',
  verticalAlign: 'middle',
};

function accountTypeBadge(type: PlatformCustomer['account_type']) {
  return <Badge variant={type}>{type.toUpperCase()}</Badge>;
}

function statusBadge(status: PlatformCustomer['status']) {
  if (status === 'active') return <Badge variant="active">Active</Badge>;
  if (status === 'suspended') return <Badge variant="suspended">Suspended</Badge>;
  return <Badge variant="closed">Closed</Badge>;
}

function gradeBadge(grade: PlatformCustomer['traffic_grade']) {
  return <Badge variant={grade}>{grade}</Badge>;
}

interface CustomerPickerTableProps {
  onSelectCustomer: (customer: PlatformCustomer) => void;
}

function CustomerPickerTable({ onSelectCustomer }: CustomerPickerTableProps) {
  // ALL hooks above any early returns (React #310)
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [committedSearch, setCommittedSearch] = useState('');

  const { data, isLoading, isError } = useQuery({
    queryKey: ['customers-user-picker', { search: committedSearch, offset }],
    queryFn: () => listCustomers({ search: committedSearch, limit: CUSTOMER_PAGE_SIZE, offset }),
  });

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setOffset(0);
    setCommittedSearch(search);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Search toolbar */}
      <form
        onSubmit={handleSearch}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
          border: '1px solid rgba(42,47,69,0.6)',
          borderRadius: 12,
          padding: '16px 20px',
        }}
      >
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search customers…"
          style={{
            fontSize: '0.85rem',
            padding: '8px 14px',
            height: 36,
            borderRadius: 8,
            border: '1px solid rgba(42,47,69,0.8)',
            background: 'rgba(13,15,21,0.8)',
            color: '#e2e8f0',
            outline: 'none',
            transition: 'border-color 0.15s, box-shadow 0.15s',
            flex: 1,
            maxWidth: 400,
          }}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = '#3b82f6';
            e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.15)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'rgba(42,47,69,0.8)';
            e.currentTarget.style.boxShadow = 'none';
          }}
        />
        <button
          type="submit"
          style={{
            flexShrink: 0,
            padding: '8px 16px',
            borderRadius: 8,
            border: '1px solid rgba(42,47,69,0.8)',
            background: 'rgba(255,255,255,0.05)',
            color: '#94a3b8',
            fontSize: '0.82rem',
            fontWeight: 600,
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'background 0.15s, color 0.15s',
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.1)';
            (e.currentTarget as HTMLButtonElement).style.color = '#e2e8f0';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.05)';
            (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8';
          }}
        >
          Search
        </button>
      </form>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center gap-2.5 text-[#718096] py-12">
          <Spinner /> Loading customers…
        </div>
      )}

      {/* Error */}
      {isError && (
        <div
          style={{
            padding: '16px 20px',
            borderRadius: 12,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.2)',
            color: '#f87171',
            fontSize: '0.875rem',
          }}
        >
          Failed to load customers.
        </div>
      )}

      {/* Table */}
      {data && (
        <>
          <div
            style={{
              borderRadius: 12,
              border: '1px solid rgba(42,47,69,0.6)',
              overflow: 'hidden',
              background: 'linear-gradient(135deg, rgba(26,29,39,0.95) 0%, rgba(15,17,23,1) 100%)',
            }}
          >
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid rgba(42,47,69,0.6)', background: 'rgba(0,0,0,0.15)' }}>
                    {['ID', 'Name', 'Type', 'Balance', 'Status', 'Grade', 'Created'].map((col) => (
                      <th
                        key={col}
                        style={{
                          padding: '10px 16px',
                          textAlign: 'left',
                          fontSize: '0.6rem',
                          fontWeight: 700,
                          color: '#334155',
                          textTransform: 'uppercase',
                          letterSpacing: '0.1em',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {col}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(data.items ?? []).length === 0 ? (
                    <tr>
                      <td
                        colSpan={CUSTOMER_COL_COUNT}
                        style={{
                          padding: '48px 16px',
                          textAlign: 'center',
                          color: '#718096',
                          fontSize: '0.875rem',
                        }}
                      >
                        No customers found.
                      </td>
                    </tr>
                  ) : (
                    (data.items ?? []).map((customer) => (
                      <tr
                        key={customer.id}
                        onClick={() => onSelectCustomer(customer)}
                        style={{ transition: 'background 0.15s', cursor: 'pointer' }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.035)';
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
                        }}
                      >
                        <td style={pickerTdStyle}>
                          <span style={{ color: '#4a5568', fontFamily: 'monospace', fontSize: '0.78rem' }}>
                            #{customer.id}
                          </span>
                        </td>
                        <td style={pickerTdStyle}>
                          <span style={{ color: '#e2e8f0', fontWeight: 600, fontSize: '0.875rem' }}>
                            {customer.name}
                          </span>
                        </td>
                        <td style={pickerTdStyle}>{accountTypeBadge(customer.account_type)}</td>
                        <td style={pickerTdStyle}>
                          <span
                            style={{
                              color: customer.balance < 0 ? '#f87171' : '#e2e8f0',
                              fontVariantNumeric: 'tabular-nums',
                              fontSize: '0.875rem',
                              fontWeight: customer.balance < 0 ? 600 : 400,
                            }}
                          >
                            ${customer.balance.toFixed(2)}
                          </span>
                        </td>
                        <td style={pickerTdStyle}>{statusBadge(customer.status)}</td>
                        <td style={pickerTdStyle}>{gradeBadge(customer.traffic_grade)}</td>
                        <td style={{ ...pickerTdStyle, color: '#4a5568', fontSize: '0.82rem' }}>
                          {customer.created_at
                            ? new Date(customer.created_at).toLocaleDateString()
                            : '--'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Load more */}
          {(data.items ?? []).length + offset < (data.total ?? 0) && (
            <div style={{ textAlign: 'center', paddingBottom: 8 }}>
              <button
                type="button"
                onClick={() => setOffset((o) => o + CUSTOMER_PAGE_SIZE)}
                style={{
                  padding: '8px 20px',
                  borderRadius: 8,
                  border: '1px solid rgba(42,47,69,0.6)',
                  background: 'rgba(255,255,255,0.04)',
                  color: '#60a5fa',
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  transition: 'background 0.15s, color 0.15s',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(96,165,250,0.1)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)';
                }}
              >
                Load more
              </button>
              <span style={{ marginLeft: 12, fontSize: '0.78rem', color: '#4a5568' }}>
                Showing {(data.items ?? []).length + offset} of {data.total ?? 0}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function UserDetailPage() {
  // ALL hooks must be declared before any early returns (React #310)
  const { userId: userIdParam } = useParams<{ userId: string }>();
  const navigate = useNavigate();

  const urlUserId = userIdParam ? parseInt(userIdParam, 10) : null;
  // Deep-link via URL (:userId) goes straight to 360 view with no customer context
  const [selectedUserId, setSelectedUserId] = useState<number | null>(
    urlUserId && !Number.isNaN(urlUserId) ? urlUserId : null,
  );
  const [selectedCustomer, setSelectedCustomer] = useState<PlatformCustomer | null>(null);

  function handleSelectCustomer(customer: PlatformCustomer) {
    setSelectedCustomer(customer);
    setSelectedUserId(null);
  }

  function handleSelectUser(id: number) {
    setSelectedUserId(id);
    navigate(`/admin/customers/users/${id}`, { replace: true });
  }

  function handleBackToUsers() {
    setSelectedUserId(null);
    navigate('/admin/customers/users', { replace: true });
  }

  function handleBackToCustomers() {
    setSelectedUserId(null);
    setSelectedCustomer(null);
    navigate('/admin/customers/users', { replace: true });
  }

  // When a :userId is in the URL we go straight to 360 view — skip both pickers
  const show360View = selectedUserId != null;
  // Show the user list when a customer is selected (and not viewing a specific user)
  const showUserList = !show360View && selectedCustomer != null;
  // Show the customer picker when nothing is selected and no URL param
  const showCustomerPicker = !show360View && selectedCustomer == null;

  return (
    <div style={{ paddingTop: 4 }}>
      {/* ── State 1: Customer picker ────────────────────────── */}
      {showCustomerPicker && (
        <CustomerPickerTable onSelectCustomer={handleSelectCustomer} />
      )}

      {/* ── State 2: User list for selected customer ─────────── */}
      {showUserList && (
        <>
          {/* Back to customers */}
          <div style={{ marginBottom: 20 }}>
            <button
              type="button"
              onClick={handleBackToCustomers}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: 'transparent',
                border: 'none',
                color: '#60a5fa',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
                padding: '4px 0',
                fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#93c5fd'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#60a5fa'; }}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 13, height: 13 }}>
                <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Back to customers
            </button>
          </div>

          {/* Customer subheading */}
          <div style={{ marginBottom: 20 }}>
            <span
              style={{
                fontSize: '0.65rem',
                fontWeight: 700,
                color: '#a855f7',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
              }}
            >
              Customer
            </span>
            <h2
              style={{
                margin: '4px 0 0',
                fontSize: '1.05rem',
                fontWeight: 700,
                color: '#e2e8f0',
                letterSpacing: '-0.01em',
              }}
            >
              {selectedCustomer.name}
            </h2>
          </div>

          <UserLookupPanel
            onSelectUser={handleSelectUser}
            customerId={selectedCustomer.id}
          />
        </>
      )}

      {/* ── State 3: 360 View ────────────────────────────────── */}
      {show360View && (
        <>
          {/* Back button — goes to user list if we have a customer, else to customers */}
          <div style={{ marginBottom: 16 }}>
            <button
              type="button"
              onClick={selectedCustomer != null ? handleBackToUsers : handleBackToCustomers}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                background: 'transparent',
                border: 'none',
                color: '#60a5fa',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
                padding: '4px 0',
                fontFamily: 'inherit',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#93c5fd'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#60a5fa'; }}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 13, height: 13 }}>
                <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {selectedCustomer != null ? `Back to ${selectedCustomer.name} users` : 'Back to customers'}
            </button>
          </div>
          <User360View userId={selectedUserId!} />
        </>
      )}
    </div>
  );
}
