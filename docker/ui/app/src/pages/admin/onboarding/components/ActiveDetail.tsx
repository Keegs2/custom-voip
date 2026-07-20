/**
 * ActiveDetail — read-only summary of a provisioned (active) onboarding request:
 * the provisioned account metadata + the configured DIDs.
 */

import { GLASS } from '../../../../components/glass/glass';
import { fmt } from '../../../../utils/format';
import type { OnboardingRequest } from '../../../../types/onboarding';
import { InfoPair } from './InfoPair';
import { fmtDateTime } from '../helpers';
import { callout, sectionLabel, detailGridTwo, provisionedDidRow, MONO } from '../styles';

export function ActiveDetail({ request }: { request: OnboardingRequest }) {
  const config = request.provisioning_config ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={callout(GLASS.success)}>
        <div style={sectionLabel(GLASS.success)}>Provisioned Account</div>
        <div style={detailGridTwo}>
          {request.customer_id && <InfoPair label="Customer ID" value={String(request.customer_id)} />}
          {request.reviewed_by_name && <InfoPair label="Approved By" value={request.reviewed_by_name} />}
          {request.reviewed_at && <InfoPair label="Approved At" value={fmtDateTime(request.reviewed_at)} />}
          {request.admin_notes && (
            <div style={{ gridColumn: '1 / -1' }}>
              <InfoPair label="Admin Notes" value={request.admin_notes} />
            </div>
          )}
        </div>
      </div>

      {config.length > 0 && (
        <div>
          <div style={sectionLabel(GLASS.accent)}>Provisioned DIDs</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {config.map((d) => (
              <div key={d.did} style={provisionedDidRow}>
                <span style={{ fontFamily: MONO, fontSize: '0.83rem', color: GLASS.text }}>{fmt(d.did)}</span>
                <span style={{ fontSize: '0.78rem', color: GLASS.textMuted }}>→ {fmt(d.forward_to)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
