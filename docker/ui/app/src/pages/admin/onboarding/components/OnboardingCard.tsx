/**
 * OnboardingCard — one onboarding request as a frosted glass card. The summary
 * row toggles an expandable detail panel; the detail panel renders the
 * status-appropriate action forms (verify / reject / provision) or read-only
 * detail (active / rejected). Purely presentational — all mutations live in the
 * form components' hooks.
 *
 * The card's hover-glow accent follows the request status (blue default, amber
 * pending, green active, red rejected, cyan in-flight).
 */

import { GlassCard } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { fmt } from '../../../../utils/format';
import type { OnboardingRequest, ApproveResponse } from '../../../../types/onboarding';
import { statusColor, fmtDate, fmtDateTime } from '../helpers';
import { StatusChip } from './StatusChip';
import { InfoPair } from './InfoPair';
import { BillingVerifyForm } from './BillingVerifyForm';
import { RejectForm } from './RejectForm';
import { ProvisioningForm } from './ProvisioningForm';
import { ActiveDetail } from './ActiveDetail';
import { RejectedDetail } from './RejectedDetail';
import { IconChevron } from './icons';
import {
  summaryRow,
  chevron,
  companyName,
  companyContact,
  didCount,
  didCountLabel,
  timelineCell,
  submittedCell,
  detailPanel,
  sectionLabel,
  detailGrid,
  callout,
} from '../styles';

interface OnboardingCardProps {
  request: OnboardingRequest;
  isExpanded: boolean;
  index: number;
  onToggle: () => void;
  onApproved: (result: ApproveResponse) => void;
}

export function OnboardingCard({ request, isExpanded, index, onToggle, onApproved }: OnboardingCardProps) {
  const isPending = request.status === 'pending';
  const isBillingVerified = request.status === 'billing_verified';
  const isActive = request.status === 'active';
  const isRejected = request.status === 'rejected';
  const accent = statusColor(request.status);

  const noop = () => {
    /* card re-renders from query invalidation */
  };

  return (
    <GlassCard index={index} accent={accent} radius={16}>
      {/* Summary row */}
      <div onClick={onToggle} style={summaryRow()}>
        <span style={chevron(isExpanded)}>
          <IconChevron />
        </span>

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={companyName}>{request.company_name}</div>
          <div style={companyContact}>
            {request.contact_name} · {request.email}
          </div>
        </div>

        <div style={{ textAlign: 'center', flexShrink: 0 }}>
          <div style={didCount(accent)}>{request.did_count}</div>
          <div style={didCountLabel}>DIDs</div>
        </div>

        <div style={timelineCell}>{request.timeline}</div>

        <div style={{ flexShrink: 0 }}>
          <StatusChip status={request.status} />
        </div>

        <div style={submittedCell}>{fmtDate(request.created_at)}</div>
      </div>

      {/* Detail panel */}
      {isExpanded && (
        <div style={detailPanel}>
          {/* Contact Info */}
          <div>
            <div style={sectionLabel(GLASS.accent)}>Contact Information</div>
            <div style={detailGrid}>
              <InfoPair label="Company" value={request.company_name} />
              <InfoPair label="Contact Name" value={request.contact_name} />
              <InfoPair label="Email" value={request.email} />
              <InfoPair label="Phone" value={request.phone ? fmt(request.phone) : null} />
            </div>
          </div>

          {/* RCF Requirements */}
          <div>
            <div style={sectionLabel(GLASS.accent)}>RCF Requirements</div>
            <div style={detailGrid}>
              <InfoPair label="DIDs Requested" value={request.did_count} />
              <InfoPair label="Porting Existing Numbers?" value={request.porting} />
              <InfoPair label="Current Carrier" value={request.current_carrier} />
              <InfoPair label="Forwarding Setup" value={request.forwarding_setup} />
              <InfoPair label="Monthly Volume" value={request.monthly_volume} />
              <InfoPair label="Timeline" value={request.timeline} />
            </div>
          </div>

          {/* Billing verification metadata */}
          {(isBillingVerified || isActive) && request.billing_verified_by_name && (
            <div style={callout(GLASS.accent)}>
              <div style={sectionLabel(GLASS.accent)}>Billing Verification</div>
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
              <BillingVerifyForm request={request} onSuccess={noop} />
              <RejectForm request={request} onSuccess={noop} />
            </div>
          )}

          {isBillingVerified && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <ProvisioningForm request={request} onApproved={onApproved} />
              <div style={{ borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 16 }}>
                <RejectForm request={request} onSuccess={noop} />
              </div>
            </div>
          )}

          {isActive && <ActiveDetail request={request} />}
          {isRejected && <RejectedDetail request={request} />}
        </div>
      )}
    </GlassCard>
  );
}
