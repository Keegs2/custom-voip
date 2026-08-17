/**
 * CustomerUcaasSection — UCaaS extensions panel on the admin Customer 360
 * (ucaas accounts, or api/trunk/hybrid with the UCaaS add-on enabled):
 * extension table with presence, voicemail/DND flags, and auto-provision.
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * admin-area `dlx-*` primitives in dl-admin.css). Renders its own dl-panel.
 * Presence/status colors keep semantics on the light canvas: green =
 * available, red = busy/do-not-disturb (do-not-ring), amber = away (genuine
 * "may not answer" state), slate = offline. Presentation only: the
 * extensions query, the auto-provision mutation, and every toast are
 * unchanged, as is the row-click navigation to the user 360.
 *
 * React #310: every hook in every component below is called unconditionally
 * at the top of its function, before any early return.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Headphones, UserCheck, UserX } from 'lucide-react';
import { apiRequest } from '../../api/client';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import { fmt } from '../../utils/format';
import '../../styles/dl-admin.css';

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
// Presence dot — daylight ink/status palette, semantics preserved
// ---------------------------------------------------------------------------

const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

const PRESENCE_COLORS: Record<Extension['presence_status'], string> = {
  available: '#15803d',
  busy: '#b91c1c',
  away: '#b45309',
  dnd: '#b91c1c',
  offline: '#5d6f8c',
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
        flexShrink: 0,
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Table column headers
// ---------------------------------------------------------------------------

const COLUMNS = ['Ext', 'User', 'DID', 'Voicemail', 'DND', 'Presence', 'Status'];

// ---------------------------------------------------------------------------
// On/off flag tag (voicemail, DND)
// ---------------------------------------------------------------------------

function FlagTag({ on, onIsNegative }: { on: boolean; onIsNegative?: boolean }) {
  if (!on) return <span className="dl-tag dl-tag-slate">Off</span>;
  return (
    <span className={onIsNegative ? 'dl-pill dl-pill-off' : 'dl-pill dl-pill-on'}>On</span>
  );
}

// ---------------------------------------------------------------------------
// Extension row
// ---------------------------------------------------------------------------

interface ExtensionRowProps {
  ext: Extension;
}

function ExtensionRow({ ext }: ExtensionRowProps) {
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
      className="dl-row"
      onClick={isClickable ? handleClick : undefined}
      style={{ cursor: isClickable ? 'pointer' : 'default' }}
    >
      {/* Extension number */}
      <td className="dlx-td">
        <span
          style={{
            fontFamily: MONO,
            fontWeight: 700,
            fontSize: '0.88rem',
            color: 'var(--rcf-azure-deep)',
            letterSpacing: '0.02em',
          }}
        >
          {ext.extension}
        </span>
      </td>

      {/* User */}
      <td className="dlx-td" style={{ minWidth: 160, whiteSpace: 'normal' }}>
        {isAssigned ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ color: 'var(--rcf-green)', flexShrink: 0, display: 'inline-flex' }}>
              <UserCheck size={13} strokeWidth={2} aria-hidden="true" />
            </span>
            <div style={{ minWidth: 0 }}>
              <div
                style={{
                  fontSize: '0.82rem',
                  fontWeight: 700,
                  color: 'var(--rcf-ink)',
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
                    color: 'var(--rcf-ink-dim)',
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ color: 'var(--rcf-ink-dim)', flexShrink: 0, display: 'inline-flex' }}>
              <UserX size={13} strokeWidth={2} aria-hidden="true" />
            </span>
            <span style={{ fontSize: '0.82rem', color: 'var(--rcf-ink-dim)', fontStyle: 'italic' }}>
              Unassigned
            </span>
          </div>
        )}
      </td>

      {/* DID */}
      <td
        className="dlx-td"
        style={{
          fontFamily: MONO,
          fontSize: '0.78rem',
          color: ext.assigned_did ? 'var(--rcf-ink-soft)' : 'var(--rcf-ink-dim)',
        }}
      >
        {ext.assigned_did ? fmt(ext.assigned_did) : '—'}
      </td>

      {/* Voicemail */}
      <td className="dlx-td" style={{ textAlign: 'center' }}>
        <FlagTag on={ext.voicemail_enabled} />
      </td>

      {/* DND — "On" means do-not-ring, a genuinely blocking state → red */}
      <td className="dlx-td" style={{ textAlign: 'center' }}>
        <FlagTag on={ext.dnd} onIsNegative />
      </td>

      {/* Presence */}
      <td className="dlx-td">
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <PresenceDot status={ext.presence_status} />
          <span
            style={{
              fontSize: '0.78rem',
              color:
                ext.presence_status === 'offline' ? 'var(--rcf-ink-dim)' : 'var(--rcf-ink-soft)',
              textTransform: 'capitalize',
            }}
          >
            {ext.presence_status}
          </span>
        </div>
      </td>

      {/* Status */}
      <td className="dlx-td">
        <span className={ext.status === 'active' ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
          {ext.status === 'active' ? 'Active' : 'Disabled'}
        </span>
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
    <section className="dl-panel">
      {/* ── Panel head ── */}
      <div className="dl-panel-head">
        <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--rcf-azure-deep)', flexShrink: 0 }}>
          <Headphones size={15} strokeWidth={2} />
        </span>
        <h3 className="dl-panel-title" style={{ margin: 0 }}>UCaaS Extensions</h3>
        {!isLoading && !isError && (
          <span className="dl-count">
            {count === 1 ? '1 extension' : `${count} extensions`}
          </span>
        )}

        {/* Auto-provision button — shown when there are users lacking extensions */}
        {!isLoading && !isError && hasUnassigned && (
          <button
            type="button"
            className="dl-btn dl-btn-primary dlx-btn-sm"
            style={{ marginLeft: 'auto', flexShrink: 0 }}
            disabled={autoProvisionMutation.isPending}
            onClick={() => autoProvisionMutation.mutate()}
          >
            {autoProvisionMutation.isPending ? 'Provisioning…' : 'Auto-provision Extensions'}
          </button>
        )}
      </div>

      <div className="dl-panel-body">
        {/* Loading */}
        {isLoading && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: 'var(--rcf-ink-dim)',
              fontSize: '0.8rem',
              padding: '8px 0',
            }}
          >
            <Spinner size="xs" /> Loading extensions…
          </div>
        )}

        {/* Error */}
        {isError && (
          <div className="dl-banner dl-banner-err">Could not load extensions.</div>
        )}

        {/* Empty state */}
        {!isLoading && !isError && extensions.length === 0 && (
          <div className="dl-empty" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <span>
              No extensions provisioned. Use the auto-provision feature to assign extensions to all
              users.
            </span>
            <button
              type="button"
              className="dl-btn dl-btn-primary"
              disabled={autoProvisionMutation.isPending}
              onClick={() => autoProvisionMutation.mutate()}
            >
              {autoProvisionMutation.isPending ? 'Provisioning…' : 'Auto-provision Extensions'}
            </button>
          </div>
        )}

        {/* Extensions table */}
        {!isLoading && extensions.length > 0 && (
          <div style={{ overflowX: 'auto', border: '1px solid var(--rcf-line-soft)', borderRadius: 10 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720 }}>
              <thead>
                <tr>
                  {COLUMNS.map((col) => (
                    <th
                      key={col}
                      className="dl-th"
                      style={
                        col === 'Voicemail' || col === 'DND'
                          ? { textAlign: 'center' }
                          : undefined
                      }
                    >
                      {col}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {extensions.map((ext) => (
                  <ExtensionRow key={ext.id} ext={ext} />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Auto-provision CTA when there are some unassigned rows (not empty overall) */}
        {!isLoading && !isError && extensions.length > 0 && hasUnassigned && (
          <p
            className="dl-help"
            style={{ margin: '10px 0 0', fontStyle: 'italic' }}
          >
            Some extensions are unassigned. Click &quot;Auto-provision Extensions&quot; to assign
            numbers to all remaining users.
          </p>
        )}
      </div>
    </section>
  );
}
