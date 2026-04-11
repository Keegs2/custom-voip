import { useState, useEffect, useRef, useCallback } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { apiRequest } from '../../api/client';
import { Badge } from '../../components/ui/Badge';
import { Spinner } from '../../components/ui/Spinner';
import { fmt, fmtDuration } from '../../utils/format';

// ─── Types ───────────────────────────────────────────────────────────────────

type PresenceStatus = 'available' | 'away' | 'busy' | 'dnd' | 'offline';
type CallDirection = 'inbound' | 'outbound';
type CallResult = 'answered' | 'failed' | 'busy' | 'no-answer' | 'cancelled';
type UserRole = 'admin' | 'user' | 'readonly';

interface UserSearchResult {
  id: number;
  name: string;
  email: string;
  customer_name: string;
  extension: string | null;
  assigned_did: string | null;
  presence_status: PresenceStatus;
}

interface UserSearchResponse {
  results: UserSearchResult[];
  total: number;
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

interface User360Response {
  user: {
    id: number;
    name: string;
    email: string;
    role: UserRole;
    customer_id: number;
    customer_name: string;
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

async function searchUsers(q: string): Promise<UserSearchResponse> {
  return apiRequest<UserSearchResponse>('GET', `/search/user?q=${encodeURIComponent(q)}`);
}

async function fetchUser360(userId: number): Promise<User360Response> {
  return apiRequest<User360Response>('GET', `/search/user/${userId}/360`);
}

// ─── Search Bar ───────────────────────────────────────────────────────────────

interface UserSearchBarProps {
  onSelect: (userId: number) => void;
  initialQuery?: string;
}

function UserSearchBar({ onSelect, initialQuery = '' }: UserSearchBarProps) {
  const [inputValue, setInputValue] = useState(initialQuery);
  const [query, setQuery]           = useState('');
  const [open, setOpen]             = useState(false);
  const debounceRef                 = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef                = useRef<HTMLDivElement>(null);

  const handleInputChange = useCallback((value: string) => {
    setInputValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (value.trim().length >= 2) {
      debounceRef.current = setTimeout(() => {
        setQuery(value.trim());
        setOpen(true);
      }, 280);
    } else {
      setQuery('');
      setOpen(false);
    }
  }, []);

  useEffect(() => {
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['user-search', query],
    queryFn:  () => searchUsers(query),
    enabled:  query.length >= 2,
    staleTime: 10_000,
  });

  const results = data?.results ?? [];

  function handleSelect(result: UserSearchResult) {
    setInputValue(result.name);
    setOpen(false);
    onSelect(result.id);
  }

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {/* Search icon */}
      <span
        aria-hidden="true"
        style={{
          position: 'absolute',
          left: 18,
          top: '50%',
          transform: 'translateY(-50%)',
          color: '#475569',
          display: 'flex',
          alignItems: 'center',
          pointerEvents: 'none',
          zIndex: 1,
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 20, height: 20 }}>
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.35-4.35" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>

      <input
        type="text"
        value={inputValue}
        onChange={(e) => handleInputChange(e.target.value)}
        onFocus={() => { if (results.length > 0) setOpen(true); }}
        placeholder="Search by name, email, or extension..."
        autoFocus
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: '16px 52px 16px 52px',
          fontSize: '1rem',
          fontWeight: 500,
          background: 'rgba(255,255,255,0.03)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: open && results.length > 0 ? '14px 14px 0 0' : 14,
          color: '#f1f5f9',
          outline: 'none',
          transition: 'border-color 0.15s, box-shadow 0.15s, background 0.15s',
          boxShadow: '0 4px 24px rgba(0,0,0,0.3)',
          fontFamily: 'inherit',
        }}
        onFocusCapture={(e) => {
          e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)';
          e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.12), 0 4px 24px rgba(0,0,0,0.3)';
          e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
        }}
        onBlur={(e) => {
          e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)';
          e.currentTarget.style.boxShadow = '0 4px 24px rgba(0,0,0,0.3)';
          e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
        }}
      />

      {/* Right: spinner / clear */}
      <span
        style={{
          position: 'absolute',
          right: 16,
          top: '50%',
          transform: 'translateY(-50%)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {(isLoading || isFetching) && <Spinner size="sm" />}
        {inputValue && !(isLoading || isFetching) && (
          <button
            type="button"
            onClick={() => { setInputValue(''); setQuery(''); setOpen(false); }}
            title="Clear search"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#475569',
              cursor: 'pointer',
              padding: 4,
              borderRadius: 4,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#94a3b8'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.color = '#475569'; }}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </span>

      {/* Dropdown results */}
      {open && query.length >= 2 && !isLoading && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            background: 'rgba(15,17,23,0.98)',
            border: '1px solid rgba(59,130,246,0.3)',
            borderTop: 'none',
            borderRadius: '0 0 14px 14px',
            overflow: 'hidden',
            zIndex: 50,
            boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
            backdropFilter: 'blur(12px)',
          }}
        >
          {results.length === 0 ? (
            <div style={{ padding: '14px 20px', fontSize: '0.82rem', color: '#64748b', fontStyle: 'italic' }}>
              No users found matching &ldquo;{query}&rdquo;
            </div>
          ) : (
            results.map((r) => {
              const avatarColor = getAvatarColor(r.name);
              const presence    = PRESENCE_CONFIG[r.presence_status] ?? PRESENCE_CONFIG.offline;
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => handleSelect(r)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    width: '100%',
                    padding: '12px 20px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'background 0.1s',
                    color: '#e2e8f0',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(59,130,246,0.08)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                >
                  {/* Mini avatar */}
                  <div
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: 8,
                      background: `${avatarColor}22`,
                      border: `1px solid ${avatarColor}44`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '0.82rem',
                      fontWeight: 700,
                      color: avatarColor,
                      flexShrink: 0,
                    }}
                  >
                    {r.name.charAt(0).toUpperCase()}
                  </div>

                  {/* Name / email */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: '0.875rem', fontWeight: 600, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.name}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.email}
                    </div>
                  </div>

                  {/* Extension */}
                  {r.extension && (
                    <div style={{ fontSize: '0.75rem', color: '#94a3b8', fontFamily: 'monospace', flexShrink: 0 }}>
                      Ext {r.extension}
                    </div>
                  )}

                  {/* Presence dot */}
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: presence.color,
                      flexShrink: 0,
                      boxShadow: `0 0 6px ${presence.color}80`,
                    }}
                    title={presence.label}
                  />
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
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
}

function HeaderCard({ data }: HeaderCardProps) {
  const { user, extension, presence } = data;
  const presenceCfg = PRESENCE_CONFIG[presence?.status ?? 'offline'];
  const roleCfg     = ROLE_CONFIG[user.role];

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

      {/* Right: Presence + last login */}
      <div style={{ flex: '0 0 auto', textAlign: 'right' }}>
        {/* Presence */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end', marginBottom: 8 }}>
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
          <div style={{ fontSize: '0.72rem', color: '#64748b', fontStyle: 'italic', marginBottom: 6, maxWidth: 180, textAlign: 'right' }}>
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
  const { recent_calls, voicemail, chat, devices, extension, user } = data;

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

// ─── 360 View ─────────────────────────────────────────────────────────────────

interface User360ViewProps {
  userId: number;
}

function User360View({ userId }: User360ViewProps) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['user-360', userId],
    queryFn:  () => fetchUser360(userId),
    staleTime: 30_000,
    retry: 1,
  });

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
      <HeaderCard data={data} />

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

      {/* Quick actions */}
      <QuickActions data={data} />
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function UserDetailPage() {
  const { userId: userIdParam } = useParams<{ userId: string }>();
  const navigate = useNavigate();

  // Parse userId from URL param (may be undefined on the base route)
  const urlUserId = userIdParam ? parseInt(userIdParam, 10) : null;
  const [selectedUserId, setSelectedUserId] = useState<number | null>(
    urlUserId && !Number.isNaN(urlUserId) ? urlUserId : null,
  );

  function handleSelectUser(id: number) {
    setSelectedUserId(id);
    navigate(`/admin/user/${id}`, { replace: true });
  }

  return (
    <div style={{ paddingTop: 8 }}>
      {/* ── Page Header ──────────────────────────────────────── */}
      <div
        style={{
          marginBottom: 32,
          paddingTop: 8,
          paddingBottom: 28,
          borderBottom: '1px solid rgba(42,47,69,0.6)',
          textAlign: 'center',
        }}
      >
        {/* Icon badge */}
        <div
          style={{
            width: 48,
            height: 48,
            borderRadius: 14,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(135deg, rgba(168,85,247,0.2) 0%, rgba(168,85,247,0.1) 100%)',
            border: '1px solid rgba(168,85,247,0.3)',
            color: '#c084fc',
            marginBottom: 14,
          }}
          aria-hidden="true"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} style={{ width: 24, height: 24 }}>
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="12" cy="7" r="4" />
          </svg>
        </div>

        <h1
          style={{
            fontSize: '1.5rem',
            fontWeight: 800,
            letterSpacing: '-0.02em',
            color: '#e2e8f0',
            lineHeight: 1.15,
            margin: '0 0 6px',
          }}
        >
          User 360 View
        </h1>
        <p
          style={{
            fontSize: '0.85rem',
            color: '#718096',
            marginTop: 4,
            lineHeight: 1.6,
            maxWidth: 520,
            marginLeft: 'auto',
            marginRight: 'auto',
          }}
        >
          Search for any UCaaS user to view their full profile — extension config, presence, call history, and devices.
        </p>
      </div>

      {/* ── Search Bar ───────────────────────────────────────── */}
      <div style={{ marginBottom: selectedUserId ? 28 : 24 }}>
        <UserSearchBar onSelect={handleSelectUser} />
      </div>

      {/* ── Empty State ───────────────────────────────────────── */}
      {!selectedUserId && (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '72px 16px',
            gap: 12,
            textAlign: 'center',
            background: 'linear-gradient(135deg, rgba(30,33,48,0.4) 0%, rgba(19,21,29,0.5) 100%)',
            border: '1px solid rgba(42,47,69,0.3)',
            borderRadius: 16,
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 16,
              background: 'rgba(168,85,247,0.06)',
              border: '1px solid rgba(168,85,247,0.12)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: '#334155',
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.4} style={{ width: 26, height: 26 }}>
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </div>
          <div>
            <p style={{ color: '#64748b', fontSize: '0.9rem', fontWeight: 500, margin: '0 0 4px' }}>
              Search for a user to load their 360 profile
            </p>
            <p style={{ color: '#334155', fontSize: '0.78rem', margin: 0 }}>
              Type a name, email address, or extension number — search is automatic after 2 characters
            </p>
          </div>
        </div>
      )}

      {/* ── 360 View ─────────────────────────────────────────── */}
      {selectedUserId && <User360View userId={selectedUserId} />}
    </div>
  );
}
