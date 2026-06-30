/**
 * InfoPair — a read-only label/value display field used throughout the
 * onboarding detail panels.
 */

import { fieldLabel, fieldValue } from '../styles';

export function InfoPair({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <span style={fieldLabel}>{label}</span>
      <span style={fieldValue}>{value || '—'}</span>
    </div>
  );
}
