/**
 * RejectForm — collapsed "Reject" button that expands into a reason form. All
 * state + the mutation live in `useRejectForm`; this is presentation only.
 */

import { Button } from '../../../../components/ui/Button';
import { GLASS } from '../../../../components/glass/glass';
import type { OnboardingRequest } from '../../../../types/onboarding';
import { useRejectForm } from '../hooks';
import { callout, sectionLabel, fieldLabel, textareaStyle } from '../styles';

interface RejectFormProps {
  request: OnboardingRequest;
  onSuccess: () => void;
}

export function RejectForm({ request, onSuccess }: RejectFormProps) {
  const { showForm, open, cancel, reason, setReason, isPending, submit } = useRejectForm(
    request,
    onSuccess,
  );

  if (!showForm) {
    return (
      <Button variant="danger" size="sm" onClick={open}>
        Reject
      </Button>
    );
  }

  return (
    <div style={callout(GLASS.danger)}>
      <div style={sectionLabel(GLASS.danger)}>Reject Request</div>
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
        <Button variant="danger" size="sm" loading={isPending} onClick={submit}>
          Confirm Reject
        </Button>
        <Button variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
