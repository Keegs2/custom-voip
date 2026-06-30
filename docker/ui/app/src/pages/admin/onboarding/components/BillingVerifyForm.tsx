/**
 * BillingVerifyForm — the "verify billing" action for a pending request. All
 * state + the mutation live in `useBillingVerifyForm`; this is presentation.
 */

import { Button } from '../../../../components/ui/Button';
import { GLASS } from '../../../../components/glass/glass';
import type { OnboardingRequest } from '../../../../types/onboarding';
import { useBillingVerifyForm } from '../hooks';
import { callout, sectionLabel, fieldLabel, textareaStyle } from '../styles';

interface BillingVerifyFormProps {
  request: OnboardingRequest;
  onSuccess: () => void;
}

export function BillingVerifyForm({ request, onSuccess }: BillingVerifyFormProps) {
  const { notes, setNotes, isPending, submit } = useBillingVerifyForm(request, onSuccess);

  return (
    <div style={callout(GLASS.accent)}>
      <div style={sectionLabel(GLASS.accent)}>Verify Billing</div>
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
        loading={isPending}
        onClick={submit}
        style={{ alignSelf: 'flex-start' }}
      >
        Mark Billing Verified
      </Button>
    </div>
  );
}
