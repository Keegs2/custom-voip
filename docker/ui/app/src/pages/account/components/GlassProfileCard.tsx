/**
 * GlassProfileCard — read-only identity fields + the editable display name in a
 * frosted glass panel. All form state + the live PUT mutation come from
 * `useProfileForm`; this component is otherwise presentational.
 *
 * React #310: the single logic hook sits at the very top, before any return.
 */

import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import type { User } from '../../../types/auth';
import { useProfileForm } from '../hooks';
import { ROLE_LABELS } from '../types';
import { cardBody, divider, readOnlyGrid, form, actionsRow } from '../styles';
import { CardHeader } from './CardHeader';
import { LabeledField, ReadOnlyValue, GlassTextInput } from './fields';
import { StatusBanner } from './StatusBanner';
import { SaveButton } from './SaveButton';
import { IconUser } from './icons';

interface GlassProfileCardProps {
  user: User;
  onRefresh: () => Promise<void>;
  index: number;
}

export function GlassProfileCard({ user, onRefresh, index }: GlassProfileCardProps) {
  // ALL hooks first (React #310). The hook owns name/status + mutation.
  const { name, setName, status, saving, handleSave } = useProfileForm(user, onRefresh);

  const formattedLastLogin = user.last_login
    ? new Date(user.last_login).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
    : 'Never';

  return (
    <GlassPanel
      padding="24px 26px"
      style={{ animation: 'glass-rise 0.5s cubic-bezier(0.2,0.7,0.3,1) both', animationDelay: `${index * 70}ms` }}
    >
      <CardHeader icon={<IconUser />} title="Profile" subtitle="Your account identity and display name." />

      <div style={cardBody}>
        {/* Read-only identity */}
        <div style={readOnlyGrid}>
          <LabeledField label="Email">
            <ReadOnlyValue value={user.email} />
          </LabeledField>
          <LabeledField label="Role">
            <ReadOnlyValue value={ROLE_LABELS[user.role]} />
          </LabeledField>
          <LabeledField label="Customer">
            <ReadOnlyValue value={user.customer_name ?? 'None'} />
          </LabeledField>
          <LabeledField label="Last Login">
            <ReadOnlyValue value={formattedLastLogin} />
          </LabeledField>
        </div>

        <div style={divider} />

        {/* Editable display name */}
        <form onSubmit={handleSave} style={form}>
          <LabeledField label="Display Name" htmlFor="profile-name">
            <GlassTextInput
              id="profile-name"
              value={name}
              onChange={setName}
              placeholder="Your display name"
              autoComplete="name"
              disabled={saving}
            />
          </LabeledField>

          {status && <StatusBanner type={status.type} message={status.message} />}

          <div style={actionsRow}>
            <SaveButton saving={saving} label="Save Name" savingLabel="Saving…" accent={GLASS.accent} />
          </div>
        </form>
      </div>
    </GlassPanel>
  );
}
