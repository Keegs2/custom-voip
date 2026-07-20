/**
 * CustomerUcaasSection — UCaaS extension/voicemail management inside the customer
 * 360. Glass header with a count chip + auto-provision action, a glass extensions
 * table (presence, voicemail, DND, status), and a glass empty/auto-provision
 * prompt. Queries + mutations run on live data, unchanged.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { apiRequest } from '../../../../api/client';
import { Button } from '../../../../components/ui/Button';
import { Spinner } from '../../../../components/ui/Spinner';
import { useToast } from '../../../../components/ui/Toast';
import { GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import {
  errorNote,
  inlineLoading,
  sectionEyebrow,
  tableHead,
  tableShell,
} from '../styles';

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
// Inline icon components
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
  accent: string;
}

function ExtensionRow({ ext, index, accent }: ExtensionRowProps) {
  const navigate = useNavigate();

  const isAssigned = ext.user_id !== null;
  const isClickable = isAssigned;
  const baseBg = index % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.015)';

  function handleClick() {
    if (isClickable) {
      navigate(`/admin/user/${ext.user_id}`);
    }
  }

  return (
    <tr
      onClick={isClickable ? handleClick : undefined}
      style={{
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        background: baseBg,
        cursor: isClickable ? 'pointer' : 'default',
        transition: 'background 0.1s',
      }}
      onMouseEnter={(e) => {
        if (isClickable) {
          e.currentTarget.style.background = hexToRgba(accent, 0.06);
        }
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = baseBg;
      }}
    >
      {/* Extension number */}
      <td style={{ padding: '8px 14px', whiteSpace: 'nowrap' }}>
        <span style={{ fontFamily: 'monospace', fontWeight: 700, fontSize: '0.9rem', color: accent, letterSpacing: '0.5px' }}>
          {ext.extension}
        </span>
      </td>

      {/* User */}
      <td style={{ padding: '8px 14px', minWidth: 160 }}>
        {isAssigned ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: GLASS.success, flexShrink: 0 }}>
              <UserCheckIcon />
            </span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: '0.82rem', fontWeight: 600, color: GLASS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {ext.display_name ?? ext.user_name ?? `User #${ext.user_id}`}
              </div>
              {ext.user_email && (
                <div style={{ fontSize: '0.7rem', color: GLASS.textFaint, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {ext.user_email}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ color: GLASS.textFaint, flexShrink: 0 }}>
              <UserXIcon />
            </span>
            <span style={{ fontSize: '0.82rem', color: GLASS.textFaint, fontStyle: 'italic' }}>
              Unassigned
            </span>
          </div>
        )}
      </td>

      {/* DID */}
      <td style={{ padding: '8px 14px', fontFamily: 'monospace', fontSize: '0.78rem', color: ext.assigned_did ? GLASS.textMuted : GLASS.textFaint, whiteSpace: 'nowrap' }}>
        {ext.assigned_did ? formatDid(ext.assigned_did) : '—'}
      </td>

      {/* Voicemail */}
      <td style={{ padding: '8px 14px', textAlign: 'center' }}>
        <GlassChip
          label={ext.voicemail_enabled ? 'On' : 'Off'}
          color={ext.voicemail_enabled ? GLASS.success : GLASS.textFaint}
        />
      </td>

      {/* DND */}
      <td style={{ padding: '8px 14px', textAlign: 'center' }}>
        <GlassChip label={ext.dnd ? 'On' : 'Off'} color={ext.dnd ? '#a855f7' : GLASS.textFaint} />
      </td>

      {/* Presence */}
      <td style={{ padding: '8px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <PresenceDot status={ext.presence_status} />
          <span style={{ fontSize: '0.78rem', color: ext.presence_status === 'offline' ? GLASS.textFaint : GLASS.textMuted, textTransform: 'capitalize' }}>
            {ext.presence_status}
          </span>
        </div>
      </td>

      {/* Status */}
      <td style={{ padding: '8px 14px' }}>
        <GlassChip
          label={ext.status === 'active' ? 'Active' : 'Disabled'}
          color={ext.status === 'active' ? GLASS.success : GLASS.textFaint}
          dot={ext.status === 'active'}
        />
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Main section component
// ---------------------------------------------------------------------------

interface CustomerUcaasSectionProps {
  customerId: number;
  accent?: string;
}

export function CustomerUcaasSection({ customerId, accent = '#0ea5e9' }: CustomerUcaasSectionProps) {
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
    <div>
      {/* Section header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
          flexWrap: 'wrap',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: accent, display: 'flex', alignItems: 'center' }}>
            <HeadphonesIcon />
          </span>
          <span style={sectionEyebrow(accent)}>UCaaS Extensions</span>
          {!isLoading && !isError && (
            <GlassChip label={count === 1 ? '1 extension' : `${count} extensions`} color={accent} />
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

      {isLoading && (
        <div style={inlineLoading}>
          <Spinner size="xs" /> Loading extensions…
        </div>
      )}

      {isError && <div style={errorNote()}>Could not load extensions.</div>}

      {/* Empty state */}
      {!isLoading && !isError && extensions.length === 0 && (
        <div
          style={{
            padding: '20px 18px',
            borderRadius: 14,
            background: hexToRgba(accent, 0.05),
            border: `1px dashed ${hexToRgba(accent, 0.25)}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <p style={{ color: GLASS.textMuted, fontSize: '0.82rem', margin: 0, fontStyle: 'italic' }}>
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
        <div style={{ ...tableShell, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', color: '#cbd5e0' }}>
            <thead>
              <tr>
                {COLUMNS.map((col) => (
                  <th
                    key={col}
                    style={{
                      ...tableHead,
                      textAlign: col === 'Voicemail' || col === 'DND' ? 'center' : 'left',
                    }}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {extensions.map((ext, i) => (
                <ExtensionRow key={ext.id} ext={ext} index={i} accent={accent} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Auto-provision CTA when there are some unassigned rows (not empty overall) */}
      {!isLoading && !isError && extensions.length > 0 && hasUnassigned && (
        <p style={{ fontSize: '0.72rem', color: GLASS.textFaint, margin: '10px 0 0', fontStyle: 'italic' }}>
          Some extensions are unassigned. Click "Auto-provision Extensions" to assign numbers to
          all remaining users.
        </p>
      )}
    </div>
  );
}
