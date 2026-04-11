import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiRequest } from '../../api/client';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Extension {
  id: number;
  extension: string;
  user_id: number | null;
  customer_id: number;
  display_name: string | null;
  assigned_did: string | null;
  voicemail_enabled: boolean;
  dnd: boolean;
  status: 'active' | 'disabled';
  user_name: string | null;
  user_email: string | null;
  presence_status: 'available' | 'busy' | 'away' | 'dnd' | 'offline';
  presence_message: string | null;
}

interface AutoProvisionResponse {
  count: number;
  provisioned: Extension[];
  message?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Format an E.164 phone number to +1 (XXX) XXX-XXXX for North American numbers,
 * or return the raw value for other regions.
 */
function formatDid(did: string): string {
  // North American: +1 followed by exactly 10 digits
  const naMatch = did.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  if (naMatch) {
    return `+1 (${naMatch[1]}) ${naMatch[2]}-${naMatch[3]}`;
  }
  return did;
}

// ---------------------------------------------------------------------------
// Presence dot
// ---------------------------------------------------------------------------

const PRESENCE_COLORS: Record<Extension['presence_status'], string> = {
  available: '#22c55e',
  busy: '#ef4444',
  away: '#f59e0b',
  dnd: '#a855f7',
  offline: '#475569',
};

function PresenceDot({ status }: { status: Extension['presence_status'] }) {
  const color = PRESENCE_COLORS[status] ?? PRESENCE_COLORS.offline;
  return (
    <span
      title={status.charAt(0).toUpperCase() + status.slice(1)}
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        boxShadow: status !== 'offline' ? `0 0 5px ${color}99` : 'none',
        flexShrink: 0,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Inline icon components (avoid lucide-react bundle if not already present)
// ---------------------------------------------------------------------------

function HeadphonesIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ width: 16, height: 16, flexShrink: 0 }}
    >
      <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
      <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
    </svg>
  );
}

function UserCheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ width: 13, height: 13, flexShrink: 0 }}
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <polyline points="17 11 19 13 23 9" />
    </svg>
  );
}

function UserXIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ width: 13, height: 13, flexShrink: 0 }}
    >
      <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="8.5" cy="7" r="4" />
      <line x1="18" y1="8" x2="23" y2="13" />
      <line x1="23" y1="8" x2="18" y2="13" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Table column headers
// ---------------------------------------------------------------------------

const COLUMNS = ['Ext', 'User', 'DID', 'Voicemail', 'DND', 'Presence', 'Status'];

// ---------------------------------------------------------------------------
// Extension row
// ---------------------------------------------------------------------------

interface ExtensionRowProps {
  ext: Extension;
  index: number;
}

