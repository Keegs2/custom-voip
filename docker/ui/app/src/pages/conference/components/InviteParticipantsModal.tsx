/**
 * InviteParticipantsModal — pick directory users (excluding existing members) and
 * invite them as participant or moderator. Wired to getDirectory + inviteParticipants.
 */

import { useEffect, useState } from 'react';
import { UserPlus, Shield, User, Check, X } from 'lucide-react';
import { getDirectory } from '../../../api/extensions';
import { inviteParticipants } from '../../../api/conference';
import type { Extension } from '../../../types/softphone';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import {
  inputStyle,
  primaryBtn,
  secondaryBtn,
  modalCloseBtn,
  modalIconBadge,
  errorBanner,
  spinner,
  avatar,
} from '../styles';
import { GlassModalShell } from './GlassModalShell';

interface InviteParticipantsModalProps {
  conferenceId: number;
  /** User IDs already in the conference — excluded from the picker */
  existingUserIds: Set<number>;
  onClose: () => void;
  onInvited: () => void;
}

export function InviteParticipantsModal({
  conferenceId,
  existingUserIds,
  onClose,
  onInvited,
}: InviteParticipantsModalProps) {
  const [directory, setDirectory] = useState<Extension[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [role, setRole] = useState<'participant' | 'moderator'>('participant');

  useEffect(() => {
    setLoading(true);
    getDirectory()
      .then((exts) => {
        setDirectory(exts.filter((e) => e.user_id !== null && !existingUserIds.has(e.user_id)));
      })
      .catch(() => setError('Failed to load user directory'))
      .finally(() => setLoading(false));
  }, [existingUserIds]);

  const filtered = directory.filter((e) => {
    const term = search.toLowerCase();
    if (!term) return true;
    return (
      e.display_name.toLowerCase().includes(term) ||
      e.extension.toLowerCase().includes(term) ||
      (e.user_name ?? '').toLowerCase().includes(term)
    );
  });

  const toggle = (userId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  const handleInvite = async () => {
    if (selected.size === 0) return;
    setSubmitting(true);
    setError(null);
    try {
      await inviteParticipants(conferenceId, [...selected], role);
      onInvited();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite participants');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <GlassModalShell onClose={onClose} maxWidth={480} maxHeight="80vh">
      {/* Header */}
      <div
        style={{
          padding: '18px 20px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexShrink: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={modalIconBadge(34)}>
            <UserPlus size={16} />
          </div>
          <div>
            <div style={{ fontSize: '0.9rem', fontWeight: 700, color: GLASS.text }}>Invite Participants</div>
            <div style={{ fontSize: '0.72rem', color: GLASS.textFaint }}>
              {selected.size === 0 ? 'Select people to invite' : `${selected.size} selected`}
            </div>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" style={modalCloseBtn}>
          <X size={18} />
        </button>
      </div>

      {/* Search + role selector */}
      <div
        style={{
          padding: '12px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          flexShrink: 0,
        }}
      >
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name or extension..."
          autoFocus
          style={{ ...inputStyle, padding: '8px 12px' }}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          {(['participant', 'moderator'] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRole(r)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '6px 12px',
                borderRadius: 8,
                border: `1px solid ${role === r ? hexToRgba(GLASS.accent, 0.4) : 'rgba(255,255,255,0.08)'}`,
                background: role === r ? hexToRgba(GLASS.accent, 0.12) : 'rgba(255,255,255,0.03)',
                color: role === r ? '#93c5fd' : GLASS.textMuted,
                fontSize: '0.75rem',
                fontWeight: 600,
                cursor: 'pointer',
                transition: 'all 0.15s',
                textTransform: 'capitalize',
                fontFamily: 'inherit',
              }}
            >
              {r === 'moderator' ? <Shield size={12} /> : <User size={12} />}
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* User list */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 8, minHeight: 0 }}>
        {error && <div style={{ ...errorBanner, margin: '6px 8px' }}>{error}</div>}

        {loading ? (
          <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
            <div style={spinner(20)} />
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '28px 16px', color: GLASS.textFaint, fontSize: '0.83rem' }}>
            {search ? 'No users match your search.' : 'All users are already participants.'}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {filtered.map((ext) => {
              const userId = ext.user_id as number;
              const isChecked = selected.has(userId);
              const presenceColor =
                ext.presence_status === 'available' ? GLASS.success
                : ext.presence_status === 'busy' ? GLASS.danger
                : ext.presence_status === 'away' ? GLASS.warning
                : GLASS.textFaint;

              return (
                <button
                  key={ext.id}
                  type="button"
                  onClick={() => toggle(userId)}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 11,
                    padding: '9px 12px',
                    borderRadius: 10,
                    background: isChecked ? hexToRgba(GLASS.accent, 0.1) : 'transparent',
                    border: `1px solid ${isChecked ? hexToRgba(GLASS.accent, 0.28) : 'transparent'}`,
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.12s',
                    fontFamily: 'inherit',
                  }}
                  onMouseEnter={(e) => {
                    if (!isChecked) e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
                  }}
                  onMouseLeave={(e) => {
                    if (!isChecked) e.currentTarget.style.background = 'transparent';
                  }}
                >
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    <div style={avatar(34)}>{ext.display_name.charAt(0).toUpperCase()}</div>
                    <div
                      style={{
                        position: 'absolute',
                        bottom: 0,
                        right: 0,
                        width: 9,
                        height: 9,
                        borderRadius: '50%',
                        background: presenceColor,
                        border: '1.5px solid #131520',
                      }}
                    />
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontSize: '0.845rem',
                        fontWeight: 600,
                        color: GLASS.text,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {ext.display_name}
                    </div>
                    <div style={{ fontSize: '0.72rem', color: GLASS.textFaint }}>Ext {ext.extension}</div>
                  </div>

                  <div
                    style={{
                      width: 18,
                      height: 18,
                      borderRadius: 6,
                      border: `1.5px solid ${isChecked ? GLASS.accent : 'rgba(255,255,255,0.18)'}`,
                      background: isChecked ? GLASS.accent : 'transparent',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      transition: 'all 0.12s',
                    }}
                  >
                    {isChecked && <Check size={11} color="#fff" strokeWidth={3} />}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        style={{
          padding: '12px 16px',
          borderTop: '1px solid rgba(255,255,255,0.07)',
          display: 'flex',
          gap: 8,
          justifyContent: 'flex-end',
          flexShrink: 0,
        }}
      >
        <button type="button" onClick={onClose} style={secondaryBtn}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleInvite()}
          disabled={selected.size === 0 || submitting}
          style={{ ...primaryBtn, opacity: selected.size === 0 || submitting ? 0.55 : 1 }}
        >
          <UserPlus size={14} />
          {submitting ? 'Inviting...' : `Invite${selected.size > 0 ? ` (${selected.size})` : ''}`}
        </button>
      </div>
    </GlassModalShell>
  );
}
