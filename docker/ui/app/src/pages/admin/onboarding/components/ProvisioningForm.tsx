/**
 * ProvisioningForm — DID selection + forwarding setup + approve action for a
 * billing-verified request. All state, the DID inventory query, and the approve
 * mutation live in `useProvisioningForm`; this component is presentation only.
 */

import { Button } from '../../../../components/ui/Button';
import { GLASS } from '../../../../components/glass/glass';
import { fmt } from '../../../../utils/format';
import type { OnboardingRequest, ApproveResponse } from '../../../../types/onboarding';
import { useProvisioningForm } from '../hooks';
import { IconArrow, IconSearch } from './icons';
import {
  callout,
  sectionLabel,
  fieldLabel,
  inputStyle,
  textareaStyle,
  didListWrap,
  didRow,
  didMono,
  didMeta,
  forwardRowLabel,
  approveBtnGlow,
  spinnerRing,
} from '../styles';

interface ProvisioningFormProps {
  request: OnboardingRequest;
  onApproved: (result: ApproveResponse) => void;
}

export function ProvisioningForm({ request, onApproved }: ProvisioningFormProps) {
  const f = useProvisioningForm(request, onApproved);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header callout */}
      <div style={callout(GLASS.success)}>
        <div style={sectionLabel(GLASS.success)}>Configure &amp; Approve</div>
        <p style={{ fontSize: '0.82rem', color: GLASS.textMuted, margin: 0, lineHeight: 1.55 }}>
          Customer requested{' '}
          <strong style={{ color: GLASS.text }}>{f.requestedCount}</strong> DID
          {f.requestedCount !== 1 ? 's' : ''}. Select DIDs from inventory and set
          forwarding numbers.
        </p>
      </div>

      {/* DID selector */}
      <div>
        <div style={sectionLabel(GLASS.accent)}>Available DIDs</div>

        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, ...inputStyle, padding: '8px 13px' }}>
          <IconSearch stroke={GLASS.textFaint} />
          <input
            type="search"
            value={f.didSearch}
            onChange={(e) => f.setDidSearch(e.target.value)}
            placeholder="Filter by number or city…"
            style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: GLASS.text, fontSize: '0.82rem', fontFamily: 'inherit' }}
          />
        </div>

        {f.didsLoading ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: GLASS.textMuted, fontSize: '0.82rem', padding: '12px 0' }}>
            <span style={spinnerRing()} /> Loading available DIDs…
          </div>
        ) : (
          <div style={didListWrap}>
            {f.availableDids.length === 0 ? (
              <div style={{ padding: 20, textAlign: 'center', color: GLASS.textFaint, fontSize: '0.82rem' }}>
                No available DIDs match your filter.
              </div>
            ) : (
              f.availableDids.map((d) => {
                const isSelected = f.selectedDids.includes(d.did);
                return (
                  <div key={d.did} onClick={() => f.toggleDid(d.did)} style={didRow(isSelected)}>
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => f.toggleDid(d.did)}
                      onClick={(e) => e.stopPropagation()}
                      style={{ accentColor: GLASS.accent, width: 14, height: 14, flexShrink: 0 }}
                    />
                    <span style={didMono}>{fmt(d.did)}</span>
                    {(d.city || d.state) && (
                      <span style={didMeta}>{[d.city, d.state].filter(Boolean).join(', ')}</span>
                    )}
                  </div>
                );
              })
            )}
          </div>
        )}

        {f.selectedDids.length > 0 && (
          <div style={{ marginTop: 8, fontSize: '0.75rem', color: GLASS.accent, fontWeight: 600 }}>
            {f.selectedDids.length} DID{f.selectedDids.length !== 1 ? 's' : ''} selected
          </div>
        )}
      </div>

      {/* Forward-to inputs */}
      {f.selectedDids.length > 0 && (
        <div>
          <div style={sectionLabel(GLASS.accent)}>Forwarding Numbers</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {f.selectedDids.map((did) => (
              <div key={did} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span style={forwardRowLabel}>{fmt(did)}</span>
                <IconArrow color={GLASS.accent} />
                <input
                  type="tel"
                  value={f.forwardMap[did] ?? ''}
                  onChange={(e) => f.setForward(did, e.target.value)}
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
          value={f.adminNotes}
          onChange={(e) => f.setAdminNotes(e.target.value)}
          placeholder="Any notes about this account or provisioning setup…"
          style={textareaStyle}
        />
      </div>

      {/* Approve */}
      <Button
        variant="primary"
        size="default"
        loading={f.isPending}
        disabled={!f.allForwardsFilled}
        onClick={f.submit}
        style={approveBtnGlow(f.allForwardsFilled)}
      >
        Approve &amp; Provision
      </Button>

      {f.selectedDids.length > 0 && !f.allForwardsFilled && (
        <p style={{ fontSize: '0.75rem', color: GLASS.warning, margin: '-12px 0 0' }}>
          All selected DIDs need a forwarding number before approving.
        </p>
      )}
    </div>
  );
}
