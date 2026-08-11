/**
 * UserDetailPage — admin user search + 360 view
 * (/admin/customers/users and /admin/customers/users/:userId).
 *
 * Three states: customer picker → per-customer user list → user 360
 * (profile header, presence, stat tiles, extension config, devices, recent
 * calls, per-product sections, quick actions, and the inline edit panel).
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * page-scoped `dlx-*` primitives in styles/dl-admin.css). Renders INSIDE the
 * AdminPage shell, which owns the paper canvas (`dl-scope`) — this page
 * contributes toolbars, result tables, and profile panels only.
 *
 * React #310: every hook in every component below is called unconditionally
 * at the top of its function, before any early return.
 */
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ChevronLeft,
  Code2,
  ExternalLink,
  MessageSquare,
  MonitorSmartphone,
  Pencil,
  Phone,
  PhoneForwarded,
  Search,
  Settings,
  Share2,
  Users,
  Voicemail,
  X,
  Zap,
} from 'lucide-react';
import { apiRequest } from '../../api/client';
import { listUsers } from '../../api/auth';
import { listCustomers } from '../../api/customers';
import type { User } from '../../types/auth';
import type { Customer as PlatformCustomer } from '../../types/customer';
import { Spinner } from '../../components/ui/Spinner';
import { fmt, fmtDuration } from '../../utils/format';
import '../../styles/dl-admin.css';

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

const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';
const ARCHIVO = '"Archivo", "IBM Plex Sans", sans-serif';

/** Daylight ink/status palette — semantics preserved:
    green = reachable, red = busy/dnd (do-not-ring), amber = away (a genuine
    "may not answer" warning state), slate = offline. */
const PRESENCE_CONFIG: Record<PresenceStatus, { label: string; color: string }> = {
  available: { label: 'Available',      color: '#15803d' },
  away:      { label: 'Away',           color: '#b45309' },
  busy:      { label: 'Busy',           color: '#b91c1c' },
  dnd:       { label: 'Do Not Disturb', color: '#b91c1c' },
  offline:   { label: 'Offline',        color: '#5d6f8c' },
};

/** Call outcome colors — green answered, red failed, amber busy (genuine
    delivery warning), slate for no-answer/cancelled. */
const CALL_RESULT_COLOR: Record<CallResult, string> = {
  answered:    '#15803d',
  failed:      '#b91c1c',
  busy:        '#b45309',
  'no-answer': '#5d6f8c',
  cancelled:   '#5d6f8c',
};

