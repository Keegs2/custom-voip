/**
 * My Account › Your Account — the signed-in user's own profile (absorbed the
 * retired standalone /account page). Layout (docker/ui/CLAUDE.md §20):
 *
 *   ┌ Profile ─────────────────────────────────────────────────────────────┐
 *   │ EMAIL · ROLE · CUSTOMER · LAST LOGIN        (one row of facts)       │
 *   │ Display name [_______________] [Save name]  (field + submit, one row)│
 *   └──────────────────────────────────────────────────────────────────────┘
 *   ▸ Change Password · Keep your sign-in secure            (expandable card)
 *
 * The password form is a rarely-used security setting, so it sits behind an
 * expandable row (closed on every visit — not remembered). Both forms keep
 * the exact PUT /auth/me calls and validation they always had.
 */
import { useCallback, useState, type FormEvent, type ReactNode } from 'react';
import { IdCard, ShieldCheck } from 'lucide-react';
import { apiRequest, ApiError } from '../../api/client';
import { Disclosure } from '../../components/layout/kit';
import type { User } from '../../types/auth';
import { ROLE_LABEL, fmtDateTime } from './format';
import { Section } from './parts';

/** Body of PUT /auth/me. */
interface UpdateMeBody {
  name?: string;
  current_password?: string;
  new_password?: string;
}

type FormStatus = { type: 'success' | 'error'; message: string } | null;

function FieldLabel({ htmlFor, children }: { htmlFor: string; children: ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="dl-flabel ma-flabel">
      {children}
    </label>
  );
}

function StatusBanner({ status }: { status: NonNullable<FormStatus> }) {
  return (
    <div role="status" className={status.type === 'success' ? 'dl-banner dl-banner-ok' : 'dl-banner dl-banner-err'}>
      {status.message}
    </div>
  );
}

/** Identity facts + edit display name (PUT /auth/me {name}). */
function ProfileCard({ user, onRefresh }: { user: User; onRefresh: () => Promise<void> }) {
  const [name, setName] = useState(user.name ?? '');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<FormStatus>(null);

  const handleSave = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const trimmed = name.trim();
      if (!trimmed) {
        setStatus({ type: 'error', message: 'Name cannot be empty.' });
        return;
      }
      setSaving(true);
      setStatus(null);
      try {
        await apiRequest<User>('PUT', '/auth/me', { name: trimmed } satisfies UpdateMeBody);
        await onRefresh();
        setStatus({ type: 'success', message: 'Display name updated.' });
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Failed to save. Please try again.';
        setStatus({ type: 'error', message });
      } finally {
        setSaving(false);
      }
    },
    [name, onRefresh],
  );

  return (
    <Section id="ma-profile" title="Profile" subtitle="Your identity on the platform" icon={<IdCard size={16} strokeWidth={1.8} />}>
      <div className="ma-ro-grid">
        <div className="ma-field">
          <FieldLabel htmlFor="my-email">Email</FieldLabel>
          <div className="dl-ro ma-mono ma-select-all" id="my-email">
            {user.email}
          </div>
        </div>
        <div className="ma-field">
          <FieldLabel htmlFor="my-role">Role</FieldLabel>
          <div className="dl-ro" id="my-role">
            {ROLE_LABEL[user.role]}
          </div>
        </div>
        <div className="ma-field">
          <FieldLabel htmlFor="my-customer">Customer</FieldLabel>
          <div className="dl-ro" id="my-customer">
            {user.customer_name ?? 'None'}
          </div>
        </div>
        <div className="ma-field">
          <FieldLabel htmlFor="my-last-login">Last Login</FieldLabel>
          <div className="dl-ro" id="my-last-login">
            {fmtDateTime(user.last_login)}
          </div>
        </div>
      </div>

      <form onSubmit={handleSave} className="ma-form">
        <div className="ma-form-row">
          <div className="ma-field ma-field-grow">
            <FieldLabel htmlFor="my-name">Display name</FieldLabel>
            <input
              id="my-name"
              className="dl-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your display name"
              autoComplete="name"
              disabled={saving}
            />
          </div>
          <button type="submit" className="dl-btn dl-btn-primary" disabled={saving}>
            {saving ? 'Saving…' : 'Save Name'}
          </button>
        </div>
        {status && <StatusBanner status={status} />}
      </form>
    </Section>
  );
}

/** Change password (PUT /auth/me {current_password, new_password}). */
function PasswordForm({ onRefresh }: { onRefresh: () => Promise<void> }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<FormStatus>(null);

  const validate = useCallback((): string | null => {
    if (!currentPassword) return 'Current password is required.';
    if (newPassword.length < 8) return 'New password must be at least 8 characters.';
    if (newPassword !== confirmPassword) return 'Passwords do not match.';
    return null;
  }, [currentPassword, newPassword, confirmPassword]);

  const handleSave = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      const validationError = validate();
      if (validationError) {
        setStatus({ type: 'error', message: validationError });
        return;
      }
      setSaving(true);
      setStatus(null);
      try {
        await apiRequest<User>('PUT', '/auth/me', {
          current_password: currentPassword,
          new_password: newPassword,
        } satisfies UpdateMeBody);
        await onRefresh();
        setStatus({ type: 'success', message: 'Password changed successfully.' });
        setCurrentPassword('');
        setNewPassword('');
        setConfirmPassword('');
      } catch (err) {
        const message = err instanceof ApiError ? err.message : 'Failed to change password. Please try again.';
        setStatus({ type: 'error', message });
      } finally {
        setSaving(false);
      }
    },
    [currentPassword, newPassword, validate, onRefresh],
  );

  return (
    <form onSubmit={handleSave} className="ma-form">
      <div className="ma-form-row ma-form-row-pw">
        <div className="ma-field">
          <FieldLabel htmlFor="cur-pw">Current password</FieldLabel>
          <input
            id="cur-pw"
            className="dl-input"
            type="password"
            value={currentPassword}
            onChange={(e) => setCurrentPassword(e.target.value)}
            placeholder="Your current password"
            autoComplete="current-password"
            disabled={saving}
          />
        </div>
        <div className="ma-field">
          <FieldLabel htmlFor="new-pw">New password</FieldLabel>
          <input
            id="new-pw"
            className="dl-input"
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            disabled={saving}
          />
        </div>
        <div className="ma-field">
          <FieldLabel htmlFor="confirm-pw">Confirm new password</FieldLabel>
          <input
            id="confirm-pw"
            className="dl-input"
            type="password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            placeholder="Repeat new password"
            autoComplete="new-password"
            disabled={saving}
          />
        </div>
        <button type="submit" className="dl-btn dl-btn-primary" disabled={saving}>
          {saving ? 'Saving…' : 'Change Password'}
        </button>
      </div>
      {status && <StatusBanner status={status} />}
    </form>
  );
}

export function SecurityTab({ user, onRefresh }: { user: User; onRefresh: () => Promise<void> }) {
  return (
    <div className="ma-stack">
      <ProfileCard user={user} onRefresh={onRefresh} />
      <Disclosure
        variant="card"
        title="Change Password"
        summary="Keep your sign-in secure"
        icon={<ShieldCheck size={15} strokeWidth={1.9} />}
        headingLevel={2}
        className="ma-password"
      >
        <PasswordForm onRefresh={onRefresh} />
      </Disclosure>
    </div>
  );
}
