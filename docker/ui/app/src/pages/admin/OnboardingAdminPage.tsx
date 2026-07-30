import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listOnboardingRequests,
  completeOnboarding,
  rejectOnboarding,
} from '../../api/onboarding';
import type {
  OnboardingRequest,
  OnboardingStatus,
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
              onToggle={() => setExpandedId((prev) => (prev === req.id ? null : req.id))}
            />
          ))}
        </div>
      )}
    </div>
  );
}
