/**
 * EditUserPanel — the inline admin editor for a user. All state + the
 * `PUT /auth/users/:id` mutation live in `useEditUserForm`; this component is the
 * frosted-glass presentation (form grid, banner, save/cancel).
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { Spinner } from '../../../../components/ui/Spinner';
import { useEditUserForm } from '../hooks';
import type { User360, UserRole } from '../types';
import {
  banner as bannerStyle,
  editBlur,
  editFocus,
  editInput,
  editLabel,
  editSelect,
  ghostBtn,
  optionStyle,
  primaryBtn,
  sectionHeader,
  sectionIcon,
  sectionTitle,
} from '../styles';
import { IconPencil, IconSave } from './icons';

interface EditUserPanelProps {
  userId: number;
  user: User360;
  onSuccess: () => void;
  onCancel: () => void;
}

export function EditUserPanel({ userId, user, onSuccess, onCancel }: EditUserPanelProps) {
  const f = useEditUserForm({ userId, user, onSuccess });

  return (
    <GlassPanel accent={GLASS.accent} padding="24px 28px">
      <div style={sectionHeader}>
        <span style={sectionIcon(GLASS.accent)}><IconPencil size={14} /></span>
        <h3 style={sectionTitle}>Edit User</h3>
      </div>

      {f.banner && <div style={bannerStyle(f.banner.type)}>{f.banner.message}</div>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '16px 20px', marginBottom: 20 }}>
        {/* Name */}
        <div>
          <label style={editLabel}>Name</label>
          <input type="text" value={f.name} onChange={(e) => f.setName(e.target.value)} onFocus={editFocus} onBlur={editBlur} style={editInput} disabled={f.saving} placeholder="Full name" />
        </div>

        {/* Email */}
        <div>
          <label style={editLabel}>Email</label>
          <input type="email" value={f.email} onChange={(e) => f.setEmail(e.target.value)} onFocus={editFocus} onBlur={editBlur} style={editInput} disabled={f.saving} placeholder="user@example.com" />
        </div>

        {/* Role */}
        <div>
          <label style={editLabel}>Role</label>
          <select value={f.role} onChange={(e) => f.setRole(e.target.value as UserRole)} onFocus={editFocus} onBlur={editBlur} disabled={f.saving} style={editSelect}>
            <option value="admin" style={optionStyle}>Admin</option>
            <option value="user" style={optionStyle}>User</option>
            <option value="readonly" style={optionStyle}>Read-Only</option>
          </select>
        </div>

        {/* Status */}
        <div>
          <label style={editLabel}>Status</label>
          <select value={f.status} onChange={(e) => f.setStatus(e.target.value as 'active' | 'disabled')} onFocus={editFocus} onBlur={editBlur} disabled={f.saving} style={editSelect}>
            <option value="active" style={optionStyle}>Active</option>
            <option value="disabled" style={optionStyle}>Disabled</option>
          </select>
        </div>

        {/* Customer */}
        <div>
          <label style={editLabel}>Customer</label>
          <select
            value={f.customerId}
            onChange={(e) => f.setCustomerId(parseInt(e.target.value, 10))}
            onFocus={editFocus}
            onBlur={editBlur}
            disabled={f.saving || f.customersLoading}
            style={{ ...editSelect, cursor: f.saving || f.customersLoading ? 'wait' : 'pointer', color: f.customersLoading ? GLASS.textMuted : GLASS.text }}
          >
            {f.customersLoading ? (
              <option value={f.customerId} style={{ ...optionStyle, color: GLASS.textMuted }}>Loading customers…</option>
            ) : (
              f.customers.map((c) => (
                <option key={c.id} value={c.id} style={optionStyle}>
                  {c.name}{c.status !== 'active' ? ` (${c.status})` : ''}
                </option>
              ))
            )}
          </select>
        </div>

        {/* New Password */}
        <div>
          <label style={editLabel}>New Password (leave blank to keep current)</label>
          <input type="password" value={f.password} onChange={(e) => f.setPassword(e.target.value)} onFocus={editFocus} onBlur={editBlur} style={editInput} disabled={f.saving} placeholder="Leave blank to keep current" autoComplete="new-password" />
        </div>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          type="button"
          onClick={() => void f.handleSave()}
          disabled={f.saving}
          style={primaryBtn(f.saving)}
          onMouseEnter={(e) => { if (!f.saving) e.currentTarget.style.background = '#2563eb'; }}
          onMouseLeave={(e) => { if (!f.saving) e.currentTarget.style.background = `linear-gradient(135deg, ${GLASS.accent} 0%, ${GLASS.accent}cc 100%)`; }}
        >
          {f.saving ? <><Spinner size="sm" />Saving…</> : <><IconSave />Save Changes</>}
        </button>

        <button
          type="button"
          onClick={onCancel}
          disabled={f.saving}
          style={ghostBtn(f.saving)}
          onMouseEnter={(e) => { if (!f.saving) { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.2)'; e.currentTarget.style.color = GLASS.text; } }}
          onMouseLeave={(e) => { if (!f.saving) { e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)'; e.currentTarget.style.color = GLASS.textMuted; } }}
        >
          Cancel
        </button>
      </div>
    </GlassPanel>
  );
}
