/**
 * OnboardingAdminPage — the customer onboarding intake queue
 * (/admin/onboarding).
 *
 * Queue rows expand into a detail panel: Contact / Products & Requirements /
 * KYC — Business Verification (FCC 26-27) / Submission, plus the
 * Complete / Reject action flows for pending rows.
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * page-scoped `dlx-*` primitives in styles/dl-admin.css). Renders INSIDE the
 * AdminPage shell, which owns the paper canvas (`dl-scope`) — this page
 * contributes the status filter, the queue table panel, and the detail views.
 * The amber warning chip is reserved for genuine KYC red flags.
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, Download, Eye } from 'lucide-react';
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
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import { fmt } from '../../utils/format';
import '../../styles/dl-admin.css';

const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';
const COL_COUNT = 6;

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

function statusLabel(status: OnboardingStatus): string {
  switch (status) {
    case 'pending':   return 'Pending';
    case 'completed': return 'Completed';
    case 'rejected':  return 'Rejected';
  }
}

/** Green = completed, red = rejected, azure tag = awaiting review. */
function StatusPill({ status }: { status: OnboardingStatus }) {
  switch (status) {
    case 'completed':
      return <span className="dl-pill dl-pill-on">Completed</span>;
    case 'rejected':
      return <span className="dl-pill dl-pill-off">Rejected</span>;
    case 'pending':
      return <span className="dl-tag">Pending</span>;
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

// ─── Info pair (read-only display field) ──────────────────────────────────────

function InfoPair({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <span className="dlx-ilabel">{label}</span>
      <span className="dlx-ivalue">{value || '—'}</span>
    </div>
  );
}

// ─── Products (products-v1) ───────────────────────────────────────────────────

/** Small product chip — summary rows + detail header. `dim` marks the
    implicit RCF chip on legacy (pre-products) requests. */
function ProductChip({ product, dim }: { product: ProductKey; dim?: boolean }) {
  return (
    <span className={dim ? 'dl-tag dl-tag-slate' : 'dl-tag'}>
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
    <div className="dlx-well">
      <h4 className="dl-section-title" style={{ marginBottom: 0 }}>
        {PRODUCT_LABELS[product]}
      </h4>
      {children}
    </div>
  );
}

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
        <h3 className="dl-section-title">Requirements — Legacy RCF Intake</h3>
        <div className="dlx-info-grid">
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
        <h3 className="dl-section-title" style={{ marginBottom: 0 }}>
          Products &amp; Requirements
        </h3>
        {selected.map((p) => (
          <ProductChip key={p} product={p} />
        ))}
      </div>

      {/* Global sizing */}
      <div className="dlx-info-grid" style={{ marginTop: 14 }}>
        <InfoPair label="Monthly Volume" value={request.monthly_volume} />
        <InfoPair label="Timeline" value={request.timeline} />
      </div>

      {/* Per-product blocks, stable order */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 16 }}>
        {rcf && (
          <ProductBlock product="rcf">
            <div className="dlx-info-grid">
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
            <div className="dlx-info-grid">
              <InfoPair
                label="Concurrent Call Paths"
                value={trunk.concurrent_call_paths.toLocaleString('en-US')}
              />
              <InfoPair label="PBX Vendor" value={trunk.pbx_vendor} />
              <InfoPair label="DIDs Needed" value={trunk.dids_needed} />
            </div>
            <div>
              <span className="dlx-ilabel">
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
              <span className="dlx-ilabel">Use Case</span>
              <p className="dlx-ivalue" style={{ margin: 0, fontSize: '0.82rem', lineHeight: 1.55 }}>
                {api.use_case}
              </p>
            </div>
            <div className="dlx-info-grid">
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
                <span className="dlx-ilabel">Webhook URL</span>
                {api.webhook_url ? (
                  <span
                    className="dlx-ivalue"
                    style={{
                      fontFamily: MONO,
                      fontSize: '0.78rem',
                      color: 'var(--rcf-azure-deep)',
                      wordBreak: 'break-all',
                    }}
                  >
                    {api.webhook_url}
                  </span>
                ) : (
                  <span className="dlx-ivalue">—</span>
                )}
              </div>
            </div>
          </ProductBlock>
        )}

        {voicemail && (
          <ProductBlock product="voicemail">
            <div className="dlx-info-grid">
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

/** Amber warning chip — a GENUINE warning (KYC red flag), so amber stays. */
function WarningChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="dlx-warnchip">
      <AlertTriangle size={12} strokeWidth={2.25} />
      {children}
    </span>
  );
}

/** One originating-IP entry — mono daylight chip. */
function IpChip({ ip }: { ip: string }) {
  return (
    <span className="dl-chip" style={{ fontSize: '0.74rem', padding: '3px 9px' }}>
      {ip}
    </span>
  );
}

function KycSection({ kyc }: { kyc: KycRecord | null }) {
  if (!kyc) {
    return (
      <div>
        <h3 className="dl-section-title">KYC — Business Verification</h3>
        <div style={{ fontSize: '0.82rem', color: 'var(--rcf-ink-dim)', fontStyle: 'italic' }}>
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
        <h3 className="dl-section-title" style={{ marginBottom: 0 }}>
          KYC — Business Verification
        </h3>
        {s.address_is_registered_agent_or_virtual && (
          <WarningChip>Registered agent / virtual office address</WarningChip>
        )}
      </div>

      <div className="dlx-info-grid" style={{ marginTop: 14 }}>
        <InfoPair label="Legal Business Name" value={s.legal_business_name} />
        <div>
          <span className="dlx-ilabel">Physical Address</span>
          <span className="dlx-ivalue">
            {s.address_line1}
            {s.address_line2 ? `, ${s.address_line2}` : ''}
            <br />
            {s.city}, {s.state} {s.postal_code}
          </span>
        </div>
        <div>
          <span className="dlx-ilabel">Government ID</span>
          <span className="dlx-ivalue">
            {govIdLabel}
            <br />
            <span style={{ fontFamily: MONO, fontSize: '0.8rem', color: 'var(--rcf-ink-soft)' }}>
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
          <span className="dlx-ilabel">Website</span>
          {s.website ? (
            <a
              href={/^https?:\/\//i.test(s.website) ? s.website : `https://${s.website}`}
              target="_blank"
              rel="noopener noreferrer"
              className="dlx-ivalue"
              style={{ color: 'var(--rcf-azure-deep)', textDecoration: 'none', fontWeight: 600 }}
            >
              {s.website}
            </a>
          ) : (
            <span className="dlx-ivalue">—</span>
          )}
        </div>
      </div>

      {hv && (
        <div className="dlx-well" style={{ marginTop: 16 }}>
          <h4 className="dl-section-title" style={{ marginBottom: 0 }}>High-Volume Calling</h4>
          <div className="dlx-info-grid">
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
              <span className="dlx-ilabel">Use Description</span>
              <p className="dlx-ivalue" style={{ margin: 0, fontSize: '0.82rem', lineHeight: 1.55 }}>
                {hv.intended_use_description}
              </p>
            </div>
          )}
          <div>
            <span className="dlx-ilabel">Originating IPs ({hv.originating_ips.length})</span>
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
      <button type="button" className="dl-btn dlx-btn-ok" onClick={() => setShowForm(true)}>
        Complete
      </button>
    );
  }

  return (
    <div className="dlx-well dlx-well-ok">
      <h4 className="dl-section-title" style={{ marginBottom: 0, color: 'var(--rcf-green)' }}>
        Complete Intake
      </h4>
      <div>
        <label className="dl-flabel" htmlFor={`complete-notes-${request.id}`}>
          Notes (optional)
        </label>
        <textarea
          id={`complete-notes-${request.id}`}
          className="dl-input"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Handed off to billing/provisioning, account set up externally…"
          style={{ width: '100%', resize: 'vertical', minHeight: 72 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="dl-btn dlx-btn-ok"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Completing…' : 'Mark Completed'}
        </button>
        <button
          type="button"
          className="dl-btn dl-btn-ghost"
          onClick={() => { setShowForm(false); setNotes(''); }}
        >
          Cancel
        </button>
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
      <button type="button" className="dl-btn dl-btn-danger" onClick={() => setShowForm(true)}>
        Reject
      </button>
    );
  }

  return (
    <div className="dlx-well dlx-well-err">
      <h4 className="dl-section-title" style={{ marginBottom: 0, color: 'var(--rcf-red)' }}>
        Reject Request
      </h4>
      <div>
        <label className="dl-flabel" htmlFor={`reject-reason-${request.id}`}>
          Reason (optional)
        </label>
        <textarea
          id={`reject-reason-${request.id}`}
          className="dl-input"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Not a fit, unable to serve area, duplicate request…"
          style={{ width: '100%', resize: 'vertical', minHeight: 72 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          className="dl-btn dl-btn-danger"
          disabled={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? 'Rejecting…' : 'Confirm Reject'}
        </button>
        <button
          type="button"
          className="dl-btn dl-btn-ghost"
          onClick={() => { setShowForm(false); setReason(''); }}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─── Completed / Rejected detail ──────────────────────────────────────────────

function CompletedDetail({ request }: { request: OnboardingRequest }) {
  return (
    <div className="dlx-well dlx-well-ok">
      <h4 className="dl-section-title" style={{ marginBottom: 0, color: 'var(--rcf-green)' }}>
        Completion Details
      </h4>
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
          <span className="dlx-ilabel">Notes</span>
          <p className="dlx-ivalue" style={{ margin: 0, fontSize: '0.82rem', lineHeight: 1.55 }}>
            {request.admin_notes}
          </p>
        </div>
      )}
    </div>
  );
}

function RejectedDetail({ request }: { request: OnboardingRequest }) {
  return (
    <div className="dlx-well dlx-well-err">
      <h4 className="dl-section-title" style={{ marginBottom: 0, color: 'var(--rcf-red)' }}>
        Rejection Details
      </h4>
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
          <span className="dlx-ilabel">Reason</span>
          <p className="dlx-ivalue" style={{ margin: 0, fontSize: '0.82rem', lineHeight: 1.55 }}>
            {request.rejection_reason}
          </p>
        </div>
      )}
    </div>
  );
}

// ─── Queue row (+ expandable detail) ──────────────────────────────────────────

interface OnboardingRowProps {
  request: OnboardingRequest;
  isExpanded: boolean;
  onToggle: () => void;
}

function OnboardingRow({ request, isExpanded, onToggle }: OnboardingRowProps) {
  // ALL hooks unconditionally at the top — React rules-of-hooks
  const [downloading, setDownloading] = useState(false);
  const { toastErr } = useToast();

  const isPending   = request.status === 'pending';
  const isCompleted = request.status === 'completed';
  const isRejected  = request.status === 'rejected';

  /** Generates the SE brief client-side and downloads a real .pdf file. */
  const handleDownloadBrief = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      // Dynamic import keeps @react-pdf/renderer out of the main bundle.
      const { downloadBriefPdf } = await import('./onboardingBriefPdf');
      await downloadBriefPdf(request);
    } catch {
      toastErr('PDF generation failed — try again.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      {/* Summary row */}
      <tr
        className="dl-row"
        onClick={onToggle}
        style={{
          cursor: 'pointer',
          userSelect: 'none',
          background: isExpanded ? '#eef4fe' : undefined,
        }}
      >
        {/* Expand chevron */}
        <td className="dlx-td" style={{ width: 34, paddingRight: 0 }}>
          <ChevronRight
            size={15}
            strokeWidth={2}
            stroke="var(--rcf-ink-dim)"
            style={{
              display: 'block',
              transition: 'transform 0.15s ease',
              transform: isExpanded ? 'rotate(90deg)' : 'none',
            }}
            aria-hidden="true"
          />
        </td>

        {/* Company + contact */}
        <td className="dlx-td" style={{ whiteSpace: 'normal', minWidth: 220 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span
              style={{
                fontSize: '0.86rem',
                fontWeight: 700,
                color: 'var(--rcf-ink)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {request.company_name}
            </span>
            {request.kyc?.high_volume && (
              <span className="dl-tag" style={{ flexShrink: 0 }}>High volume</span>
            )}
          </div>
          <div style={{ fontSize: '0.74rem', color: 'var(--rcf-ink-dim)', marginTop: 2 }}>
            {request.contact_name} · {request.email}
          </div>
        </td>

        {/* Product chips (legacy rows: dimmed implicit RCF) */}
        <td className="dlx-td" style={{ whiteSpace: 'normal', width: 160 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
            {request.products ? (
              PRODUCT_ORDER.filter((p) =>
                request.products!.selected.includes(p),
              ).map((p) => <ProductChip key={p} product={p} />)
            ) : (
              <ProductChip product="rcf" dim />
            )}
          </div>
        </td>

        {/* Timeline */}
        <td
          className="dlx-td"
          style={{
            color: 'var(--rcf-ink-dim)',
            fontSize: '0.76rem',
            maxWidth: 130,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {request.timeline}
        </td>

        {/* Status */}
        <td className="dlx-td">
          <StatusPill status={request.status} />
        </td>

        {/* Submitted date */}
        <td className="dlx-td" style={{ color: 'var(--rcf-ink-dim)', fontSize: '0.74rem' }}>
          {fmtDate(request.created_at)}
        </td>
      </tr>

      {/* Detail panel */}
      {isExpanded && (
        <tr>
          <td colSpan={COL_COUNT} style={{ padding: 0 }}>
            <div className="dlx-xwrap">
              <div>
                <div className="dlx-xpanel">
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
                    {/* Detail header row — intake # + SE brief export */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: 12,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: MONO,
                          fontSize: '0.74rem',
                          fontWeight: 600,
                          color: 'var(--rcf-ink-dim)',
                        }}
                      >
                        Intake #{request.id}
                      </span>
                      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        <button
                          type="button"
                          className="dl-btn dl-btn-ghost dlx-btn-sm"
                          title="On-screen preview of the SE brief"
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            window.open(
                              `/admin/onboarding/print/${request.id}`,
                              '_blank',
                              'noopener',
                            );
                          }}
                        >
                          <Eye size={13} strokeWidth={2.25} />
                          Preview
                        </button>
                        <button
                          type="button"
                          className="dl-btn dl-btn-primary dlx-btn-sm"
                          title="Download the SE intake brief as a PDF"
                          disabled={downloading}
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
                          onClick={(e) => {
                            e.stopPropagation();
                            void handleDownloadBrief();
                          }}
                        >
                          {downloading ? (
                            <Spinner size="xs" />
                          ) : (
                            <Download size={13} strokeWidth={2.25} />
                          )}
                          {downloading ? 'Generating…' : 'Download PDF'}
                        </button>
                      </div>
                    </div>

                    {/* Contact Info */}
                    <div>
                      <h3 className="dl-section-title">Contact Information</h3>
                      <div className="dlx-info-grid">
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
                      <h3 className="dl-section-title">Submission</h3>
                      <div className="dlx-info-grid">
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
                </div>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
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
    <div className="dl-stack">
      {/* Status filter — daylight segmented control */}
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <div className="dlx-seg" role="tablist" aria-label="Onboarding request filter">
          {STATUS_TABS.map((tab) => {
            const isActive = activeFilter === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={isActive ? 'dlx-seg-btn dlx-seg-btn-active' : 'dlx-seg-btn'}
                onClick={() => {
                  setActiveFilter(tab.value);
                  setExpandedId(null);
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            color: 'var(--rcf-ink-dim)',
            fontSize: '0.85rem',
            padding: '32px 0',
          }}
        >
          <Spinner /> Loading onboarding requests…
        </div>
      )}

      {/* Error state */}
      {isError && (
        <div className="dl-banner dl-banner-err">
          Failed to load onboarding requests.
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && items.length === 0 && (
        <div className="dl-empty" style={{ padding: '56px 20px' }}>
          No onboarding requests
          {activeFilter !== 'all' ? ` with status "${statusLabel(activeFilter as OnboardingStatus)}"` : ''}.
        </div>
      )}

      {/* Request queue */}
      {!isLoading && items.length > 0 && (
        <section className="dl-panel">
          <div className="dl-panel-head">
            <h2 className="dl-panel-title">Intake Queue</h2>
            <span className="dl-count">
              {items.length} request{items.length === 1 ? '' : 's'}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead>
                <tr>
                  <th className="dl-th" style={{ width: 34 }} aria-label="Expand" />
                  <th className="dl-th">Company / Contact</th>
                  <th className="dl-th">Products</th>
                  <th className="dl-th">Timeline</th>
                  <th className="dl-th">Status</th>
                  <th className="dl-th">Submitted</th>
                </tr>
              </thead>
              <tbody>
                {items.map((req) => (
                  <OnboardingRow
                    key={req.id}
                    request={req}
                    isExpanded={expandedId === req.id}
                    onToggle={() => setExpandedId((prev) => (prev === req.id ? null : req.id))}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
