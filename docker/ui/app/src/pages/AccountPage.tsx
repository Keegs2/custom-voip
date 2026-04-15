import { useState, useCallback, type FormEvent, type CSSProperties } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiRequest, ApiError } from '../api/client';
import type { User } from '../types/auth';

/* ─── Types ──────────────────────────────────────────────── */

interface UpdateMeBody {
  name?: string;
  current_password?: string;
  new_password?: string;
}

/* ─── Style constants ────────────────────────────────────── */

const COLORS = {
  bg: '#0f1117',
  card: '#1a1d2e',
  text: '#e2e8f0',
  secondary: '#94a3b8',
  muted: '#475569',
  border: 'rgba(42,47,69,0.6)',
  inputBg: 'rgba(255,255,255,0.04)',
  inputBorder: 'rgba(255,255,255,0.08)',
  focusBorder: '#3b82f6',
  primary: '#3b82f6',
  success: '#22c55e',
  error: '#f87171',
} as const;

/* ─── Shared sub-components ──────────────────────────────── */

interface LabeledFieldProps {
  label: string;
  children: React.ReactNode;
}

function LabeledField({ label, children }: LabeledFieldProps) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <label
        style={{
          fontSize: '0.75rem',
          fontWeight: 600,
          color: COLORS.secondary,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
        }}
      >
        {label}
      </label>
      {children}
    </div>
  );
}

interface ReadOnlyValueProps {
  value: string;
}

function ReadOnlyValue({ value }: ReadOnlyValueProps) {
  return (
    <div
      style={{
        padding: '9px 12px',
        borderRadius: 6,
        background: 'rgba(255,255,255,0.02)',
        border: `1px solid ${COLORS.border}`,
        fontSize: '0.875rem',
        color: COLORS.muted,
        userSelect: 'all',
      }}
    >
      {value}
    </div>
  );
}

interface TextInputProps {
  id: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  disabled?: boolean;
}

function TextInput({ id, type = 'text', value, onChange, placeholder, autoComplete, disabled }: TextInputProps) {
  const [focused, setFocused] = useState(false);

  const style: CSSProperties = {
    padding: '9px 12px',
    borderRadius: 6,
    background: disabled ? 'rgba(255,255,255,0.02)' : COLORS.inputBg,
    border: `1px solid ${focused ? COLORS.focusBorder : COLORS.inputBorder}`,
    outline: 'none',
    fontSize: '0.875rem',
    color: disabled ? COLORS.muted : COLORS.text,
    transition: 'border-color 0.15s',
    width: '100%',
    boxSizing: 'border-box',
    cursor: disabled ? 'not-allowed' : 'text',
  };

  return (
    <input
      id={id}
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      placeholder={placeholder}
      autoComplete={autoComplete}
      disabled={disabled}
      style={style}
    />
  );
}

interface StatusBannerProps {
  type: 'success' | 'error';
  message: string;
}

function StatusBanner({ type, message }: StatusBannerProps) {
  const color = type === 'success' ? COLORS.success : COLORS.error;
  return (
    <div
      style={{
        padding: '10px 14px',
        borderRadius: 6,
        background: `${color}14`,
        border: `1px solid ${color}40`,
        color,
        fontSize: '0.825rem',
        fontWeight: 500,
      }}
    >
      {message}
    </div>
  );
}

/* ─── Profile card ───────────────────────────────────────── */

interface ProfileCardProps {
  user: User;
  onRefresh: () => Promise<void>;
}

