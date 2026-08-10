import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle } from 'lucide-react';
import {
  listOnboardingRequests,
  completeOnboarding,
  rejectOnboarding,
} from '../../api/onboarding';
import {
  ATTACH_TO_LABELS,
  GOV_ID_TYPE_LABELS,
  INTENDED_USE_LABELS,
  PRODUCT_CHIP_LABELS,
  PRODUCT_LABELS,
  PRODUCT_ORDER,
  type KycRecord,
  type OnboardingRequest,
  type OnboardingStatus,
  type ProductKey,
  type ProductsRecord,
} from '../../types/onboarding';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import { fmt } from '../../utils/format';

// ─── Status filter tabs ───────────────────────────────────────────────────────

type FilterTab = 'all' | OnboardingStatus;

interface StatusTab {
  label: string;
  value: FilterTab;
}

const STATUS_TABS: StatusTab[] = [
  { label: 'All',       value: 'all'       },
  { label: 'Pending',   value: 'pending'   },
  { label: 'Completed', value: 'completed' },
  { label: 'Rejected',  value: 'rejected'  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusBadgeVariant(status: OnboardingStatus) {
  switch (status) {
    case 'pending':   return 'pending' as const;
    case 'completed': return 'active'  as const;
    case 'rejected':  return 'rejected' as const;
  }
}

function statusLabel(status: OnboardingStatus): string {
  switch (status) {
    case 'pending':   return 'Pending';
    case 'completed': return 'Completed';
    case 'rejected':  return 'Rejected';
  }
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

// ─── Shared input styles ──────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: '100%',
  fontSize: '0.82rem',
  padding: '8px 12px',
  borderRadius: 8,
  border: '1px solid rgba(59,130,246,0.15)',
  background: 'rgba(13,15,21,0.55)',
  color: '#e2e8f0',
  outline: 'none',
  boxSizing: 'border-box',
};

const textareaStyle: React.CSSProperties = {
  ...inputStyle,
  resize: 'vertical',
  minHeight: 72,
  fontFamily: 'inherit',
};

const sectionLabel: React.CSSProperties = {
  fontSize: '0.6rem',
  fontWeight: 700,
  color: '#3b82f6',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  marginBottom: 12,
};

const fieldLabel: React.CSSProperties = {
  fontSize: '0.72rem',
  fontWeight: 600,
  color: '#718096',
  marginBottom: 4,
  display: 'block',
};

const fieldValue: React.CSSProperties = {
  fontSize: '0.875rem',
  color: '#e2e8f0',
};

// ─── Info pair (read-only display field) ──────────────────────────────────────

function InfoPair({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <span style={fieldLabel}>{label}</span>
      <span style={fieldValue}>{value || '—'}</span>
    </div>
  );
}

// ─── Products (products-v1) ───────────────────────────────────────────────────

/** Small product chip — summary rows + detail header. `dim` marks the
    implicit RCF chip on legacy (pre-products) requests. */
function ProductChip({ product, dim }: { product: ProductKey; dim?: boolean }) {
  return (
    <span
      style={{
        flexShrink: 0,
        fontSize: '0.58rem',
        fontWeight: 700,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color: dim ? '#718096' : '#93c5fd',
        background: dim ? 'rgba(113,128,150,0.08)' : 'rgba(59,130,246,0.12)',
        border: dim
          ? '1px solid rgba(113,128,150,0.3)'
          : '1px solid rgba(59,130,246,0.3)',
        borderRadius: 4,
        padding: '2px 6px',
        whiteSpace: 'nowrap',
      }}
    >
      {PRODUCT_CHIP_LABELS[product]}
    </span>
  );
}

/** Bordered per-product well inside the detail panel — same idiom as the
    KYC high-volume block. */
function ProductBlock({
  product,
  children,
}: {
  product: ProductKey;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: '14px 16px',
        borderRadius: 10,
        background: 'rgba(59,130,246,0.05)',
        border: '1px solid rgba(59,130,246,0.18)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ ...sectionLabel, marginBottom: 0 }}>
        {PRODUCT_LABELS[product]}
      </div>
      {children}
    </div>
  );
}

const infoGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
  gap: '12px 24px',
};

/**
 * Requirements section of the detail panel.
 * Product-aware requests render global sizing + one block per selected
 * product; legacy rows (products NULL) keep the old top-level RCF fields.
 */
function RequirementsSection({ request }: { request: OnboardingRequest }) {
  const products: ProductsRecord | null = request.products;

  if (!products) {
    return (
      <div>
        <div style={sectionLabel}>Requirements — Legacy RCF Intake</div>
        <div style={infoGrid}>
          <InfoPair label="DIDs Requested" value={request.did_count} />
          <InfoPair label="Porting Existing Numbers?" value={request.porting} />
          <InfoPair label="Current Carrier" value={request.current_carrier} />
          <InfoPair label="Forwarding Setup" value={request.forwarding_setup} />
          <InfoPair label="Monthly Volume" value={request.monthly_volume} />
          <InfoPair label="Timeline" value={request.timeline} />
        </div>
      </div>
    );
  }

  const selected = PRODUCT_ORDER.filter((p) => products.selected.includes(p));
  const { rcf, trunk, api, voicemail } = products;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ ...sectionLabel, marginBottom: 0 }}>
          Products &amp; Requirements
        </div>
        {selected.map((p) => (
          <ProductChip key={p} product={p} />
        ))}
      </div>

      {/* Global sizing */}
      <div style={{ ...infoGrid, marginTop: 12 }}>
        <InfoPair label="Monthly Volume" value={request.monthly_volume} />
        <InfoPair label="Timeline" value={request.timeline} />
      </div>

      {/* Per-product blocks, stable order */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
        {rcf && (
          <ProductBlock product="rcf">
            <div style={infoGrid}>
              <InfoPair label="DIDs Requested" value={rcf.did_count} />
              <InfoPair label="Porting Existing Numbers?" value={rcf.porting} />
              {rcf.current_carrier && (
                <InfoPair label="Current Carrier" value={rcf.current_carrier} />
              )}
              <InfoPair label="Forwarding Setup" value={rcf.forwarding_setup} />
            </div>
          </ProductBlock>
        )}

        {trunk && (
          <ProductBlock product="trunk">
            <div style={infoGrid}>
              <InfoPair
                label="Concurrent Call Paths"
                value={trunk.concurrent_call_paths.toLocaleString('en-US')}
              />
              <InfoPair label="PBX Vendor" value={trunk.pbx_vendor} />
              <InfoPair label="DIDs Needed" value={trunk.dids_needed} />
            </div>
            <div>
              <span style={fieldLabel}>
                Signaling IPs ({trunk.signaling_ips.length}) — IP-authenticated,
                no registration
              </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                {trunk.signaling_ips.map((ip) => (
                  <IpChip key={ip} ip={ip} />
                ))}
              </div>
            </div>
          </ProductBlock>
        )}

        {api && (
          <ProductBlock product="api">
            <div>
              <span style={fieldLabel}>Use Case</span>
              <p style={{ ...fieldValue, fontSize: '0.82rem', margin: 0, lineHeight: 1.55 }}>
                {api.use_case}
              </p>
            </div>
            <div style={infoGrid}>
              <InfoPair
                label="Expected Calls / Second"
                value={
                  api.expected_cps != null
                    ? api.expected_cps.toLocaleString('en-US')
                    : null
                }
              />
              <InfoPair
                label="Needs Numbers Provided?"
                value={api.needs_numbers ? 'Yes' : 'No'}
              />
              <div>
                <span style={fieldLabel}>Webhook URL</span>
                {api.webhook_url ? (
                  <span
                    style={{
                      ...fieldValue,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: '0.78rem',
                      color: '#93c5fd',
                      wordBreak: 'break-all',
                    }}
                  >
                    {api.webhook_url}
                  </span>
                ) : (
                  <span style={fieldValue}>—</span>
                )}
              </div>
            </div>
          </ProductBlock>
        )}

        {voicemail && (
          <ProductBlock product="voicemail">
            <div style={infoGrid}>
              <InfoPair
                label="Mailboxes"
                value={voicemail.mailbox_count.toLocaleString('en-US')}
              />
              <InfoPair
                label="Attach To"
                value={ATTACH_TO_LABELS[voicemail.attach_to] ?? voicemail.attach_to}
              />
            </div>
          </ProductBlock>
        )}
      </div>
    </div>
  );
}