function ExtensionRow({ ext, index }: ExtensionRowProps) {
  const navigate = useNavigate();

  const isAssigned = ext.user_id !== null;
  const isClickable = isAssigned;

  function handleClick() {
    if (isClickable) {
      navigate(`/admin/user/${ext.user_id}`);
    }
  }

  return (
    <tr
      onClick={isClickable ? handleClick : undefined}
      style={{
        borderBottom: '1px solid rgba(42,47,69,0.22)',
        background: index % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)',
        cursor: isClickable ? 'pointer' : 'default',
        transition: 'background 0.1s',
      }}
      onMouseEnter={(e) => {
        if (isClickable) {
          e.currentTarget.style.background = 'rgba(14,165,233,0.06)';
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background =
          index % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.012)';
      }}
    >
      {/* Extension number */}
      <td style={{ padding: '8px 14px', whiteSpace: 'nowrap' }}>
        <span
          style={{
            fontFamily: 'monospace',
            fontWeight: 700,
            fontSize: '0.9rem',
            color: '#0ea5e9',
            letterSpacing: '0.5px',
          }}
        >
          {ext.extension}
        </span>
      </td>

      {/* User */}
      <td style={{ padding: '8px 14px', minWidth: 160 }}>
        {isAssigned ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#22c55e', flexShrink: 0 }}>
              <UserCheckIcon />
            </span>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: '0.82rem',
                  fontWeight: 600,
                  color: '#e2e8f0',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {ext.display_name ?? ext.user_name ?? `User #${ext.user_id}`}
              </div>
              {ext.user_email && (
                <div
                  style={{
                    fontSize: '0.7rem',
                    color: '#4a5568',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {ext.user_email}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: '#4a5568', flexShrink: 0 }}>
              <UserXIcon />
            </span>
            <span style={{ fontSize: '0.82rem', color: '#4a5568', fontStyle: 'italic' }}>
              Unassigned
            </span>
          </div>
        )}
      </td>

      {/* DID */}
      <td
        style={{
          padding: '8px 14px',
          fontFamily: 'monospace',
          fontSize: '0.78rem',
          color: ext.assigned_did ? '#94a3b8' : '#2d3748',
          whiteSpace: 'nowrap',
        }}
      >
        {ext.assigned_did ? formatDid(ext.assigned_did) : '—'}
      </td>

      {/* Voicemail */}
      <td style={{ padding: '8px 14px', textAlign: 'center' }}>
        <span
          style={{
            display: 'inline-block',
            fontSize: '0.6rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            padding: '2px 7px',
            borderRadius: 4,
            background: ext.voicemail_enabled
              ? 'rgba(34,197,94,0.12)'
              : 'rgba(71,85,105,0.15)',
            color: ext.voicemail_enabled ? '#4ade80' : '#475569',
            border: ext.voicemail_enabled
              ? '1px solid rgba(34,197,94,0.2)'
              : '1px solid rgba(71,85,105,0.2)',
          }}
        >
          {ext.voicemail_enabled ? 'On' : 'Off'}
        </span>
      </td>

      {/* DND */}
      <td style={{ padding: '8px 14px', textAlign: 'center' }}>
        <span
          style={{
            display: 'inline-block',
            fontSize: '0.6rem',
            fontWeight: 700,
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            padding: '2px 7px',
            borderRadius: 4,
            background: ext.dnd
              ? 'rgba(168,85,247,0.12)'
              : 'rgba(71,85,105,0.12)',
            color: ext.dnd ? '#c084fc' : '#475569',
            border: ext.dnd
              ? '1px solid rgba(168,85,247,0.22)'
              : '1px solid rgba(71,85,105,0.18)',
          }}
        >
          {ext.dnd ? 'On' : 'Off'}
        </span>
      </td>

      {/* Presence */}
      <td style={{ padding: '8px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <PresenceDot status={ext.presence_status} />
          <span
            style={{
              fontSize: '0.78rem',
              color:
                ext.presence_status === 'offline' ? '#4a5568' : '#94a3b8',
              textTransform: 'capitalize',
            }}
          >
            {ext.presence_status}
          </span>
        </div>
      </td>

      {/* Status */}
      <td style={{ padding: '8px 14px' }}>
        <Badge variant={ext.status === 'active' ? 'active' : 'disabled'}>
          {ext.status === 'active' ? 'Active' : 'Disabled'}
        </Badge>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main section component
// ---------------------------------------------------------------------------

interface CustomerUcaasSectionProps {
  customerId: number;
}

export function CustomerUcaasSection({ customerId }: CustomerUcaasSectionProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const { data, isLoading, isError } = useQuery<Extension[]>({
    queryKey: ['customerExtensions', customerId],
    queryFn: () => apiRequest<Extension[]>('GET', `/extensions?customer_id=${customerId}`),
    staleTime: 30_000,
  });

  const autoProvisionMutation = useMutation({
    mutationFn: () =>
      apiRequest<AutoProvisionResponse>('POST', '/extensions/auto-provision', {
        customer_id: customerId,
      }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['customerExtensions', customerId] });
      if (result.count === 0) {
        toastOk(result.message ?? 'All users already have extensions');
      } else {
        toastOk(
          `Auto-provisioned ${result.count} extension${result.count === 1 ? '' : 's'} successfully`,
        );
      }
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const extensions = data ?? [];
  const count = extensions.length;

  // Determine if any extensions are unassigned — show auto-provision prompt
  const hasUnassigned = extensions.some((e) => e.user_id === null);

  return (
    <div style={{ paddingTop: 16, borderTop: '1px solid rgba(42,47,69,0.5)' }}>

      {/* Section header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 14,
          flexWrap: 'wrap',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#0ea5e9', display: 'flex', alignItems: 'center' }}>
            <HeadphonesIcon />
          </span>
          <span
            style={{
              fontSize: '0.65rem',
              fontWeight: 700,
              color: '#0ea5e9',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            UCaaS Extensions
          </span>
          {!isLoading && !isError && (
            <span
              style={{
                fontSize: '0.62rem',
                fontWeight: 700,
                color: '#0ea5e9',
                background: 'rgba(14,165,233,0.12)',
                border: '1px solid rgba(14,165,233,0.25)',
                borderRadius: 20,
                padding: '1px 8px',
                letterSpacing: '0.3px',
                lineHeight: 1.6,
              }}
            >
              {count === 1 ? '1 extension' : `${count} extensions`}
            </span>
          )}
        </div>

        {/* Auto-provision button — shown when there are users lacking extensions */}
        {!isLoading && !isError && hasUnassigned && (
          <Button
            variant="primary"
            size="xs"
            loading={autoProvisionMutation.isPending}
            onClick={() => autoProvisionMutation.mutate()}
          >
            Auto-provision Extensions
          </Button>
        )}
      </div>

      {/* Loading */}
      {isLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: '#718096',
            fontSize: '0.8rem',
            padding: '8px 0',
          }}
        >
          <Spinner size="xs" /> Loading extensions…
        </div>
      )}

      {/* Error */}
      {isError && (
        <p style={{ color: '#f87171', fontSize: '0.8rem', margin: 0 }}>
          Could not load extensions.
        </p>
      )}

      {/* Empty state */}
      {!isLoading && !isError && extensions.length === 0 && (
        <div
          style={{
            padding: '20px 18px',
            borderRadius: 10,
            background: 'rgba(14,165,233,0.04)',
            border: '1px dashed rgba(14,165,233,0.2)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <p
            style={{
              color: '#4a5568',
              fontSize: '0.82rem',
              margin: 0,
              fontStyle: 'italic',
            }}
          >
            No extensions provisioned. Use the auto-provision feature to assign extensions to all
            users.
          </p>
          <div>
            <Button
              variant="primary"
              size="sm"
              loading={autoProvisionMutation.isPending}
              onClick={() => autoProvisionMutation.mutate()}
            >
              Auto-provision Extensions
            </Button>
          </div>
        </div>
      )}

      {/* Extensions table */}
      {!isLoading && extensions.length > 0 && (
        <div
          style={{
            overflowX: 'auto',
            background: 'rgba(10,12,18,0.5)',
            border: '1px solid rgba(42,47,69,0.35)',
            borderRadius: 10,
          }}
        >
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: '0.78rem',
              color: '#cbd5e0',
            }}
          >
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={col}
                    style={{
                      padding: '9px 14px',
                      textAlign: col === 'Voicemail' || col === 'DND' ? 'center' : 'left',
                      fontSize: '0.6rem',
                      fontWeight: 700,
                      textTransform: 'uppercase',
                      letterSpacing: '0.08em',
                      color: '#4a5568',
                      borderBottom: '1px solid rgba(42,47,69,0.5)',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {extensions.map((ext, i) => (
                <ExtensionRow key={ext.id} ext={ext} index={i} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Auto-provision CTA when there are some unassigned rows (not empty overall) */}
      {!isLoading && !isError && extensions.length > 0 && hasUnassigned && (
        <p
          style={{
            fontSize: '0.72rem',
            color: '#4a5568',
            margin: '10px 0 0',
            fontStyle: 'italic',
          }}
        >
          Some extensions are unassigned. Click "Auto-provision Extensions" to assign numbers to
          all remaining users.
        </p>
      )}
    </div>
  );
}