function ProfileCard({ user, onRefresh }: ProfileCardProps) {
  const [name, setName] = useState(user.name ?? '');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [btnHover, setBtnHover] = useState(false);

  const formattedLastLogin = user.last_login
    ? new Date(user.last_login).toLocaleString(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      })
    : 'Never';

  const roleLabelMap: Record<User['role'], string> = {
    admin: 'Administrator',
    user: 'User',
    readonly: 'Read-only',
  };

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
    <section
      style={{
        background: COLORS.card,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 8,
        padding: '24px 28px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <h2
        style={{
          margin: 0,
          fontSize: '0.95rem',
          fontWeight: 700,
          color: COLORS.text,
          letterSpacing: '-0.01em',
        }}
      >
        Profile
      </h2>

      {/* Read-only fields */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px 20px' }}>
        <LabeledField label="Email">
          <ReadOnlyValue value={user.email} />
        </LabeledField>

        <LabeledField label="Role">
          <ReadOnlyValue value={roleLabelMap[user.role]} />
        </LabeledField>

        <LabeledField label="Customer">
          <ReadOnlyValue value={user.customer_name ?? 'None'} />
        </LabeledField>

        <LabeledField label="Last Login">
          <ReadOnlyValue value={formattedLastLogin} />
        </LabeledField>
      </div>

      {/* Divider */}
      <div style={{ height: 1, background: COLORS.border }} />

      {/* Editable name */}
      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <LabeledField label="Display Name">
          <TextInput
            id="profile-name"
            value={name}
            onChange={setName}
            placeholder="Your display name"
            autoComplete="name"
            disabled={saving}
          />
        </LabeledField>

        {status && <StatusBanner type={status.type} message={status.message} />}

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="submit"
            disabled={saving}
            onMouseEnter={() => setBtnHover(true)}
            onMouseLeave={() => setBtnHover(false)}
            style={{
              padding: '8px 20px',
              borderRadius: 6,
              background: btnHover && !saving ? '#2563eb' : COLORS.primary,
              border: 'none',
              color: '#fff',
              fontSize: '0.825rem',
              fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.65 : 1,
              transition: 'background 0.15s, opacity 0.15s',
            }}
          >
            {saving ? 'Saving...' : 'Save Name'}
          </button>
        </div>
      </form>
    </section>
  );
}

/* ─── Change password card ───────────────────────────────── */

interface PasswordCardProps {
  onRefresh: () => Promise<void>;
}

function PasswordCard({ onRefresh }: PasswordCardProps) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  const [btnHover, setBtnHover] = useState(false);

  const validate = (): string | null => {
    if (!currentPassword) return 'Current password is required.';
    if (newPassword.length < 8) return 'New password must be at least 8 characters.';
    if (newPassword !== confirmPassword) return 'Passwords do not match.';
    return null;
  };

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentPassword, newPassword, confirmPassword, onRefresh],
  );

  return (
    <section
      style={{
        background: COLORS.card,
        border: `1px solid ${COLORS.border}`,
        borderRadius: 8,
        padding: '24px 28px',
        display: 'flex',
        flexDirection: 'column',
        gap: 20,
      }}
    >
      <h2
        style={{
          margin: 0,
          fontSize: '0.95rem',
          fontWeight: 700,
          color: COLORS.text,
          letterSpacing: '-0.01em',
        }}
      >
        Change Password
      </h2>

      <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <LabeledField label="Current Password">
          <TextInput
            id="current-password"
            type="password"
            value={currentPassword}
            onChange={setCurrentPassword}
            placeholder="Your current password"
            autoComplete="current-password"
            disabled={saving}
          />
        </LabeledField>

        <LabeledField label="New Password">
          <TextInput
            id="new-password"
            type="password"
            value={newPassword}
            onChange={setNewPassword}
            placeholder="At least 8 characters"
            autoComplete="new-password"
            disabled={saving}
          />
        </LabeledField>

        <LabeledField label="Confirm New Password">
          <TextInput
            id="confirm-password"
            type="password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            placeholder="Repeat new password"
            autoComplete="new-password"
            disabled={saving}
          />
        </LabeledField>

        {status && <StatusBanner type={status.type} message={status.message} />}

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            type="submit"
            disabled={saving}
            onMouseEnter={() => setBtnHover(true)}
            onMouseLeave={() => setBtnHover(false)}
            style={{
              padding: '8px 20px',
              borderRadius: 6,
              background: btnHover && !saving ? '#16a34a' : COLORS.success,
              border: 'none',
              color: '#fff',
              fontSize: '0.825rem',
              fontWeight: 600,
              cursor: saving ? 'not-allowed' : 'pointer',
              opacity: saving ? 0.65 : 1,
              transition: 'background 0.15s, opacity 0.15s',
            }}
          >
            {saving ? 'Saving...' : 'Change Password'}
          </button>
        </div>
      </form>
    </section>
  );
}

/* ─── Page ───────────────────────────────────────────────── */

export function AccountPage() {
  // All hooks unconditionally at the top — React #310 guard
  const { user, refreshUser } = useAuth();

  if (!user) {
    return null;
  }

  return (
    <div
      style={{
        minHeight: '100%',
        background: COLORS.bg,
        padding: '32px 24px 48px',
      }}
    >
      {/* Page header */}
      <div style={{ maxWidth: 720, margin: '0 auto', marginBottom: 28 }}>
        <h1
          style={{
            margin: 0,
            fontSize: '1.5rem',
            fontWeight: 800,
            color: COLORS.text,
            letterSpacing: '-0.03em',
          }}
        >
          Account Settings
        </h1>
        <p
          style={{
            margin: '6px 0 0',
            fontSize: '0.875rem',
            color: COLORS.muted,
          }}
        >
          Manage your profile and security settings.
        </p>
      </div>

      {/* Cards */}
      <div
        style={{
          maxWidth: 720,
          margin: '0 auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        }}
      >
        <ProfileCard user={user} onRefresh={refreshUser} />
        <PasswordCard onRefresh={refreshUser} />
      </div>
    </div>
  );
}