// ─── KYC — Business verification (FCC Know-Your-Customer) ─────────────────────

/** Amber warning chip — matches the admin warning idiom (#f59e0b family). */
function WarningChip({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: '0.66rem',
        fontWeight: 700,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        color: '#fbbf24',
        background: 'rgba(245,158,11,0.09)',
        border: '1px solid rgba(245,158,11,0.28)',
        borderRadius: 6,
        padding: '4px 10px',
        whiteSpace: 'nowrap',
      }}
    >
      <AlertTriangle size={12} strokeWidth={2.25} />
      {children}
    </span>
  );
}

/** One originating-IP entry — mono chip, dark admin idiom. */
function IpChip({ ip }: { ip: string }) {
  return (
    <span
      style={{
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: '0.76rem',
        color: '#93c5fd',
        background: 'rgba(59,130,246,0.08)',
        border: '1px solid rgba(59,130,246,0.22)',
        borderRadius: 6,
        padding: '3px 9px',
        whiteSpace: 'nowrap',
      }}
    >
      {ip}
    </span>
  );
}

function KycSection({ kyc }: { kyc: KycRecord | null }) {
  if (!kyc) {
    return (
      <div>
        <div style={sectionLabel}>KYC — Business Verification</div>
        <div style={{ fontSize: '0.82rem', color: '#4a5568', fontStyle: 'italic' }}>
          No KYC data (pre-KYC submission).
        </div>
      </div>
    );
  }

  const s = kyc.standard;
  const hv = kyc.high_volume;
  const govIdLabel = GOV_ID_TYPE_LABELS[s.gov_id_type] ?? s.gov_id_type;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ ...sectionLabel, marginBottom: 0 }}>
          KYC — Business Verification
        </div>
        {s.address_is_registered_agent_or_virtual && (
          <WarningChip>Registered agent / virtual office address</WarningChip>
        )}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
          gap: '12px 24px',
          marginTop: 12,
        }}
      >
        <InfoPair label="Legal Business Name" value={s.legal_business_name} />
        <div>
          <span style={fieldLabel}>Physical Address</span>
          <span style={fieldValue}>
            {s.address_line1}
            {s.address_line2 ? `, ${s.address_line2}` : ''}
            <br />
            {s.city}, {s.state} {s.postal_code}
          </span>
        </div>
        <div>
          <span style={fieldLabel}>Government ID</span>
          <span style={fieldValue}>
            {govIdLabel}
            <br />
            <span
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: '0.8rem',
                color: '#cbd5e1',
              }}
            >
              {s.gov_id_number}
            </span>
          </span>
        </div>
        {s.state_of_registration && (
          <InfoPair label="State of Registration" value={s.state_of_registration} />
        )}
        <InfoPair
          label="Alternate Phone"
          value={s.alternate_phone ? fmt(s.alternate_phone) : null}
        />
        <div>
          <span style={fieldLabel}>Website</span>
          {s.website ? (
            <a
              href={/^https?:\/\//i.test(s.website) ? s.website : `https://${s.website}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ ...fieldValue, color: '#60a5fa', textDecoration: 'none' }}
            >
              {s.website}
            </a>
          ) : (
            <span style={fieldValue}>—</span>
          )}
        </div>
      </div>

      {hv && (
        <div
          style={{
            marginTop: 16,
            padding: '14px 16px',
            borderRadius: 10,
            background: 'rgba(59,130,246,0.05)',
            border: '1px solid rgba(59,130,246,0.18)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div style={{ ...sectionLabel, marginBottom: 0 }}>High-Volume Calling</div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
              gap: '12px 24px',
            }}
          >
            <InfoPair
              label="Intended Use"
              value={INTENDED_USE_LABELS[hv.intended_use] ?? hv.intended_use}
            />
            <InfoPair
              label="Expected Daily Calls"
              value={
                hv.expected_daily_calls != null
                  ? hv.expected_daily_calls.toLocaleString('en-US')
                  : null
              }
            />
          </div>
          {hv.intended_use_description && (
            <div>
              <span style={fieldLabel}>Use Description</span>
              <p style={{ ...fieldValue, fontSize: '0.82rem', margin: 0, lineHeight: 1.55 }}>
                {hv.intended_use_description}
              </p>
            </div>
          )}
          <div>
            <span style={fieldLabel}>Originating IPs ({hv.originating_ips.length})</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
              {hv.originating_ips.map((ip) => (
                <IpChip key={ip} ip={ip} />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Complete Form ────────────────────────────────────────────────────────────

interface CompleteFormProps {
  request: OnboardingRequest;
}

function CompleteForm({ request }: CompleteFormProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [notes, setNotes] = useState('');
  const [showForm, setShowForm] = useState(false);

  const mutation = useMutation({
    mutationFn: () => completeOnboarding(request.id, notes.trim() || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['onboarding-requests'] });
      toastOk('Intake marked completed');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  if (!showForm) {
    return (
      <Button variant="success" size="sm" onClick={() => setShowForm(true)}>
        Complete
      </Button>
    );
  }

  return (
    <div
      style={{
        padding: '16px 18px',
        borderRadius: 10,
        background: 'rgba(34,197,94,0.05)',
        border: '1px solid rgba(34,197,94,0.2)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ ...sectionLabel, color: '#4ade80' }}>Complete Intake</div>
      <div>
        <label style={fieldLabel}>Notes (optional)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Handed off to billing/provisioning, account set up externally…"
          style={textareaStyle}
        />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          variant="success"
          size="sm"
          loading={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Mark Completed
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setShowForm(false); setNotes(''); }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ─── Reject Form ──────────────────────────────────────────────────────────────

interface RejectFormProps {
  request: OnboardingRequest;
}

function RejectForm({ request }: RejectFormProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [reason, setReason] = useState('');
  const [showForm, setShowForm] = useState(false);

  const mutation = useMutation({
    mutationFn: () => rejectOnboarding(request.id, reason.trim() || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['onboarding-requests'] });
      toastOk('Request rejected');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  if (!showForm) {
    return (
      <Button
        variant="danger"
        size="sm"
        onClick={() => setShowForm(true)}
      >
        Reject
      </Button>
    );
  }

  return (
    <div
      style={{
        padding: '16px 18px',
        borderRadius: 10,
        background: 'rgba(239,68,68,0.04)',
        border: '1px solid rgba(239,68,68,0.18)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ ...sectionLabel, color: '#f87171' }}>Reject Request</div>
      <div>
        <label style={fieldLabel}>Reason (optional)</label>
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Not a fit, unable to serve area, duplicate request…"
          style={textareaStyle}
        />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          variant="danger"
          size="sm"
          loading={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          Confirm Reject
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => { setShowForm(false); setReason(''); }}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

// ─── Completed / Rejected detail ──────────────────────────────────────────────

function CompletedDetail({ request }: { request: OnboardingRequest }) {
  return (
    <div
      style={{
        padding: '16px 18px',
        borderRadius: 10,
        background: 'rgba(34,197,94,0.06)',
        border: '1px solid rgba(34,197,94,0.18)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ ...sectionLabel, color: '#4ade80' }}>Completion Details</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px' }}>
        {request.completed_by_name && (
          <InfoPair label="Completed By" value={request.completed_by_name} />
        )}
        {request.completed_at && (
          <InfoPair label="Completed At" value={fmtDateTime(request.completed_at)} />
        )}
      </div>
      {request.admin_notes && (
        <div>
          <span style={fieldLabel}>Notes</span>
          <p style={{ ...fieldValue, fontSize: '0.82rem', margin: 0, color: '#a7f3d0', lineHeight: 1.55 }}>
            {request.admin_notes}
          </p>
        </div>
      )}
    </div>
  );
}

function RejectedDetail({ request }: { request: OnboardingRequest }) {
  return (
    <div
      style={{
        padding: '16px 18px',
        borderRadius: 10,
        background: 'rgba(239,68,68,0.05)',
        border: '1px solid rgba(239,68,68,0.18)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ ...sectionLabel, color: '#f87171' }}>Rejection Details</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px' }}>
        {request.rejected_by_name && (
          <InfoPair label="Rejected By" value={request.rejected_by_name} />
        )}
        {request.rejected_at && (
          <InfoPair label="Rejected At" value={fmtDateTime(request.rejected_at)} />
        )}
      </div>
      {request.rejection_reason && (
        <div>
          <span style={fieldLabel}>Reason</span>
          <p style={{ ...fieldValue, fontSize: '0.82rem', margin: 0, color: '#fca5a5', lineHeight: 1.55 }}>
            {request.rejection_reason}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Onboarding Card ──────────────────────────────────────────────────────────

interface OnboardingCardProps {
  request: OnboardingRequest;
  isExpanded: boolean;
  onToggle: () => void;
}

function OnboardingCard({ request, isExpanded, onToggle }: OnboardingCardProps) {
  const isPending   = request.status === 'pending';
  const isCompleted = request.status === 'completed';
  const isRejected  = request.status === 'rejected';

  return (
    <div
      className="glass-surface"
      style={{
        borderRadius: 14,
        overflow: 'hidden',
        transition: 'box-shadow 0.15s',
        boxShadow: isExpanded ? '0 0 0 1px rgba(59,130,246,0.35), 0 8px 28px -8px rgba(59,130,246,0.25)' : undefined,
      }}
    >
      {/* Summary row */}
      <div
        onClick={onToggle}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 20,
          padding: '16px 20px',
          cursor: 'pointer',
          userSelect: 'none',
        }}
      >
        {/* Expand chevron */}
        <span
          style={{
            color: '#475569',
            fontSize: '0.75rem',
            transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 0.15s',
            flexShrink: 0,
          }}
        >
          ▶
        </span>

        {/* Company + contact */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span
              style={{
                fontSize: '0.9rem',
                fontWeight: 700,
                color: '#e2e8f0',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {request.company_name}
            </span>
            {request.kyc?.high_volume && (
              <span
                style={{
                  flexShrink: 0,
                  fontSize: '0.58rem',
                  fontWeight: 700,
                  letterSpacing: '0.05em',
                  textTransform: 'uppercase',
                  color: '#93c5fd',
                  background: 'rgba(59,130,246,0.12)',
                  border: '1px solid rgba(59,130,246,0.3)',
                  borderRadius: 4,
                  padding: '2px 6px',
                }}
              >
                High volume
              </span>
            )}
          </div>
          <div style={{ fontSize: '0.75rem', color: '#718096', marginTop: 2 }}>
            {request.contact_name} · {request.email}
          </div>
        </div>

        {/* Product chips (legacy rows: dimmed implicit RCF) */}
        <div
          style={{
            width: 150,
            flexShrink: 0,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 4,
            alignItems: 'center',
          }}
        >
          {request.products ? (
            PRODUCT_ORDER.filter((p) =>
              request.products!.selected.includes(p),
            ).map((p) => <ProductChip key={p} product={p} />)
          ) : (
            <ProductChip product="rcf" dim />
          )}
        </div>

        {/* Timeline */}
        <div
          style={{
            fontSize: '0.75rem',
            color: '#718096',
            flexShrink: 0,
            maxWidth: 120,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {request.timeline}
        </div>

        {/* Status badge */}
        <div style={{ flexShrink: 0 }}>
          <Badge variant={statusBadgeVariant(request.status)}>
            {statusLabel(request.status)}
          </Badge>
        </div>

        {/* Submitted date */}
        <div style={{ fontSize: '0.72rem', color: '#4a5568', flexShrink: 0 }}>
          {fmtDate(request.created_at)}
        </div>
      </div>

      {/* Detail panel */}
      {isExpanded && (
        <div
          style={{
            padding: '0 20px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 24,
            borderTop: '1px solid rgba(59,130,246,0.12)',
            paddingTop: 20,
          }}
        >
          {/* Contact Info */}
          <div>
            <div style={sectionLabel}>Contact Information</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px 24px' }}>
              <InfoPair label="Company" value={request.company_name} />
              <InfoPair label="Contact Name" value={request.contact_name} />
              <InfoPair label="Email" value={request.email} />
              <InfoPair label="Phone" value={request.phone ? fmt(request.phone) : null} />
            </div>
          </div>

          {/* Products & requirements (legacy top-level RCF fields when products is null) */}
          <RequirementsSection request={request} />

          {/* KYC — Business verification (null on legacy pre-KYC rows) */}
          <KycSection kyc={request.kyc} />

          {/* Submission meta */}
          <div>
            <div style={sectionLabel}>Submission</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px 24px' }}>
              <InfoPair label="Submitted" value={fmtDateTime(request.created_at)} />
            </div>
          </div>

          {/* Action / status sections */}
          {isPending && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                <CompleteForm request={request} />
                <RejectForm request={request} />
              </div>
            </div>
          )}

          {isCompleted && <CompletedDetail request={request} />}
          {isRejected && <RejectedDetail request={request} />}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function OnboardingAdminPage() {
  // ALL hooks unconditionally at the top — React rules-of-hooks
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['onboarding-requests', { status: activeFilter }],
    queryFn: () =>
      listOnboardingRequests(
        activeFilter === 'all' ? {} : { status: activeFilter },
      ),
  });

  const items: OnboardingRequest[] = data?.items ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Status filter tabs */}
      <div
        className="glass-surface"
        style={{
          borderRadius: 12,
          padding: '6px 8px',
          overflowX: 'auto',
        }}
      >
        <nav
          style={{ display: 'flex', gap: 4 }}
          role="tablist"
          aria-label="Onboarding request filter"
        >
          {STATUS_TABS.map((tab) => {
            const isActive = activeFilter === tab.value;
            return (
              <button
                key={tab.value}
                role="tab"
                aria-selected={isActive}
                onClick={() => {
                  setActiveFilter(tab.value);
                  setExpandedId(null);
                }}
                style={{
                  padding: '7px 16px',
                  fontSize: '0.83rem',
                  fontWeight: isActive ? 600 : 500,
                  whiteSpace: 'nowrap',
                  borderRadius: 8,
                  border: isActive ? '1px solid rgba(59,130,246,0.4)' : '1px solid transparent',
                  color: isActive ? '#e2e8f0' : '#718096',
                  background: isActive
                    ? 'linear-gradient(135deg, rgba(59,130,246,0.13) 0%, rgba(59,130,246,0.06) 100%)'
                    : 'transparent',
                  cursor: 'pointer',
                  transition: 'color 0.15s, background 0.15s, border-color 0.15s',
                  boxShadow: isActive ? '0 0 10px rgba(59,130,246,0.14)' : 'none',
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: '#718096',
            fontSize: '0.875rem',
            padding: '32px 0',
          }}
        >
          <Spinner /> Loading onboarding requests…
        </div>
      )}

      {/* Error state */}
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
          Failed to load onboarding requests.
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && items.length === 0 && (
        <div
          className="glass-surface"
          style={{
            padding: '60px 20px',
            textAlign: 'center',
            color: '#4a5568',
            fontSize: '0.9rem',
            borderRadius: 14,
          }}
        >
          No onboarding requests
          {activeFilter !== 'all' ? ` with status "${statusLabel(activeFilter as OnboardingStatus)}"` : ''}.
        </div>
      )}

      {/* Request list */}
      {!isLoading && items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {/* Column headers */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 20,
              padding: '0 20px',
            }}
          >
            <div style={{ width: 16, flexShrink: 0 }} />
            <div style={{ flex: 1, fontSize: '0.65rem', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Company / Contact
            </div>
            <div style={{ width: 150, fontSize: '0.65rem', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Products
            </div>
            <div style={{ width: 120, fontSize: '0.65rem', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Timeline
            </div>
            <div style={{ width: 120, fontSize: '0.65rem', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Status
            </div>
            <div style={{ width: 90, fontSize: '0.65rem', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Submitted
            </div>
          </div>

          {items.map((req) => (
            <OnboardingCard
              key={req.id}
              request={req}
              isExpanded={expandedId === req.id}
              onToggle={() => setExpandedId((prev) => (prev === req.id ? null : req.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
