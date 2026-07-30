import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listOnboardingRequests,
  verifyBilling,
  approveOnboarding,
  rejectOnboarding,
} from '../../api/onboarding';
import { listAvailableDids } from '../../api/didInventory';
import type {
  OnboardingRequest,
  OnboardingStatus,
  ApprovePayload,
  ApproveResponse,
  DIDConfigEntry,
} from '../../types/onboarding';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
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
  { label: 'All',              value: 'all'              },
  { label: 'Pending',          value: 'pending'          },
  { label: 'Billing Verified', value: 'billing_verified' },
  { label: 'Provisioning',     value: 'provisioning'     },
  { label: 'Active',           value: 'active'           },
  { label: 'Rejected',         value: 'rejected'         },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusBadgeVariant(status: OnboardingStatus) {
  switch (status) {
    case 'pending':          return 'pending'          as const;
    case 'billing_verified': return 'billing_verified' as const;
    case 'provisioning':     return 'provisioning'     as const;
    case 'active':           return 'active'           as const;
    case 'approved':         return 'billing_verified' as const;
    case 'rejected':         return 'rejected'         as const;
  }
}

function statusLabel(status: OnboardingStatus): string {
  switch (status) {
    case 'pending':          return 'Pending';
    case 'billing_verified': return 'Billing Verified';
    case 'provisioning':     return 'Provisioning';
    case 'active':           return 'Active';
    case 'approved':         return 'Approved';
    case 'rejected':         return 'Rejected';
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

// ─── Credentials Modal ────────────────────────────────────────────────────────

interface CredentialsModalProps {
  result: ApproveResponse;
  onClose: () => void;
}

function CredentialsModal({ result, onClose }: CredentialsModalProps) {
  const [copied, setCopied] = useState(false);
  const { toastOk } = useToast();

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(result.user.temp_password).then(() => {
      setCopied(true);
      toastOk('Password copied to clipboard');
      setTimeout(() => setCopied(false), 2500);
    });
  }, [result.user.temp_password, toastOk]);

  return (
    <Modal
      open
      onClose={onClose}
      title="Account Provisioned"
      maxWidth="max-w-md"
      footer={
        <Button variant="primary" size="sm" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Success banner */}
        <div
          style={{
            padding: '14px 16px',
            borderRadius: 10,
            background: 'rgba(34,197,94,0.08)',
            border: '1px solid rgba(34,197,94,0.2)',
            color: '#4ade80',
            fontSize: '0.82rem',
            lineHeight: 1.55,
          }}
        >
          Customer <strong style={{ color: '#86efac' }}>{result.customer.name}</strong> has been
          provisioned with {result.dids.length} DID{result.dids.length !== 1 ? 's' : ''}.
        </div>

        {/* Credentials block */}
        <div
          style={{
            background: 'rgba(13,15,21,0.7)',
            border: '1px solid rgba(42,47,69,0.7)',
            borderRadius: 10,
            padding: '16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <div>
            <span style={fieldLabel}>Login Email</span>
            <span style={{ ...fieldValue, fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', fontSize: '0.85rem' }}>
              {result.user.email}
            </span>
          </div>

          <div>
            <span style={fieldLabel}>Temporary Password</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <code
                style={{
                  flex: 1,
                  padding: '8px 12px',
                  borderRadius: 7,
                  background: 'rgba(59,130,246,0.08)',
                  border: '1px solid rgba(59,130,246,0.2)',
                  color: '#93c5fd',
                  fontSize: '0.9rem',
                  letterSpacing: '0.04em',
                  fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
                  wordBreak: 'break-all',
                }}
              >
                {result.user.temp_password}
              </code>
              <Button
                variant="ghost"
                size="xs"
                onClick={handleCopy}
                style={{ flexShrink: 0 }}
              >
                {copied ? 'Copied!' : 'Copy'}
              </Button>
            </div>
          </div>
        </div>

        {/* Warning */}
        <div
          style={{
            padding: '10px 14px',
            borderRadius: 8,
            background: 'rgba(245,158,11,0.08)',
            border: '1px solid rgba(245,158,11,0.2)',
            color: '#fbbf24',
            fontSize: '0.78rem',
            lineHeight: 1.5,
          }}
        >
          This temporary password will not be shown again. Send it to the customer securely.
        </div>

        {/* Provisioned DIDs list */}
        {result.dids.length > 0 && (
          <div>
            <div style={sectionLabel}>Provisioned DIDs</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {result.dids.map((d) => (
                <div
                  key={d.did}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '7px 12px',
                    borderRadius: 7,
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(42,47,69,0.5)',
                  }}
                >
                  <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', fontSize: '0.82rem', color: '#cbd5e0' }}>
                    {fmt(d.did)}
                  </span>
                  <span style={{ fontSize: '0.75rem', color: '#718096' }}>
                    → {fmt(d.forward_to)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

// ─── Billing Verify Form ──────────────────────────────────────────────────────

interface BillingVerifyFormProps {
  request: OnboardingRequest;
  onSuccess: () => void;
}

function BillingVerifyForm({ request, onSuccess }: BillingVerifyFormProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [notes, setNotes] = useState('');

  const mutation = useMutation({
    mutationFn: () => verifyBilling(request.id, notes.trim() || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['onboarding-requests'] });
      toastOk('Billing verified');
      onSuccess();
    },
    onError: (err: Error) => toastErr(err.message),
  });

  return (
    <div
      style={{
        padding: '16px 18px',
        borderRadius: 10,
        background: 'rgba(59,130,246,0.04)',
        border: '1px solid rgba(59,130,246,0.18)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div style={{ ...sectionLabel, color: '#60a5fa' }}>Verify Billing</div>
      <div>
        <label style={fieldLabel}>Notes (optional)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Credit check passed, billing address confirmed…"
          style={textareaStyle}
        />
      </div>
      <Button
        variant="success"
        size="sm"
        loading={mutation.isPending}
        onClick={() => mutation.mutate()}
        style={{ alignSelf: 'flex-start' }}
      >
        Mark Billing Verified
      </Button>
    </div>
  );
}

// ─── Reject Form ──────────────────────────────────────────────────────────────

interface RejectFormProps {
  request: OnboardingRequest;
  onSuccess: () => void;
}

function RejectForm({ request, onSuccess }: RejectFormProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [reason, setReason] = useState('');
  const [showForm, setShowForm] = useState(false);

  const mutation = useMutation({
    mutationFn: () => rejectOnboarding(request.id, reason.trim() || undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['onboarding-requests'] });
      toastOk('Request rejected');
      onSuccess();
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
          placeholder="Unable to verify billing, service area not covered…"
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

// ─── Provisioning Form ────────────────────────────────────────────────────────

interface ProvisioningFormProps {
  request: OnboardingRequest;
  onApproved: (result: ApproveResponse) => void;
}

function ProvisioningForm({ request, onApproved }: ProvisioningFormProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [selectedDids, setSelectedDids] = useState<string[]>([]);
  const [forwardMap, setForwardMap] = useState<Record<string, string>>({});
  const [adminNotes, setAdminNotes] = useState('');
  const [didSearch, setDidSearch] = useState('');

  const { data: availableDids, isLoading: didsLoading } = useQuery({
    queryKey: ['available-dids'],
    queryFn: () => listAvailableDids({ limit: 500 }),
  });

  const mutation = useMutation({
    mutationFn: () => {
      const dids: DIDConfigEntry[] = selectedDids.map((did) => ({
        did,
        forward_to: forwardMap[did] ?? '',
      }));
      const payload: ApprovePayload = {
        dids,
        admin_notes: adminNotes.trim() || undefined,
      };
      return approveOnboarding(request.id, payload);
    },
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['onboarding-requests'] });
      toastOk(`Approved — customer ${result.customer.name} provisioned`);
      onApproved(result);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function toggleDid(did: string) {
    setSelectedDids((prev) =>
      prev.includes(did) ? prev.filter((d) => d !== did) : [...prev, did],
    );
  }

  function setForward(did: string, value: string) {
    setForwardMap((prev) => ({ ...prev, [did]: value }));
  }

  const filtered = (availableDids ?? []).filter((d) =>
    !didSearch || d.did.includes(didSearch) || d.city?.toLowerCase().includes(didSearch.toLowerCase()),
  );

  const allForwardsFilled = selectedDids.length > 0
    && selectedDids.every((d) => (forwardMap[d] ?? '').trim().length >= 10);

  const requestedCount = parseInt(request.did_count, 10) || 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div
        style={{
          padding: '16px 18px',
          borderRadius: 10,
          background: 'rgba(34,197,94,0.05)',
          border: '1px solid rgba(34,197,94,0.2)',
        }}
      >
        <div style={{ ...sectionLabel, color: '#60a5fa', marginBottom: 8 }}>Configure & Approve</div>
        <p style={{ fontSize: '0.82rem', color: '#718096', margin: 0 }}>
          Customer requested <strong style={{ color: '#cbd5e0' }}>{requestedCount}</strong> DID
          {requestedCount !== 1 ? 's' : ''}.
          Select DIDs from inventory and set forwarding numbers.
        </p>
      </div>

      {/* DID selector */}
      <div>
        <div style={sectionLabel}>Available DIDs</div>

        <input
          type="search"
          value={didSearch}
          onChange={(e) => setDidSearch(e.target.value)}
          placeholder="Filter by number or city…"
          style={{ ...inputStyle, marginBottom: 10 }}
        />

        {didsLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#718096', fontSize: '0.82rem', padding: '12px 0' }}>
            <Spinner size="xs" /> Loading available DIDs…
          </div>
        ) : (
          <div
            style={{
              maxHeight: 220,
              overflowY: 'auto',
              border: '1px solid rgba(59,130,246,0.12)',
              borderRadius: 9,
              background: 'rgba(13,15,21,0.5)',
            }}
          >
            {filtered.length === 0 ? (
              <div style={{ padding: '20px', textAlign: 'center', color: '#4a5568', fontSize: '0.82rem' }}>
                No available DIDs match your filter.
              </div>
            ) : (
              filtered.map((d) => {
                const isSelected = selectedDids.includes(d.did);
                return (
                  <div
                    key={d.did}
                    onClick={() => toggleDid(d.did)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '9px 14px',
                      cursor: 'pointer',
                      background: isSelected ? 'rgba(59,130,246,0.08)' : 'transparent',
                      borderBottom: '1px solid rgba(42,47,69,0.4)',
                      transition: 'background 0.1s',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleDid(d.did)}
                      onClick={(e) => e.stopPropagation()}
                      style={{ accentColor: '#3b82f6', width: 14, height: 14, flexShrink: 0 }}
                    />
                    <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', fontSize: '0.83rem', color: '#cbd5e0', flex: 1 }}>
                      {fmt(d.did)}
                    </span>
                    {(d.city || d.state) && (
                      <span style={{ fontSize: '0.72rem', color: '#4a5568' }}>
                        {[d.city, d.state].filter(Boolean).join(', ')}
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {selectedDids.length > 0 && (
          <div style={{ marginTop: 6, fontSize: '0.75rem', color: '#60a5fa' }}>
            {selectedDids.length} DID{selectedDids.length !== 1 ? 's' : ''} selected
          </div>
        )}
      </div>

      {/* Forward-to inputs for each selected DID */}
      {selectedDids.length > 0 && (
        <div>
          <div style={sectionLabel}>Forwarding Numbers</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {selectedDids.map((did) => (
              <div key={did} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span
                  style={{
                    fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
                    fontSize: '0.8rem',
                    color: '#94a3b8',
                    minWidth: 160,
                    flexShrink: 0,
                  }}
                >
                  {fmt(did)}
                </span>
                <span style={{ color: '#3b82f6', flexShrink: 0 }}>→</span>
                <input
                  type="tel"
                  value={forwardMap[did] ?? ''}
                  onChange={(e) => setForward(did, e.target.value)}
                  placeholder="+1 (617) 555-0100"
                  style={{ ...inputStyle, flex: 1 }}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Admin notes */}
      <div>
        <label style={fieldLabel}>Admin Notes (optional)</label>
        <textarea
          value={adminNotes}
          onChange={(e) => setAdminNotes(e.target.value)}
          placeholder="Any notes about this account or provisioning setup…"
          style={textareaStyle}
        />
      </div>

      {/* Approve button */}
      <Button
        variant="primary"
        size="default"
        loading={mutation.isPending}
        disabled={!allForwardsFilled}
        onClick={() => mutation.mutate()}
        style={{
          alignSelf: 'flex-start',
          boxShadow: allForwardsFilled ? '0 0 20px rgba(59,130,246,0.35)' : 'none',
        }}
      >
        Approve & Provision
      </Button>

      {selectedDids.length > 0 && !allForwardsFilled && (
        <p style={{ fontSize: '0.75rem', color: '#f59e0b', margin: '-12px 0 0' }}>
          All selected DIDs need a forwarding number before approving.
        </p>
      )}
    </div>
  );
}

// ─── Active / Rejected detail ─────────────────────────────────────────────────

function ActiveDetail({ request }: { request: OnboardingRequest }) {
  const config = request.provisioning_config ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        style={{
          padding: '14px 18px',
          borderRadius: 10,
          background: 'rgba(34,197,94,0.06)',
          border: '1px solid rgba(34,197,94,0.18)',
        }}
      >
        <div style={{ ...sectionLabel, color: '#4ade80', marginBottom: 10 }}>Provisioned Account</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px 24px' }}>
          {request.customer_id && (
            <InfoPair label="Customer ID" value={String(request.customer_id)} />
          )}
          {request.reviewed_by_name && (
            <InfoPair label="Approved By" value={request.reviewed_by_name} />
          )}
          {request.reviewed_at && (
            <InfoPair label="Approved At" value={fmtDateTime(request.reviewed_at)} />
          )}
          {request.admin_notes && (
            <div style={{ gridColumn: '1 / -1' }}>
              <InfoPair label="Admin Notes" value={request.admin_notes} />
            </div>
          )}
        </div>
      </div>

      {config.length > 0 && (
        <div>
          <div style={sectionLabel}>Provisioned DIDs</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {config.map((d) => (
              <div
                key={d.did}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '8px 14px',
                  borderRadius: 8,
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(42,47,69,0.5)',
                }}
              >
                <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', fontSize: '0.83rem', color: '#cbd5e0' }}>
                  {fmt(d.did)}
                </span>
                <span style={{ fontSize: '0.78rem', color: '#718096' }}>
                  → {fmt(d.forward_to)}
                </span>
              </div>
            ))}
          </div>
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
        {request.rejected_by && request.reviewed_by_name && (
          <InfoPair label="Rejected By" value={request.reviewed_by_name} />
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
  onApproved: (result: ApproveResponse) => void;
}

function OnboardingCard({ request, isExpanded, onToggle, onApproved }: OnboardingCardProps) {
  const isPending         = request.status === 'pending';
  const isBillingVerified = request.status === 'billing_verified';
  const isActive          = request.status === 'active';
  const isRejected        = request.status === 'rejected';

  function handleVerifySuccess() {
    // Card will re-render from query invalidation
  }

  function handleRejectSuccess() {
    // Card will re-render from query invalidation
  }

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
          <div
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
          </div>
          <div style={{ fontSize: '0.75rem', color: '#718096', marginTop: 2 }}>
            {request.contact_name} · {request.email}
          </div>
        </div>

        {/* DID count */}
        <div style={{ textAlign: 'center', flexShrink: 0 }}>
          <div style={{ fontSize: '1rem', fontWeight: 700, color: '#3b82f6' }}>
            {request.did_count}
          </div>
          <div style={{ fontSize: '0.65rem', color: '#4a5568', textTransform: 'uppercase' }}>DIDs</div>
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

          {/* RCF Requirements */}
          <div>
            <div style={sectionLabel}>RCF Requirements</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: '12px 24px' }}>
              <InfoPair label="DIDs Requested" value={request.did_count} />
              <InfoPair label="Porting Existing Numbers?" value={request.porting} />
              <InfoPair label="Current Carrier" value={request.current_carrier} />
              <InfoPair label="Forwarding Setup" value={request.forwarding_setup} />
              <InfoPair label="Monthly Volume" value={request.monthly_volume} />
              <InfoPair label="Timeline" value={request.timeline} />
            </div>
          </div>

          {/* Billing verified metadata (show when past pending) */}
          {(isBillingVerified || isActive) && request.billing_verified_by_name && (
            <div
              style={{
                padding: '12px 16px',
                borderRadius: 9,
                background: 'rgba(59,130,246,0.05)',
                border: '1px solid rgba(59,130,246,0.15)',
              }}
            >
              <div style={{ fontSize: '0.72rem', color: '#60a5fa', fontWeight: 600, marginBottom: 8 }}>
                BILLING VERIFICATION
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px 24px' }}>
                <InfoPair label="Verified By" value={request.billing_verified_by_name} />
                {request.billing_verified_at && (
                  <InfoPair label="Verified At" value={fmtDateTime(request.billing_verified_at)} />
                )}
                {request.billing_notes && (
                  <div style={{ gridColumn: '1 / -1' }}>
                    <InfoPair label="Billing Notes" value={request.billing_notes} />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Action sections */}
          {isPending && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <BillingVerifyForm request={request} onSuccess={handleVerifySuccess} />
              <RejectForm request={request} onSuccess={handleRejectSuccess} />
            </div>
          )}

          {isBillingVerified && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <ProvisioningForm request={request} onApproved={onApproved} />
              <div style={{ borderTop: '1px solid rgba(59,130,246,0.12)', paddingTop: 16 }}>
                <RejectForm request={request} onSuccess={handleRejectSuccess} />
              </div>
            </div>
          )}

          {isActive && <ActiveDetail request={request} />}
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
  const [credentials, setCredentials] = useState<ApproveResponse | null>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['onboarding-requests', { status: activeFilter }],
    queryFn: () =>
      listOnboardingRequests(
        activeFilter === 'all' ? {} : { status: activeFilter },
      ),
  });

  // Handlers — defined unconditionally
  const handleToggle = useCallback((id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleApproved = useCallback((result: ApproveResponse) => {
    setCredentials(result);
  }, []);

  const handleCredentialsDone = useCallback(() => {
    setCredentials(null);
  }, []);

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
            <div style={{ width: 52, textAlign: 'center', fontSize: '0.65rem', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              DIDs
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
              onToggle={() => handleToggle(req.id)}
              onApproved={handleApproved}
            />
          ))}
        </div>
      )}

      {/* Credentials modal — shown after a successful approval */}
      {credentials && (
        <CredentialsModal result={credentials} onClose={handleCredentialsDone} />
      )}
    </div>
  );
}
