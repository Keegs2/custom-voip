/**
 * RejectedDetail — read-only summary of a rejected onboarding request:
 * who/when + the rejection reason.
 */

import { GLASS } from '../../../../components/glass/glass';
import type { OnboardingRequest } from '../../../../types/onboarding';
import { InfoPair } from './InfoPair';
import { fmtDateTime } from '../helpers';
import { callout, sectionLabel, fieldLabel, detailGridTwo } from '../styles';

export function RejectedDetail({ request }: { request: OnboardingRequest }) {
  return (
    <div style={callout(GLASS.danger)}>
      <div style={sectionLabel(GLASS.danger)}>Rejection Details</div>
      <div style={detailGridTwo}>
        {request.rejected_by && request.reviewed_by_name && (
          <InfoPair label="Rejected By" value={request.reviewed_by_name} />
        )}
        {request.rejected_at && <InfoPair label="Rejected At" value={fmtDateTime(request.rejected_at)} />}
      </div>
      {request.rejection_reason && (
        <div>
          <span style={fieldLabel}>Reason</span>
          <p style={{ fontSize: '0.82rem', margin: 0, color: '#fca5a5', lineHeight: 1.55 }}>
            {request.rejection_reason}
          </p>
        </div>
      )}
    </div>
  );
}