const ROLE_LABEL: Record<UserRole, string> = {
  admin:    'Admin',
  user:     'User',
  readonly: 'Read-Only',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

// ─── Small daylight chips ─────────────────────────────────────────────────────

function RoleTag({ role }: { role: UserRole }) {
  return (
    <span className={role === 'admin' ? 'dl-tag' : 'dl-tag dl-tag-slate'}>
      {ROLE_LABEL[role] ?? role}
    </span>
  );
}

function UserStatusPill({ status }: { status: 'active' | 'disabled' | 'suspended' }) {
  return (
    <span className={status === 'active' ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
      {status}
    </span>
  );
}

function EnabledStatusTag({ enabled }: { enabled: boolean }) {
  return (
    <span className={enabled ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
      {enabled ? 'Active' : 'Disabled'}
    </span>
  );
}

// ─── Avatar ───────────────────────────────────────────────────────────────────

interface AvatarProps {
  name: string;
  size?: number;
}

/** The one azure-tinted identity mark (dl-avatar), sized as needed. */
function Avatar({ name, size = 64 }: AvatarProps) {
  return (
    <div
      className="dl-avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

// ─── Section panel wrapper ────────────────────────────────────────────────────

interface SectionCardProps {
  children: React.ReactNode;
  title: string;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  /** Render children flush against the panel edges (tables). */
  flush?: boolean;
}

function SectionCard({ children, title, icon, actions, flush }: SectionCardProps) {
  return (
    <section className="dl-panel">
      <div className="dl-panel-head" style={{ flexWrap: 'nowrap' }}>
        {icon && (
          <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--rcf-azure-deep)', flexShrink: 0 }}>
            {icon}
          </span>
        )}
        <h3 className="dl-panel-title" style={{ margin: 0, flex: 1, minWidth: 0 }}>{title}</h3>
        {actions && <div style={{ flexShrink: 0 }}>{actions}</div>}
      </div>
      {flush ? children : <div className="dl-panel-body">{children}</div>}
    </section>
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
  const presenceCfg = PRESENCE_CONFIG[presence?.status ?? 'offline'];

  return (
    <section className="dl-panel">
      <div
        className="dl-panel-body"
        style={{ display: 'flex', gap: 28, flexWrap: 'wrap', alignItems: 'center' }}
      >
        {/* Left: Avatar + identity */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flex: '1 1 260px', minWidth: 0 }}>
          <Avatar name={user.name} size={56} />
          <div style={{ minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
              <h2
                style={{
                  margin: 0,
                  fontFamily: ARCHIVO,
                  fontSize: '1.12rem',
                  fontWeight: 700,
                  color: 'var(--rcf-ink)',
                  letterSpacing: '-0.018em',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {user.name}
              </h2>
              <RoleTag role={user.role} />
              <UserStatusPill status={user.status} />
              {user.account_type && (
                <span className="dl-tag dl-tag-slate">{user.account_type}</span>
              )}
            </div>
            <div
              style={{
                fontSize: '0.8rem',
                color: 'var(--rcf-ink-dim)',
                fontFamily: MONO,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
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
                  fontFamily: ARCHIVO,
                  fontSize: '1.7rem',
                  fontWeight: 700,
                  color: 'var(--rcf-azure-deep)',
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: '-0.02em',
                  lineHeight: 1,
                  marginBottom: 5,
                }}
              >
                Ext {extension.number}
              </div>
              {extension.did && (
                <div style={{ fontSize: '0.8rem', color: 'var(--rcf-ink-soft)', fontFamily: MONO }}>
                  {fmt(extension.did)}
                </div>
              )}
              <Link
                to={`/admin/customers/${user.customer_id}`}
                className="dlx-linkbtn"
                style={{ marginTop: 6 }}
              >
                {user.customer_name}
                <ExternalLink size={11} strokeWidth={2} aria-hidden="true" />
              </Link>
            </>
          ) : (
            <div style={{ fontSize: '0.82rem', color: 'var(--rcf-ink-dim)', fontStyle: 'italic' }}>
              No extension assigned
            </div>
          )}
        </div>

        {/* Right: Edit toggle + presence + last login */}
        <div style={{ flex: '0 0 auto', textAlign: 'right', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
          <button
            type="button"
            className={isEditing ? 'dl-btn dl-btn-primary dlx-btn-sm' : 'dl-btn dl-btn-ghost dlx-btn-sm'}
            onClick={onEditToggle}
            title={isEditing ? 'Close editor' : 'Edit this user'}
            style={{ marginBottom: 6 }}
          >
            {isEditing ? (
              <>
                <X size={12} strokeWidth={2.25} aria-hidden="true" />
                Close
              </>
            ) : (
              <>
                <Pencil size={12} strokeWidth={2} aria-hidden="true" />
                Edit User
              </>
            )}
          </button>

          {/* Presence */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'flex-end' }}>
            <span
              aria-hidden="true"
              style={{
                width: 9,
                height: 9,
                borderRadius: '50%',
                background: presenceCfg.color,
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: '0.84rem', fontWeight: 700, color: 'var(--rcf-ink)' }}>
              {presenceCfg.label}
            </span>
          </div>

          {/* Presence message */}
          {presence?.message && (
            <div style={{ fontSize: '0.72rem', color: 'var(--rcf-ink-dim)', fontStyle: 'italic', maxWidth: 180, textAlign: 'right' }}>
              &ldquo;{presence.message}&rdquo;
            </div>
          )}

          {/* Last login */}
          <div style={{ fontSize: '0.7rem', color: 'var(--rcf-ink-dim)' }}>
            Last login: {fmtRelativeTime(user.last_login)}
          </div>

          {/* Presence updated */}
          {presence?.updated_at && (
            <div style={{ fontSize: '0.68rem', color: 'var(--rcf-ink-dim)' }}>
              Status updated {fmtRelativeTime(presence.updated_at)}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

// ─── Stat tiles ───────────────────────────────────────────────────────────────

interface StatTileProps {
  icon: React.ReactNode;
  label: string;
  primary: string;
  secondary?: string;
  linkTo?: string;
  linkLabel?: string;
}

function StatTile({ icon, label, primary, secondary, linkTo, linkLabel }: StatTileProps) {
  return (
    <div className="dl-tile" style={{ flex: '1 1 180px' }}>
      <span className="dl-tile-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
        <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--rcf-azure-deep)' }}>{icon}</span>
        {label}
      </span>
      <span className="dl-tile-value" style={{ fontSize: '1.05rem' }}>{primary}</span>
      {secondary && <span className="dl-tile-hint">{secondary}</span>}
      {linkTo && linkLabel && (
        <Link to={linkTo} className="dlx-linkbtn" style={{ fontSize: '0.7rem', padding: 0 }}>
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
      <StatTile
        label="Calls"
        primary={callPrimary}
        secondary={callSecondary}
        linkTo={didLookupLink}
        linkLabel={didLookupLink ? 'View in DID Lookup' : undefined}
        icon={<Phone size={13} strokeWidth={1.8} />}
      />
      <StatTile
        label="Voicemail"
        primary={vmPrimary}
        secondary={vmSecondary}
        icon={<Voicemail size={13} strokeWidth={1.8} />}
      />
      <StatTile
        label="Chat"
        primary={chatPrimary}
        secondary={chatSecondary}
        icon={<MessageSquare size={13} strokeWidth={1.8} />}
      />
      <StatTile
        label="Devices"
        primary={devicePrimary}
        secondary={deviceSecondary}
        icon={<MonitorSmartphone size={13} strokeWidth={1.8} />}
      />
    </div>
  );
}

// ─── Extension Config Card ───────────────────────────────────────────────────

interface ExtensionConfigCardProps {
  extension: NonNullable<User360Response['extension']>;
}

function ExtensionConfigCard({ extension }: ExtensionConfigCardProps) {
  const fields: Array<{ label: string; value: React.ReactNode }> = [
    {
      label: 'Extension',
      value: <span style={{ fontFamily: MONO, color: 'var(--rcf-azure-deep)', fontSize: '0.92rem', fontWeight: 700 }}>{extension.number}</span>,
    },
    {
      label: 'Assigned DID',
      value: extension.did
        ? <span style={{ fontFamily: MONO, color: 'var(--rcf-ink)' }}>{fmt(extension.did)}</span>
        : <span style={{ color: 'var(--rcf-ink-dim)', fontStyle: 'italic' }}>None</span>,
    },
    {
      label: 'Voicemail',
      value: extension.voicemail_enabled
        ? <span style={{ color: 'var(--rcf-green)', fontWeight: 700 }}>Enabled</span>
        : <span style={{ color: 'var(--rcf-ink-dim)' }}>Disabled</span>,
    },
    {
      label: 'Do Not Disturb',
      value: extension.dnd
        ? <span style={{ color: 'var(--rcf-red)', fontWeight: 700 }}>On</span>
        : <span style={{ color: 'var(--rcf-ink-dim)' }}>Off</span>,
    },
    {
      label: 'Forward on Busy',
      value: extension.forward_on_busy
        ? <span style={{ fontFamily: MONO, color: 'var(--rcf-ink)' }}>{fmt(extension.forward_on_busy)}</span>
        : <span style={{ color: 'var(--rcf-ink-dim)', fontStyle: 'italic' }}>Not configured</span>,
    },
    {
      label: 'Forward on No Answer',
      value: extension.forward_on_no_answer
        ? <span style={{ fontFamily: MONO, color: 'var(--rcf-ink)' }}>{fmt(extension.forward_on_no_answer)}</span>
        : <span style={{ color: 'var(--rcf-ink-dim)', fontStyle: 'italic' }}>Not configured</span>,
    },
    {
      label: 'Forward Timeout',
      value: extension.forward_timeout_sec != null
        ? <span style={{ color: 'var(--rcf-ink-soft)' }}>{extension.forward_timeout_sec}s</span>
        : <span style={{ color: 'var(--rcf-ink-dim)', fontStyle: 'italic' }}>—</span>,
    },
  ];

  return (
    <SectionCard title="Extension Configuration" icon={<Settings size={15} strokeWidth={1.8} />}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: 8,
        }}
      >
        {fields.map(({ label, value }) => (
          <div key={label} className="dl-item" style={{ padding: '11px 14px' }}>
            <div className="dl-fact-label">{label}</div>
            <div style={{ fontSize: '0.84rem' }}>{value}</div>
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
    <SectionCard title="Registered Devices" icon={<MonitorSmartphone size={15} strokeWidth={1.8} />}>
      {devices.length === 0 ? (
        <div className="dl-empty">
          No SIP endpoints currently registered. The user may not be logged into a softphone or device.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {devices.map((device) => (
            <div
              key={device.id}
              className="dl-item"
              style={{ display: 'flex', alignItems: 'center', gap: 14 }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: 'var(--rcf-green)',
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--rcf-ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {device.user_agent}
                </div>
                <div style={{ fontSize: '0.72rem', color: 'var(--rcf-ink-dim)', marginTop: 2 }}>
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
      <SectionCard title="Recent Calls" icon={<Phone size={15} strokeWidth={1.8} />}>
        <div className="dl-empty">No recent calls found for this user.</div>
      </SectionCard>
    );
  }

  return (
    <SectionCard
      title={`Recent Calls (${calls.length})`}
      icon={<Phone size={15} strokeWidth={1.8} />}
      flush
    >
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr>
              {['Dir', 'Caller', '', 'Callee', 'Duration', 'Result', 'Time'].map((col, i) => (
                <th key={`${col}-${i}`} className="dl-th">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {calls.map((call) => {
              const resultColor = CALL_RESULT_COLOR[call.result] ?? '#5d6f8c';
              return (
                <tr key={call.id} className="dl-row">
                  {/* Direction */}
                  <td className="dlx-td" style={{ width: 40 }}>
                    <span
                      title={call.direction}
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        background: 'rgba(47, 125, 246, 0.09)',
                        border: '1px solid rgba(47, 125, 246, 0.2)',
                        color: 'var(--rcf-azure-deep)',
                      }}
                    >
                      {call.direction === 'inbound' ? (
                        <ArrowDownLeft size={12} strokeWidth={2.25} aria-hidden="true" />
                      ) : (
                        <ArrowUpRight size={12} strokeWidth={2.25} aria-hidden="true" />
                      )}
                    </span>
                  </td>
                  {/* Caller */}
                  <td className="dlx-td" style={{ fontFamily: MONO, fontSize: '0.78rem', color: 'var(--rcf-ink)' }}>
                    {fmt(call.caller)}
                  </td>
                  {/* Arrow */}
                  <td className="dlx-td" style={{ padding: '12px 4px', color: 'var(--rcf-ink-dim)', fontSize: '0.75rem' }}>→</td>
                  {/* Callee */}
                  <td className="dlx-td" style={{ fontFamily: MONO, fontSize: '0.78rem', color: 'var(--rcf-ink)' }}>
                    {fmt(call.callee)}
                  </td>
                  {/* Duration */}
                  <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)', fontSize: '0.78rem', textAlign: 'right' }}>
                    {call.duration > 0 ? fmtDuration(call.duration) : '—'}
                  </td>
                  {/* Result badge */}
                  <td className="dlx-td" style={{ textAlign: 'center' }}>
                    <span
                      style={{
                        fontSize: '0.62rem',
                        fontWeight: 700,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        color: resultColor,
                        background: `${resultColor}12`,
                        border: `1px solid ${resultColor}38`,
                        borderRadius: 4,
                        padding: '2px 7px',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {call.result}
                    </span>
                  </td>
                  {/* Time */}
                  <td className="dlx-td" style={{ fontSize: '0.72rem', color: 'var(--rcf-ink-dim)', textAlign: 'right' }}>
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
    <SectionCard title="Quick Actions" icon={<Zap size={15} strokeWidth={1.8} />}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {/* View Customer */}
        <Link
          to={`/admin/customers/${user.customer_id}`}
          className="dl-btn dl-btn-ghost"
          style={{ textDecoration: 'none' }}
        >
          <Users size={14} strokeWidth={2} aria-hidden="true" />
          View Customer
          <ExternalLink size={11} strokeWidth={2} style={{ opacity: 0.6 }} aria-hidden="true" />
        </Link>

        {/* View in DID Lookup */}
        <Link
          to={didSearchUrl}
          className="dl-btn dl-btn-ghost"
          style={{ textDecoration: 'none' }}
        >
          <Search size={14} strokeWidth={2} aria-hidden="true" />
          View in DID Lookup
        </Link>

        {/* Toggle DND — placeholder */}
        <button type="button" className="dl-btn dl-btn-ghost" disabled title="Coming soon">
          Toggle DND
          <span className="dl-tag dl-tag-slate" style={{ fontSize: '0.55rem', padding: '1px 6px' }}>soon</span>
        </button>

        {/* Reset Extension — placeholder */}
        <button type="button" className="dl-btn dl-btn-ghost" disabled title="Coming soon">
          Reset Extension
          <span className="dl-tag dl-tag-slate" style={{ fontSize: '0.55rem', padding: '1px 6px' }}>soon</span>
        </button>
      </div>
    </SectionCard>
  );
}

// ─── RCF Numbers Card ─────────────────────────────────────────────────────────

interface RcfCardProps {
  rcf: RcfProduct[];
}

function RcfCard({ rcf }: RcfCardProps) {
  return (
    <SectionCard
      title={`RCF Numbers (${rcf.length})`}
      icon={<PhoneForwarded size={15} strokeWidth={1.8} />}
      flush
    >
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr>
              {['DID', 'Name', 'Forward To', 'Timeout', 'Failover', 'Caller ID', 'Status'].map((col) => (
                <th key={col} className="dl-th">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rcf.map((r) => (
              <tr key={r.id} className="dl-row">
                <td className="dlx-td" style={{ fontFamily: MONO, fontSize: '0.78rem', color: 'var(--rcf-ink)', fontWeight: 600 }}>
                  {fmt(r.did)}
                </td>
                <td className="dlx-td">
                  {r.name ?? <span style={{ color: 'var(--rcf-ink-dim)', fontStyle: 'italic' }}>—</span>}
                </td>
                <td className="dlx-td" style={{ fontFamily: MONO, fontSize: '0.78rem', color: 'var(--rcf-azure-deep)', fontWeight: 600 }}>
                  {fmt(r.forward_to)}
                </td>
                <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)', fontSize: '0.78rem' }}>
                  {r.ring_timeout}s
                </td>
                <td className="dlx-td" style={{ fontFamily: MONO, fontSize: '0.78rem' }}>
                  {r.failover_to ? fmt(r.failover_to) : <span style={{ color: 'var(--rcf-ink-dim)', fontStyle: 'italic' }}>None</span>}
                </td>
                <td className="dlx-td" style={{ textAlign: 'center' }}>
                  <span style={{ fontSize: '0.74rem', color: r.pass_caller_id ? 'var(--rcf-azure-deep)' : 'var(--rcf-ink-dim)', fontWeight: 600 }}>
                    {r.pass_caller_id ? 'Pass' : 'Strip'}
                  </span>
                </td>
                <td className="dlx-td" style={{ textAlign: 'center' }}>
                  <EnabledStatusTag enabled={r.enabled} />
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
  return (
    <SectionCard
      title={`API DIDs (${api_dids.length})`}
      icon={<Code2 size={15} strokeWidth={1.8} />}
      flush
    >
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
          <thead>
            <tr>
              {['DID', 'Voice URL', 'Status'].map((col) => (
                <th key={col} className="dl-th">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {api_dids.map((d) => (
              <tr key={d.did} className="dl-row">
                <td className="dlx-td" style={{ fontFamily: MONO, fontSize: '0.78rem', color: 'var(--rcf-ink)', fontWeight: 600 }}>
                  {fmt(d.did)}
                </td>
                <td className="dlx-td" style={{ maxWidth: 320, whiteSpace: 'normal' }}>
                  <span
                    style={{
                      fontSize: '0.74rem',
                      fontFamily: MONO,
                      color: 'var(--rcf-azure-deep)',
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
                <td className="dlx-td" style={{ textAlign: 'center' }}>
                  <EnabledStatusTag enabled={d.enabled} />
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
  return (
    <SectionCard
      title={`SIP Trunks (${trunks.length})`}
      icon={<Share2 size={15} strokeWidth={1.8} />}
      flush
    >
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
          <thead>
            <tr>
              {['Trunk Name', 'Max Channels', 'DIDs', 'Auth IPs', 'Status'].map((col) => (
                <th key={col} className="dl-th">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {trunks.map((t) => (
              <tr key={t.id} className="dl-row">
                <td className="dlx-td" style={{ color: 'var(--rcf-ink)', fontWeight: 700, fontSize: '0.82rem' }}>
                  {t.trunk_name}
                </td>
                <td className="dlx-td" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {t.max_channels}
                </td>
                <td className="dlx-td" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {t.did_count}
                </td>
                <td className="dlx-td" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {t.ip_count}
                </td>
                <td className="dlx-td" style={{ textAlign: 'center' }}>
                  <EnabledStatusTag enabled={t.enabled} />
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

  return (
    <SectionCard title="Edit User" icon={<Pencil size={14} strokeWidth={2} />}>
      {/* Banner */}
      {banner && (
        <div
          role="status"
          className={banner.type === 'success' ? 'dl-banner dl-banner-ok' : 'dl-banner dl-banner-err'}
          style={{ marginBottom: 20 }}
        >
          {banner.message}
        </div>
      )}

      {/* Form grid */}
      <div className="dlx-form-grid" style={{ marginBottom: 20 }}>
        {/* Name */}
        <div>
          <label className="dl-flabel" htmlFor="edit-user-name">Name</label>
          <input
            id="edit-user-name"
            type="text"
            className="dl-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={saving}
            placeholder="Full name"
            style={{ width: '100%' }}
          />
        </div>

        {/* Email */}
        <div>
          <label className="dl-flabel" htmlFor="edit-user-email">Email</label>
          <input
            id="edit-user-email"
            type="email"
            className="dl-input"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={saving}
            placeholder="user@example.com"
            style={{ width: '100%' }}
          />
        </div>

        {/* Role */}
        <div>
          <label className="dl-flabel" htmlFor="edit-user-role">Role</label>
          <select
            id="edit-user-role"
            className="dl-input"
            value={role}
            onChange={(e) => setRole(e.target.value as UserRole)}
            disabled={saving}
            style={{ width: '100%' }}
          >
            <option value="admin">Admin</option>
            <option value="user">User</option>
            <option value="readonly">Read-Only</option>
          </select>
        </div>

        {/* Status */}
        <div>
          <label className="dl-flabel" htmlFor="edit-user-status">Status</label>
          <select
            id="edit-user-status"
            className="dl-input"
            value={status}
            onChange={(e) => setStatus(e.target.value as 'active' | 'disabled')}
            disabled={saving}
            style={{ width: '100%' }}
          >
            <option value="active">Active</option>
            <option value="disabled">Disabled</option>
          </select>
        </div>

        {/* Customer */}
        <div>
          <label className="dl-flabel" htmlFor="edit-user-customer">Customer</label>
          <select
            id="edit-user-customer"
            className="dl-input"
            value={customerId}
            onChange={(e) => setCustomerId(parseInt(e.target.value, 10))}
            disabled={saving || customersLoading}
            style={{ width: '100%', cursor: saving || customersLoading ? 'wait' : 'pointer' }}
          >
            {customersLoading ? (
              <option value={customerId}>Loading customers…</option>
            ) : (
              sortedCustomers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}{c.status !== 'active' ? ` (${c.status})` : ''}
                </option>
              ))
            )}
          </select>
        </div>

        {/* New Password */}
        <div>
          <label className="dl-flabel" htmlFor="edit-user-password">
            New Password (leave blank to keep current)
          </label>
          <input
            id="edit-user-password"
            type="password"
            className="dl-input"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={saving}
            placeholder="Leave blank to keep current"
            autoComplete="new-password"
            style={{ width: '100%' }}
          />
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          className="dl-btn dl-btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? (
            <>
              <Spinner size="sm" />
              Saving…
            </>
          ) : (
            'Save Changes'
          )}
        </button>

        <button
          type="button"
          className="dl-btn dl-btn-ghost"
          onClick={onCancel}
          disabled={saving}
        >
          Cancel
        </button>
      </div>
    </SectionCard>
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
          color: 'var(--rcf-ink-dim)',
          fontSize: '0.85rem',
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
      <div className="dl-banner dl-banner-err">
        <strong style={{ display: 'block', marginBottom: 4 }}>Failed to load user details</strong>
        {msg}
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="dl-stack">
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
      <div className="dl-grid2">
        {data.extension ? (
          <ExtensionConfigCard extension={data.extension} />
        ) : (
          <SectionCard title="Extension Configuration" icon={<Settings size={15} strokeWidth={1.8} />}>
            <div style={{ color: 'var(--rcf-ink-dim)', fontSize: '0.82rem', fontStyle: 'italic', padding: '8px 0' }}>
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

// ─── All Users Table ──────────────────────────────────────────────────────────

interface AllUsersTableProps {
  users: User[];
  searchTerm: string;
  onSelectUser: (userId: number) => void;
}

function AllUsersTable({ users, searchTerm, onSelectUser }: AllUsersTableProps) {
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
      <div className="dl-empty" style={{ margin: '0 20px 20px' }}>
        {term.length > 0
          ? `No users match "${searchTerm}"`
          : 'No users found.'}
      </div>
    );
  }

  return (
    <div>
      {/* Row count strip */}
      <div
        style={{
          padding: '9px 20px',
          borderBottom: '1px solid var(--rcf-line-soft)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <span
          style={{
            fontSize: '0.64rem',
            color: 'var(--rcf-ink-dim)',
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
            fontWeight: 700,
          }}
        >
          {filtered.length} user{filtered.length !== 1 ? 's' : ''}
          {term.length > 0 && users.length !== filtered.length && (
            <span style={{ fontWeight: 400, marginLeft: 6, textTransform: 'none', letterSpacing: 0 }}>
              of {users.length} total
            </span>
          )}
        </span>
        <span style={{ fontSize: '0.68rem', color: 'var(--rcf-ink-dim)' }}>
          Click a row to open 360 view
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
          <thead>
            <tr>
              {['Name', 'Email', 'Role', 'Customer', 'Status', 'Last Login'].map((col) => (
                <th key={col} className="dl-th">{col}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr
                key={u.id}
                className="dl-row"
                onClick={() => onSelectUser(u.id)}
                style={{ cursor: 'pointer' }}
              >
                {/* Name + mini avatar */}
                <td className="dlx-td">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="dl-avatar dl-avatar-sm" aria-hidden="true">
                      {u.name.charAt(0).toUpperCase()}
                    </span>
                    <span style={{ fontSize: '0.82rem', color: 'var(--rcf-ink)', fontWeight: 600 }}>
                      {u.name}
                    </span>
                  </div>
                </td>

                {/* Email */}
                <td className="dlx-td" style={{ fontFamily: MONO, fontSize: '0.76rem', maxWidth: 220 }}>
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
                <td className="dlx-td">
                  <RoleTag role={(u.role as UserRole) ?? 'user'} />
                </td>

                {/* Customer */}
                <td className="dlx-td" style={{ maxWidth: 180 }}>
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
                    <span style={{ color: 'var(--rcf-ink-dim)', fontStyle: 'italic' }}>—</span>
                  )}
                </td>

                {/* Status */}
                <td className="dlx-td">
                  <span className={u.status === 'active' ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
                    {u.status}
                  </span>
                </td>

                {/* Last Login */}
                <td className="dlx-td" style={{ fontSize: '0.74rem', color: 'var(--rcf-ink-dim)' }}>
                  {fmtRelativeTime(u.last_login)}
                </td>
              </tr>
            ))}
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
    <section className="dl-panel">
      {/* Panel head: title + filter input */}
      <div className="dl-panel-head" style={{ flexWrap: 'wrap' }}>
        <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--rcf-azure-deep)', flexShrink: 0 }}>
          <Users size={15} strokeWidth={1.8} />
        </span>
        <h3 className="dl-panel-title" style={{ margin: 0 }}>All Users</h3>

        {/* Filter search input */}
        <div className="dlx-searchwrap" style={{ marginLeft: 'auto' }}>
          <Search size={14} strokeWidth={2} aria-hidden="true" />
          <input
            type="text"
            className="dl-input"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="Filter by name, email, role, customer, status…"
            style={{ width: '100%', paddingLeft: 34, paddingRight: 32 }}
          />
          {searchTerm.length > 0 && (
            <button
              type="button"
              className="dlx-search-clear"
              onClick={() => setSearchTerm('')}
              title="Clear filter"
            >
              <X size={12} strokeWidth={2.25} aria-hidden="true" />
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
            color: 'var(--rcf-ink-dim)',
            fontSize: '0.85rem',
            justifyContent: 'center',
          }}
        >
          <Spinner size="md" />
          <span>Loading users…</span>
        </div>
      )}

      {isError && (
        <div className="dl-panel-body">
          <div className="dl-banner dl-banner-err">
            <strong style={{ display: 'block', marginBottom: 3 }}>Failed to load users</strong>
            {error instanceof Error ? error.message : 'Unknown error'}
          </div>
        </div>
      )}

      {!isLoading && !isError && users != null && (
        <AllUsersTable
          users={users}
          searchTerm={searchTerm}
          onSelectUser={onSelectUser}
        />
      )}
    </section>
  );
}

// ─── Customer Picker Table ────────────────────────────────────────────────────

const CUSTOMER_PAGE_SIZE = 25;
const CUSTOMER_COL_COUNT = 6;

function accountTypeTag(type: PlatformCustomer['account_type']) {
  return <span className="dl-tag">{type.toUpperCase()}</span>;
}

function customerStatusPill(status: PlatformCustomer['status']) {
  if (status === 'active') return <span className="dl-pill dl-pill-on">Active</span>;
  if (status === 'suspended') return <span className="dl-pill dl-pill-off">Suspended</span>;
  return <span className="dl-tag dl-tag-slate">Closed</span>;
}

function gradeTag(grade: PlatformCustomer['traffic_grade']) {
  return <span className="dl-tag dl-tag-slate">{grade}</span>;
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
    <div className="dl-stack">
      {/* Search toolbar */}
      <div className="dlx-toolbar" style={{ marginBottom: 0 }}>
        <form onSubmit={handleSearch} className="dlx-toolbar-form">
          <input
            type="search"
            className="dl-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search customers…"
            style={{ flex: 1, maxWidth: 400 }}
          />
          <button type="submit" className="dl-btn dl-btn-ghost" style={{ flexShrink: 0 }}>
            Search
          </button>
        </form>
      </div>

      {/* Loading */}
      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--rcf-ink-dim)', fontSize: '0.85rem', padding: '48px 0' }}>
          <Spinner /> Loading customers…
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="dl-banner dl-banner-err">Failed to load customers.</div>
      )}

      {/* Table */}
      {data && (
        <>
          <section className="dl-panel">
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead>
                  <tr>
                    {['ID', 'Name', 'Type', 'Status', 'Grade', 'Created'].map((col) => (
                      <th key={col} className="dl-th">{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(data.items ?? []).length === 0 ? (
                    <tr>
                      <td colSpan={CUSTOMER_COL_COUNT} style={{ padding: 0 }}>
                        <div className="dl-empty" style={{ border: 'none', borderRadius: 0 }}>
                          No customers found.
                        </div>
                      </td>
                    </tr>
                  ) : (
                    (data.items ?? []).map((customer) => (
                      <tr
                        key={customer.id}
                        className="dl-row"
                        onClick={() => onSelectCustomer(customer)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td className="dlx-td">
                          <span style={{ color: 'var(--rcf-ink-dim)', fontFamily: MONO, fontSize: '0.76rem' }}>
                            #{customer.id}
                          </span>
                        </td>
                        <td className="dlx-td">
                          <span style={{ color: 'var(--rcf-ink)', fontWeight: 700, fontSize: '0.85rem' }}>
                            {customer.name}
                          </span>
                        </td>
                        <td className="dlx-td">{accountTypeTag(customer.account_type)}</td>
                        <td className="dlx-td">{customerStatusPill(customer.status)}</td>
                        <td className="dlx-td">{gradeTag(customer.traffic_grade)}</td>
                        <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)', fontSize: '0.78rem' }}>
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
          </section>

          {/* Load more */}
          {(data.items ?? []).length + offset < (data.total ?? 0) && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, paddingBottom: 8 }}>
              <button
                type="button"
                className="dl-btn dl-btn-ghost"
                onClick={() => setOffset((o) => o + CUSTOMER_PAGE_SIZE)}
              >
                Load more
              </button>
              <span style={{ fontSize: '0.78rem', color: 'var(--rcf-ink-dim)' }}>
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
    <div>
      {/* ── State 1: Customer picker ────────────────────────── */}
      {showCustomerPicker && (
        <CustomerPickerTable onSelectCustomer={handleSelectCustomer} />
      )}

      {/* ── State 2: User list for selected customer ─────────── */}
      {showUserList && (
        <>
          {/* Back to customers */}
          <div style={{ marginBottom: 18 }}>
            <button type="button" className="dlx-linkbtn" onClick={handleBackToCustomers}>
              <ChevronLeft size={13} strokeWidth={2.25} aria-hidden="true" />
              Back to customers
            </button>
          </div>

          {/* Customer subheading */}
          <div style={{ marginBottom: 18 }}>
            <div className="dl-crumb">
              <span>Customer</span>
            </div>
            <h2
              style={{
                margin: '6px 0 0',
                fontFamily: ARCHIVO,
                fontSize: '1.05rem',
                fontWeight: 700,
                color: 'var(--rcf-ink)',
                letterSpacing: '-0.015em',
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
              className="dlx-linkbtn"
              onClick={selectedCustomer != null ? handleBackToUsers : handleBackToCustomers}
            >
              <ChevronLeft size={13} strokeWidth={2.25} aria-hidden="true" />
              {selectedCustomer != null ? `Back to ${selectedCustomer.name} users` : 'Back to customers'}
            </button>
          </div>
          <User360View userId={selectedUserId!} />
        </>
      )}
    </div>
  );
}
