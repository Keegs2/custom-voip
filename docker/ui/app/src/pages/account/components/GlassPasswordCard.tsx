/**
 * GlassPasswordCard — the change-password form in a frosted glass panel. All
 * field state, client validation, and the live PUT mutation come from
 * `usePasswordForm`; this component is otherwise presentational.
 *
 * The save button uses the success-green accent (a status semantic), while the
 * card chrome stays app-blue so the page reads blue.
 *
 * React #310: the single logic hook sits at the very top, before any return.
 */

import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { usePasswordForm } from '../hooks';
import { cardBody, form, actionsRow } from '../styles';
import { CardHeader } from './CardHeader';
import { LabeledField, GlassTextInput } from './fields';
import { StatusBanner } from './StatusBanner';
import { SaveButton } from './SaveButton';
import { IconLock } from './icons';

interface GlassPasswordCardProps {
  onRefresh: () => Promise<void>;
  index: number;
}

export function GlassPasswordCard({ onRefresh, index }: GlassPasswordCardProps) {
  // ALL hooks first (React #310). The hook owns all field state + the mutation.
  const f = usePasswordForm(onRefresh);

  return (
    <GlassPanel
      padding="24px 26px"
      style={{ animation: 'glass-rise 0.5s cubic-bezier(0.2,0.7,0.3,1) both', animationDelay: `${index * 70}ms` }}
    >
      <CardHeader icon={<IconLock />} title="Change Password" subtitle="Use at least 8 characters for your new password." />

      <div style={cardBody}>
        <form onSubmit={f.handleSave} style={form}>
          <LabeledField label="Current Password" htmlFor="current-password">
            <GlassTextInput
              id="current-password"
              type="password"
              value={f.currentPassword}
              onChange={f.setCurrentPassword}
              placeholder="Your current password"
              autoComplete="current-password"
              disabled={f.saving}
            />
          </LabeledField>

          <LabeledField label="New Password" htmlFor="new-password">
            <GlassTextInput
              id="new-password"
              type="password"
              value={f.newPassword}
              onChange={f.setNewPassword}
              placeholder="At least 8 characters"
              autoComplete="new-password"
              disabled={f.saving}
            />
          </LabeledField>

          <LabeledField label="Confirm New Password" htmlFor="confirm-password">
            <GlassTextInput
              id="confirm-password"
              type="password"
              value={f.confirmPassword}
              onChange={f.setConfirmPassword}
              placeholder="Repeat new password"
              autoComplete="new-password"
              disabled={f.saving}
            />
          </LabeledField>

          {f.status && <StatusBanner type={f.status.type} message={f.status.message} />}

          <div style={actionsRow}>
            <SaveButton saving={f.saving} label="Change Password" savingLabel="Saving…" accent={GLASS.success} />
          </div>
        </form>
      </div>
    </GlassPanel>
  );
}
