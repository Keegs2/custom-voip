/**
 * ConferencePage — full-screen conference management page.
 *
 * Layout:
 *   Sidebar | 320px left panel (room list) | Right detail panel
 *
 * The left panel lists all conference rooms with live status indicators.
 * The right panel shows details, live member list, moderator controls,
 * schedule, invited participants, and settings for the selected room.
 *
 * When the active call is to a conference room (*88XX), the ConferenceRoom
 * overlay is shown on top of this page.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  Video,
  Phone,
  Mic,
  MicOff,
  Users,
  Settings,
  Calendar,
  Plus,
  Play,
  PhoneOff,
  ChevronRight,
  Hash,
  Lock,
  Shield,
  Clock,
  Trash2,
  Edit2,
  Check,
  X,
  UserPlus,
  User,
} from 'lucide-react';
import { Sidebar } from '../components/layout/Sidebar';
import { SoftphoneWidget } from '../components/softphone/SoftphoneWidget';
import { ConferenceRoom } from '../components/conference/ConferenceRoom';
import { useSoftphone } from '../contexts/SoftphoneContext';
import { useAuth } from '../contexts/AuthContext';
import { listCustomers } from '../api/customers';
import type { Customer } from '../types/customer';
import {
  listConferences,
  createConference,
  updateConference,
  deleteConference,
  getConferenceLiveStatus,
  kickMember,
  muteMember,
  listSchedules,
  createSchedule,
  deleteSchedule,
  inviteParticipants,
  removeParticipant,
  listParticipants,
} from '../api/conference';
import { getDirectory } from '../api/extensions';
import type {
  Conference,
  ConferenceLiveStatus,
  ConferenceParticipant,
  ConferenceSchedule,
  CreateConferencePayload,
  CreateSchedulePayload,
} from '../types/conference';
import type { Extension } from '../types/softphone';

/* ─── Keyframes ──────────────────────────────────────────── */

const GLOBAL_STYLES = `
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes confPulse {
    0%, 100% { opacity: 0.7; transform: scale(1); }
    50%       { opacity: 1;   transform: scale(1.05); }
  }
  @keyframes liveGlow {
    0%, 100% { box-shadow: 0 0 0 2px rgba(34,197,94,0.15); }
    50%       { box-shadow: 0 0 0 4px rgba(34,197,94,0.30); }
  }
`;

/* ─── Helpers ────────────────────────────────────────────── */

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/* ─── Room list item ─────────────────────────────────────── */

interface RoomListItemProps {
  conf: Conference;
  liveStatus: ConferenceLiveStatus | null;
  isSelected: boolean;
  onClick: () => void;
}

function RoomListItem({ conf, liveStatus, isSelected, onClick }: RoomListItemProps) {
  const isActive = liveStatus?.is_active ?? false;
  const memberCount = liveStatus?.members.length ?? 0;

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 14px',
        borderRadius: 8,
        background: isSelected
          ? 'linear-gradient(135deg, rgba(59,130,246,0.16) 0%, rgba(59,130,246,0.08) 100%)'
          : 'transparent',
        border: 'none',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 0.15s, color 0.15s',
      }}
      onMouseEnter={(e) => {
        if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
      }}
      onMouseLeave={(e) => {
        if (!isSelected) e.currentTarget.style.background = 'transparent';
      }}
    >
      {/* Icon with live indicator */}
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            background: isActive
              ? 'linear-gradient(135deg, rgba(34,197,94,0.20) 0%, rgba(34,197,94,0.10) 100%)'
              : 'linear-gradient(135deg, rgba(59,130,246,0.15) 0%, rgba(99,102,241,0.10) 100%)',
            border: isActive
              ? '1px solid rgba(34,197,94,0.30)'
              : '1px solid rgba(59,130,246,0.20)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: isActive ? '#22c55e' : '#60a5fa',
            animation: isActive ? 'liveGlow 2s ease-in-out infinite' : 'none',
          }}
        >
          <Video size={17} strokeWidth={1.75} />
        </div>
        {/* Live dot */}
        {isActive && (
          <div
            style={{
              position: 'absolute',
              top: -2,
              right: -2,
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: '#22c55e',
              border: '2px solid #0c0e16',
              animation: 'confPulse 2s ease-in-out infinite',
            }}
          />
        )}
      </div>

      {/* Name + meta */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: '0.825rem',
            fontWeight: isSelected ? 700 : 500,
            color: isSelected ? '#e2e8f0' : '#64748b',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            letterSpacing: '-0.01em',
          }}
        >
          {conf.name}
        </div>
        <div style={{ fontSize: '0.72rem', color: '#334155', marginTop: 1 }}>
          *88{conf.room_number}
          {isActive && (
            <span style={{ color: '#22c55e', fontWeight: 600, marginLeft: 6 }}>
              {memberCount} live
            </span>
          )}
        </div>
      </div>

      {isSelected && (
        <ChevronRight size={14} color="#3b82f6" />
      )}
    </button>
  );
}

/* ─── Create room modal ──────────────────────────────────── */

interface CreateRoomModalProps {
  onClose: () => void;
  onCreate: (conf: Conference) => void;
}

function CreateRoomModal({ onClose, onCreate }: CreateRoomModalProps) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';

  const [name, setName] = useState('');
  const [maxMembers, setMaxMembers] = useState(25);
  const [pin, setPin] = useState('');
  const [modPin, setModPin] = useState('');
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [recordingEnabled, setRecordingEnabled] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Admin-only: customer selector state
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | ''>('');

  // Fetch customer list when the modal opens for an admin
  useEffect(() => {
    if (!isAdmin) return;
    setCustomersLoading(true);
    listCustomers({ limit: 500, status: 'active' })
      .then(({ items }) => {
        setCustomers(items);
        // Pre-select the first customer so the dropdown isn't blank
        if (items.length > 0) setSelectedCustomerId(items[0].id);
      })
      .catch(() => {
        setError('Failed to load customer list');
      })
      .finally(() => {
        setCustomersLoading(false);
      });
  }, [isAdmin]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) { setError('Name is required'); return; }
    if (isAdmin && selectedCustomerId === '') {
      setError('Please select a customer');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload: CreateConferencePayload = {
        name: name.trim(),
        max_members: maxMembers,
        pin: pin.trim() || null,
        moderator_pin: modPin.trim() || null,
        video_enabled: videoEnabled,
        recording_enabled: recordingEnabled,
        ...(isAdmin && selectedCustomerId !== '' ? { customer_id: selectedCustomerId as number } : {}),
      };
      const conf = await createConference(payload);
      onCreate(conf);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create conference');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(6px)',
        zIndex: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 480,
          background: '#131520',
          borderRadius: 16,
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px 16px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 9,
                background: 'linear-gradient(135deg, rgba(59,130,246,0.20) 0%, rgba(59,130,246,0.10) 100%)',
                border: '1px solid rgba(59,130,246,0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#60a5fa',
              }}
            >
              <Plus size={18} />
            </div>
            <div>
              <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#e2e8f0' }}>
                New Conference Room
              </div>
              <div style={{ fontSize: '0.73rem', color: '#475569' }}>
                Creates a persistent room with a dial code
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', padding: 4 }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={(e) => void handleSubmit(e)} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {error && (
            <div style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8, color: '#ef4444', fontSize: '0.8rem' }}>
              {error}
            </div>
          )}

          {/* Admin-only: customer selector */}
          {isAdmin && (
            <FormField label="Customer" required>
              {customersLoading ? (
                <div style={{ ...inputStyle, color: '#475569', display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div
                    style={{
                      width: 14,
                      height: 14,
                      border: '2px solid rgba(59,130,246,0.15)',
                      borderTopColor: '#3b82f6',
                      borderRadius: '50%',
                      animation: 'spin 0.8s linear infinite',
                      flexShrink: 0,
                    }}
                  />
                  Loading customers...
                </div>
              ) : (
                <select
                  value={selectedCustomerId}
                  onChange={(e) => setSelectedCustomerId(e.target.value === '' ? '' : Number(e.target.value))}
                  style={{
                    ...inputStyle,
                    // Native selects need explicit appearance reset in dark themes
                    appearance: 'none',
                    backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2364748b' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
                    backgroundRepeat: 'no-repeat',
                    backgroundPosition: 'right 10px center',
                    paddingRight: 30,
                    cursor: 'pointer',
                  }}
                >
                  {customers.length === 0 ? (
                    <option value="">No active customers found</option>
                  ) : (
                    customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))
                  )}
                </select>
              )}
            </FormField>
          )}

          <FormField label="Room Name" required>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekly Standup"
              style={inputStyle}
              autoFocus
            />
          </FormField>

          <FormField label="Max Participants">
            <input
              type="number"
              value={maxMembers}
              onChange={(e) => setMaxMembers(Math.max(2, parseInt(e.target.value) || 25))}
              min={2}
              max={500}
              style={inputStyle}
            />
          </FormField>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <FormField label="Room PIN (optional)">
              <input
                value={pin}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
                placeholder="Digits only"
                maxLength={12}
                style={inputStyle}
              />
            </FormField>
            <FormField label="Moderator PIN (optional)">
              <input
                value={modPin}
                onChange={(e) => setModPin(e.target.value.replace(/\D/g, ''))}
                placeholder="Digits only"
                maxLength={12}
                style={inputStyle}
              />
            </FormField>
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <ToggleField
              label="Video Enabled"
              value={videoEnabled}
              onChange={setVideoEnabled}
            />
            <ToggleField
              label="Recording Enabled"
              value={recordingEnabled}
              onChange={setRecordingEnabled}
            />
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 4 }}>
            <button
              type="button"
              onClick={onClose}
              style={secondaryBtn}
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              style={{
                ...primaryBtn,
                opacity: loading ? 0.65 : 1,
              }}
            >
              {loading ? 'Creating...' : 'Create Room'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Schedule modal ─────────────────────────────────────── */

interface ScheduleModalProps {
  conferenceId: number;
  onClose: () => void;
  onCreated: () => void;
}

function ScheduleModal({ conferenceId, onClose, onCreated }: ScheduleModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !startTime || !endTime) {
      setError('Title, start time, and end time are required');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const payload: CreateSchedulePayload = {
        title: title.trim(),
        description: description.trim() || null,
        start_time: new Date(startTime).toISOString(),
        end_time: new Date(endTime).toISOString(),
      };
      await createSchedule(conferenceId, payload);
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to schedule session');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(6px)',
        zIndex: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 440,
          background: '#131520',
          borderRadius: 16,
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '18px 20px 14px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Calendar size={16} color="#60a5fa" />
            <span style={{ fontSize: '0.9rem', fontWeight: 700, color: '#e2e8f0' }}>
              Schedule Session
            </span>
          </div>
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', padding: 4 }}>
            <X size={16} />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {error && (
            <div style={{ padding: '8px 12px', background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.25)', borderRadius: 8, color: '#ef4444', fontSize: '0.78rem' }}>
              {error}
            </div>
          )}

          <FormField label="Title" required>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Q1 Planning" style={inputStyle} autoFocus />
          </FormField>

          <FormField label="Description (optional)">
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Brief description..."
              rows={2}
              style={{ ...inputStyle, resize: 'none', height: 'auto' }}
            />
          </FormField>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <FormField label="Start Time" required>
              <input type="datetime-local" value={startTime} onChange={(e) => setStartTime(e.target.value)} style={inputStyle} />
            </FormField>
            <FormField label="End Time" required>
              <input type="datetime-local" value={endTime} onChange={(e) => setEndTime(e.target.value)} style={inputStyle} />
            </FormField>
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 4 }}>
            <button type="button" onClick={onClose} style={secondaryBtn}>Cancel</button>
            <button type="submit" disabled={loading} style={{ ...primaryBtn, opacity: loading ? 0.65 : 1 }}>
              {loading ? 'Saving...' : 'Schedule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ─── Invite participants modal ──────────────────────────── */

interface InviteParticipantsModalProps {
  conferenceId: number;
  /** User IDs already in the conference — excluded from the picker */
  existingUserIds: Set<number>;
  onClose: () => void;
  onInvited: () => void;
}

function InviteParticipantsModal({
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

  // Fetch directory on mount
  useEffect(() => {
    setLoading(true);
    getDirectory()
      .then((exts) => {
        // Only show extensions that have a linked user and are not already participants
        setDirectory(
          exts.filter(
            (e) => e.user_id !== null && !existingUserIds.has(e.user_id),
          ),
        );
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
      if (next.has(userId)) {
        next.delete(userId);
      } else {
        next.add(userId);
      }
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

  const spinnerStyle: React.CSSProperties = {
    width: 20,
    height: 20,
    border: '2px solid rgba(59,130,246,0.15)',
    borderTopColor: '#3b82f6',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  };

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(6px)',
        zIndex: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 480,
          maxHeight: '80vh',
          background: '#131520',
          borderRadius: 16,
          border: '1px solid rgba(255,255,255,0.08)',
          boxShadow: '0 24px 64px rgba(0,0,0,0.6)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 20px 14px',
            borderBottom: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                background: 'linear-gradient(135deg, rgba(59,130,246,0.20) 0%, rgba(59,130,246,0.10) 100%)',
                border: '1px solid rgba(59,130,246,0.28)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#60a5fa',
              }}
            >
              <UserPlus size={16} />
            </div>
            <div>
              <div style={{ fontSize: '0.9rem', fontWeight: 700, color: '#e2e8f0' }}>
                Invite Participants
              </div>
              <div style={{ fontSize: '0.72rem', color: '#475569' }}>
                {selected.size === 0
                  ? 'Select people to invite'
                  : `${selected.size} selected`}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: '#475569', cursor: 'pointer', padding: 4 }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Search + role selector */}
        <div
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid rgba(255,255,255,0.05)',
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
            style={{
              ...inputStyle,
              padding: '7px 11px',
            }}
          />
          {/* Role toggle */}
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
                  padding: '5px 12px',
                  borderRadius: 6,
                  border: role === r
                    ? '1px solid rgba(59,130,246,0.40)'
                    : '1px solid rgba(255,255,255,0.07)',
                  background: role === r
                    ? 'rgba(59,130,246,0.12)'
                    : 'rgba(255,255,255,0.03)',
                  color: role === r ? '#93c5fd' : '#64748b',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  transition: 'all 0.15s',
                  textTransform: 'capitalize',
                }}
              >
                {r === 'moderator' ? <Shield size={12} /> : <User size={12} />}
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* User list */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
          {error && (
            <div
              style={{
                margin: '6px 8px',
                padding: '8px 12px',
                background: 'rgba(239,68,68,0.10)',
                border: '1px solid rgba(239,68,68,0.25)',
                borderRadius: 8,
                color: '#ef4444',
                fontSize: '0.78rem',
              }}
            >
              {error}
            </div>
          )}

          {loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
              <div style={spinnerStyle} />
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '28px 16px', color: '#334155', fontSize: '0.83rem' }}>
              {search ? 'No users match your search.' : 'All users are already participants.'}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {filtered.map((ext) => {
                const userId = ext.user_id as number;
                const isChecked = selected.has(userId);
                const presenceColor =
                  ext.presence_status === 'available' ? '#22c55e'
                  : ext.presence_status === 'busy' ? '#ef4444'
                  : ext.presence_status === 'away' ? '#f59e0b'
                  : '#334155';

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
                      borderRadius: 9,
                      background: isChecked
                        ? 'rgba(59,130,246,0.09)'
                        : 'transparent',
                      border: isChecked
                        ? '1px solid rgba(59,130,246,0.25)'
                        : '1px solid transparent',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 0.12s',
                    }}
                    onMouseEnter={(e) => {
                      if (!isChecked) e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
                    }}
                    onMouseLeave={(e) => {
                      if (!isChecked) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    {/* Avatar with presence dot */}
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <div
                        style={{
                          width: 34,
                          height: 34,
                          borderRadius: '50%',
                          background: 'linear-gradient(135deg, rgba(59,130,246,0.22) 0%, rgba(99,102,241,0.22) 100%)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '0.88rem',
                          fontWeight: 700,
                          color: '#818cf8',
                        }}
                      >
                        {ext.display_name.charAt(0).toUpperCase()}
                      </div>
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

                    {/* Name + extension */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: '0.845rem',
                          fontWeight: 600,
                          color: '#e2e8f0',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {ext.display_name}
                      </div>
                      <div style={{ fontSize: '0.72rem', color: '#475569' }}>
                        Ext {ext.extension}
                      </div>
                    </div>

                    {/* Checkbox */}
                    <div
                      style={{
                        width: 18,
                        height: 18,
                        borderRadius: 5,
                        border: isChecked
                          ? '1.5px solid #3b82f6'
                          : '1.5px solid rgba(255,255,255,0.15)',
                        background: isChecked ? '#3b82f6' : 'transparent',
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
            borderTop: '1px solid rgba(255,255,255,0.06)',
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
            style={{
              ...primaryBtn,
              opacity: selected.size === 0 || submitting ? 0.55 : 1,
            }}
          >
            <UserPlus size={14} />
            {submitting ? 'Inviting...' : `Invite${selected.size > 0 ? ` (${selected.size})` : ''}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Shared form UI primitives ──────────────────────────── */

function FormField({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <label style={{ fontSize: '0.75rem', fontWeight: 600, color: '#64748b', letterSpacing: '0.02em' }}>
        {label}{required && <span style={{ color: '#ef4444', marginLeft: 2 }}>*</span>}
      </label>
      {children}
    </div>
  );
}

function ToggleField({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 12px',
        borderRadius: 8,
        background: value ? 'rgba(59,130,246,0.08)' : 'rgba(255,255,255,0.03)',
        border: `1px solid ${value ? 'rgba(59,130,246,0.25)' : 'rgba(255,255,255,0.07)'}`,
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'all 0.15s',
      }}
      onClick={() => onChange(!value)}
    >
      <div
        style={{
          width: 28,
          height: 16,
          borderRadius: 8,
          background: value ? '#3b82f6' : 'rgba(255,255,255,0.12)',
          position: 'relative',
          transition: 'background 0.2s',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 2,
            left: value ? 14 : 2,
            width: 12,
            height: 12,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left 0.2s',
            boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
          }}
        />
      </div>
      <span style={{ fontSize: '0.78rem', fontWeight: 500, color: value ? '#93c5fd' : '#64748b' }}>
        {label}
      </span>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.04)',
  border: '1px solid rgba(255,255,255,0.09)',
  color: '#e2e8f0',
  fontSize: '0.85rem',
  outline: 'none',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s',
};

const primaryBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 7,
  padding: '8px 18px',
  borderRadius: 8,
  background: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)',
  border: 'none',
  color: '#fff',
  fontSize: '0.85rem',
  fontWeight: 600,
  cursor: 'pointer',
  boxShadow: '0 2px 12px rgba(59,130,246,0.35)',
};

const secondaryBtn: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '8px 16px',
  borderRadius: 8,
  background: 'rgba(255,255,255,0.05)',
  border: '1px solid rgba(255,255,255,0.09)',
  color: '#94a3b8',
  fontSize: '0.85rem',
  fontWeight: 500,
  cursor: 'pointer',
};

/* ─── Detail panel tabs ──────────────────────────────────── */

type DetailTab = 'live' | 'schedule' | 'participants' | 'settings';

/* ─── Detail panel ───────────────────────────────────────── */

interface DetailPanelProps {
  conf: Conference;
  onJoin: (conf: Conference) => void;
  onRefresh: () => void;
  onDelete: (id: number) => void;
}

function DetailPanel({ conf, onJoin, onRefresh, onDelete }: DetailPanelProps) {
  const [activeTab, setActiveTab] = useState<DetailTab>('live');
  const [liveStatus, setLiveStatus] = useState<ConferenceLiveStatus | null>(null);
  const [schedules, setSchedules] = useState<ConferenceSchedule[]>([]);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [participants, setParticipants] = useState<ConferenceParticipant[]>(conf.participants ?? []);
  const [participantsLoading, setParticipantsLoading] = useState(false);
  const [participantError, setParticipantError] = useState<string | null>(null);
  const [editingSettings, setEditingSettings] = useState(false);
  const [settingsName, setSettingsName] = useState(conf.name);
  const [settingsMaxMembers, setSettingsMaxMembers] = useState(conf.max_members);
  const [settingsPin, setSettingsPin] = useState(conf.pin ?? '');
  const [settingsModPin, setSettingsModPin] = useState(conf.moderator_pin ?? '');
  const [settingsVideo, setSettingsVideo] = useState(conf.video_enabled);
  const [settingsRecording, setSettingsRecording] = useState(conf.recording_enabled);
  const [saving, setSaving] = useState(false);
  const [liveError, setLiveError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  /* ── Live status polling ──────────────────────────────── */

  const fetchLiveStatus = useCallback(async () => {
    try {
      const status = await getConferenceLiveStatus(conf.id);
      setLiveStatus(status);
      setLiveError(null);
    } catch {
      setLiveError('Could not fetch live status');
    }
  }, [conf.id]);

  useEffect(() => {
    void fetchLiveStatus();
    if (activeTab === 'live') {
      pollRef.current = setInterval(() => void fetchLiveStatus(), 4_000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchLiveStatus, activeTab]);

  /* ── Schedule load ──────────────────────────────────────── */

  const loadSchedules = useCallback(async () => {
    try {
      const list = await listSchedules(conf.id);
      setSchedules(list);
    } catch {
      // Ignore
    }
  }, [conf.id]);

  useEffect(() => {
    if (activeTab === 'schedule') void loadSchedules();
  }, [activeTab, loadSchedules]);

  /* ── Participants load ──────────────────────────────────── */

  const loadParticipants = useCallback(async () => {
    setParticipantsLoading(true);
    setParticipantError(null);
    try {
      const list = await listParticipants(conf.id);
      setParticipants(list);
    } catch {
      setParticipantError('Failed to load participants');
    } finally {
      setParticipantsLoading(false);
    }
  }, [conf.id]);

  useEffect(() => {
    if (activeTab === 'participants') void loadParticipants();
  }, [activeTab, loadParticipants]);

  const handleRemoveParticipant = async (userId: number) => {
    try {
      await removeParticipant(conf.id, userId);
      // Optimistic removal — then sync from server
      setParticipants((prev) => prev.filter((p) => p.user_id !== userId));
    } catch {
      setParticipantError('Failed to remove participant');
    }
  };

  /* ── Settings save ──────────────────────────────────────── */

  const handleSaveSettings = async () => {
    setSaving(true);
    try {
      await updateConference(conf.id, {
        name: settingsName.trim(),
        max_members: settingsMaxMembers,
        pin: settingsPin.trim() || null,
        moderator_pin: settingsModPin.trim() || null,
        video_enabled: settingsVideo,
        recording_enabled: settingsRecording,
      });
      onRefresh();
      setEditingSettings(false);
    } catch {
      // Silently fail — the parent will reload
    } finally {
      setSaving(false);
    }
  };

  /* ── Moderator actions ──────────────────────────────────── */

  const handleKick = async (memberId: number) => {
    try {
      await kickMember(conf.id, memberId);
      await fetchLiveStatus();
    } catch { /* Ignore */ }
  };

  const handleMute = async (memberId: number) => {
    try {
      await muteMember(conf.id, memberId);
      await fetchLiveStatus();
    } catch { /* Ignore */ }
  };

  const dialCode = `*88${conf.room_number}`;

  const tabs: { id: DetailTab; label: string; icon: React.ReactNode }[] = [
    { id: 'live',         label: 'Live',         icon: <Play size={13} /> },
    { id: 'schedule',     label: 'Schedule',     icon: <Calendar size={13} /> },
    { id: 'participants', label: 'Participants',  icon: <Users size={13} /> },
    { id: 'settings',     label: 'Settings',     icon: <Settings size={13} /> },
  ];

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
        background: '#0f1117',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '20px 28px 0',
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          flexShrink: 0,
          background: '#0f1117',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16 }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
              {liveStatus?.is_active && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '2px 8px',
                    borderRadius: 20,
                    background: 'rgba(34,197,94,0.12)',
                    border: '1px solid rgba(34,197,94,0.30)',
                    animation: 'liveGlow 2s ease-in-out infinite',
                  }}
                >
                  <div
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: '50%',
                      background: '#22c55e',
                      animation: 'confPulse 1.5s ease-in-out infinite',
                    }}
                  />
                  <span style={{ fontSize: '0.65rem', fontWeight: 700, color: '#22c55e', letterSpacing: '0.06em' }}>
                    LIVE · {liveStatus.members.length} IN ROOM
                  </span>
                </div>
              )}
            </div>

            <h1
              style={{
                fontSize: '1.4rem',
                fontWeight: 800,
                color: '#f1f5f9',
                letterSpacing: '-0.03em',
                lineHeight: 1.2,
                margin: 0,
              }}
            >
              {conf.name}
            </h1>

            {/* Room meta */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#475569', fontSize: '0.8rem' }}>
                <Hash size={13} />
                <span>Dial <span style={{ color: '#60a5fa', fontWeight: 700, fontFamily: 'monospace' }}>{dialCode}</span></span>
              </div>
              {conf.pin && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#475569', fontSize: '0.8rem' }}>
                  <Lock size={12} />
                  <span>PIN required</span>
                </div>
              )}
              {conf.moderator_pin && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#475569', fontSize: '0.8rem' }}>
                  <Shield size={12} />
                  <span>Moderator PIN</span>
                </div>
              )}
              <div style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#475569', fontSize: '0.8rem' }}>
                <Users size={12} />
                <span>Max {conf.max_members}</span>
              </div>
            </div>
          </div>

          {/* Join button */}
          <button
            type="button"
            onClick={() => onJoin(conf)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 20px',
              borderRadius: 10,
              background: 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)',
              border: 'none',
              color: '#fff',
              fontSize: '0.875rem',
              fontWeight: 700,
              cursor: 'pointer',
              boxShadow: '0 4px 18px rgba(59,130,246,0.40)',
              letterSpacing: '-0.01em',
              flexShrink: 0,
              transition: 'opacity 0.15s, transform 0.12s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.opacity = '0.9'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.opacity = '1'; }}
          >
            <Phone size={15} />
            Join Conference
          </button>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', gap: 2 }}>
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 14px',
                borderRadius: '8px 8px 0 0',
                background: activeTab === tab.id
                  ? '#0f1117'
                  : 'transparent',
                border: activeTab === tab.id
                  ? '1px solid rgba(255,255,255,0.08)'
                  : '1px solid transparent',
                borderBottom: activeTab === tab.id
                  ? '1px solid #0f1117'
                  : '1px solid transparent',
                color: activeTab === tab.id ? '#e2e8f0' : '#475569',
                fontSize: '0.8rem',
                fontWeight: activeTab === tab.id ? 600 : 500,
                cursor: 'pointer',
                transition: 'color 0.15s',
                marginBottom: -1,
              }}
            >
              {tab.icon}
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px' }}>

        {/* ── Live tab ─────────────────────────────────────── */}
        {activeTab === 'live' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {liveError && (
              <div style={{ padding: '10px 14px', background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.20)', borderRadius: 8, color: '#f87171', fontSize: '0.8rem' }}>
                {liveError}
              </div>
            )}

            {!liveStatus?.is_active ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, paddingTop: 48, paddingBottom: 48 }}>
                <div
                  style={{
                    width: 64,
                    height: 64,
                    borderRadius: 18,
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.07)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#334155',
                  }}
                >
                  <Video size={28} strokeWidth={1.5} />
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.95rem', fontWeight: 600, color: '#475569', marginBottom: 5 }}>
                    Room is empty
                  </div>
                  <div style={{ fontSize: '0.8rem', color: '#334155', lineHeight: 1.6 }}>
                    Dial <span style={{ color: '#60a5fa', fontFamily: 'monospace', fontWeight: 700 }}>{dialCode}</span> from your softphone, or share the dial code with others.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onJoin(conf)}
                  style={primaryBtn}
                >
                  <Phone size={14} />
                  Join Now
                </button>
              </div>
            ) : (
              <div>
                {/* Recording status */}
                {liveStatus.recording && (
                  <div
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '4px 12px',
                      borderRadius: 20,
                      background: 'rgba(239,68,68,0.10)',
                      border: '1px solid rgba(239,68,68,0.25)',
                      marginBottom: 16,
                    }}
                  >
                    <div
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: '#ef4444',
                        animation: 'confPulse 1.5s ease-in-out infinite',
                      }}
                    />
                    <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#ef4444', letterSpacing: '0.06em' }}>
                      RECORDING
                    </span>
                  </div>
                )}

                {/* Member grid */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
                    Members in room
                  </div>
                  {liveStatus.members.map((m) => (
                    <div
                      key={m.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '10px 14px',
                        borderRadius: 10,
                        background: m.talking
                          ? 'rgba(59,130,246,0.07)'
                          : 'rgba(255,255,255,0.02)',
                        border: m.talking
                          ? '1px solid rgba(59,130,246,0.20)'
                          : '1px solid rgba(255,255,255,0.05)',
                        transition: 'all 0.2s',
                      }}
                    >
                      {/* Avatar */}
                      <div
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: '50%',
                          background: 'linear-gradient(135deg, rgba(59,130,246,0.25) 0%, rgba(99,102,241,0.25) 100%)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: '0.9rem',
                          fontWeight: 700,
                          color: '#818cf8',
                          flexShrink: 0,
                          border: m.talking ? '1.5px solid #3b82f6' : '1.5px solid transparent',
                        }}
                      >
                        {m.name.charAt(0).toUpperCase()}
                      </div>

                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '0.875rem', fontWeight: 600, color: '#e2e8f0' }}>{m.name}</div>
                        {m.talking && <div style={{ fontSize: '0.72rem', color: '#22c55e', fontWeight: 500 }}>Speaking</div>}
                      </div>

                      {/* Badges */}
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        {m.muted && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 5, background: 'rgba(239,68,68,0.10)', border: '1px solid rgba(239,68,68,0.20)' }}>
                            <MicOff size={11} color="#ef4444" />
                            <span style={{ fontSize: '0.65rem', color: '#ef4444', fontWeight: 600 }}>Muted</span>
                          </div>
                        )}
                        {m.video && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 5, background: 'rgba(59,130,246,0.10)', border: '1px solid rgba(59,130,246,0.20)' }}>
                            <Video size={11} color="#60a5fa" />
                            <span style={{ fontSize: '0.65rem', color: '#60a5fa', fontWeight: 600 }}>Video</span>
                          </div>
                        )}
                      </div>

                      {/* Moderator actions */}
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button
                          type="button"
                          onClick={() => void handleMute(m.id)}
                          title={m.muted ? 'Unmute' : 'Mute'}
                          style={{
                            width: 30,
                            height: 30,
                            borderRadius: 7,
                            background: 'rgba(255,255,255,0.04)',
                            border: '1px solid rgba(255,255,255,0.08)',
                            color: '#64748b',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {m.muted ? <Mic size={13} /> : <MicOff size={13} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleKick(m.id)}
                          title="Remove from conference"
                          style={{
                            width: 30,
                            height: 30,
                            borderRadius: 7,
                            background: 'rgba(239,68,68,0.06)',
                            border: '1px solid rgba(239,68,68,0.15)',
                            color: '#ef4444',
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <PhoneOff size={13} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── Schedule tab ─────────────────────────────────── */}
        {activeTab === 'schedule' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#64748b' }}>
                Upcoming sessions
              </div>
              <button
                type="button"
                onClick={() => setShowScheduleModal(true)}
                style={{ ...primaryBtn, fontSize: '0.8rem', padding: '7px 14px' }}
              >
                <Plus size={13} />
                Schedule
              </button>
            </div>

            {schedules.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '36px 24px', color: '#334155', fontSize: '0.85rem' }}>
                No sessions scheduled yet.
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {schedules.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 12,
                      padding: '14px 16px',
                      borderRadius: 10,
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.06)',
                    }}
                  >
                    <div
                      style={{
                        width: 36,
                        height: 36,
                        borderRadius: 9,
                        background: 'rgba(59,130,246,0.10)',
                        border: '1px solid rgba(59,130,246,0.20)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        color: '#60a5fa',
                        flexShrink: 0,
                      }}
                    >
                      <Calendar size={16} />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: '0.875rem', fontWeight: 600, color: '#e2e8f0' }}>{s.title}</div>
                      {s.description && (
                        <div style={{ fontSize: '0.78rem', color: '#64748b', marginTop: 2 }}>{s.description}</div>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                        <Clock size={11} color="#475569" />
                        <span style={{ fontSize: '0.73rem', color: '#475569' }}>
                          {formatDate(s.start_time)} · {formatTime(s.start_time)} – {formatTime(s.end_time)}
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={async () => {
                        await deleteSchedule(conf.id, s.id);
                        await loadSchedules();
                      }}
                      style={{
                        background: 'none',
                        border: 'none',
                        color: '#475569',
                        cursor: 'pointer',
                        padding: 4,
                        borderRadius: 6,
                        display: 'flex',
                        alignItems: 'center',
                      }}
                      title="Delete schedule"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Participants tab ──────────────────────────────── */}
        {activeTab === 'participants' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {/* Section header with Invite button */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#64748b' }}>
                Invited members
              </div>
              <button
                type="button"
                onClick={() => setShowInviteModal(true)}
                style={{ ...primaryBtn, fontSize: '0.8rem', padding: '7px 14px' }}
              >
                <UserPlus size={13} />
                Invite
              </button>
            </div>

            {participantError && (
              <div
                style={{
                  padding: '8px 12px',
                  background: 'rgba(239,68,68,0.08)',
                  border: '1px solid rgba(239,68,68,0.20)',
                  borderRadius: 8,
                  color: '#f87171',
                  fontSize: '0.78rem',
                }}
              >
                {participantError}
              </div>
            )}

            {participantsLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
                <div
                  style={{
                    width: 22,
                    height: 22,
                    border: '2px solid rgba(59,130,246,0.15)',
                    borderTopColor: '#3b82f6',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
              </div>
            ) : participants.length === 0 ? (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 12,
                  padding: '36px 24px',
                }}
              >
                <div
                  style={{
                    width: 52,
                    height: 52,
                    borderRadius: 14,
                    background: 'rgba(255,255,255,0.03)',
                    border: '1px solid rgba(255,255,255,0.07)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: '#334155',
                  }}
                >
                  <Users size={22} strokeWidth={1.5} />
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '0.875rem', fontWeight: 600, color: '#475569', marginBottom: 4 }}>
                    No participants yet
                  </div>
                  <div style={{ fontSize: '0.78rem', color: '#334155' }}>
                    Invite people to give them quick access to this room.
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setShowInviteModal(true)}
                  style={{ ...primaryBtn, fontSize: '0.8rem', padding: '7px 14px' }}
                >
                  <UserPlus size={13} />
                  Invite Someone
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {participants.map((p) => (
                  <div
                    key={p.user_id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 14px',
                      borderRadius: 10,
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.05)',
                      transition: 'background 0.12s',
                    }}
                  >
                    {/* Avatar */}
                    <div
                      style={{
                        width: 34,
                        height: 34,
                        borderRadius: '50%',
                        background: 'linear-gradient(135deg, rgba(59,130,246,0.20) 0%, rgba(99,102,241,0.20) 100%)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: '0.85rem',
                        fontWeight: 700,
                        color: '#818cf8',
                        flexShrink: 0,
                      }}
                    >
                      {(p.user_name ?? '?').charAt(0).toUpperCase()}
                    </div>

                    {/* Name + extension */}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div
                        style={{
                          fontSize: '0.875rem',
                          fontWeight: 600,
                          color: '#e2e8f0',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {p.user_name ?? p.user_email ?? 'Unknown'}
                      </div>
                      <div style={{ fontSize: '0.73rem', color: '#475569' }}>
                        {p.extension ? `Ext ${p.extension}` : p.user_email ?? ''}
                      </div>
                    </div>

                    {/* Role badge */}
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                        padding: '2px 8px',
                        borderRadius: 5,
                        background: p.role === 'moderator'
                          ? 'rgba(59,130,246,0.12)'
                          : 'rgba(255,255,255,0.04)',
                        border: p.role === 'moderator'
                          ? '1px solid rgba(59,130,246,0.25)'
                          : '1px solid rgba(255,255,255,0.07)',
                        fontSize: '0.68rem',
                        fontWeight: 700,
                        color: p.role === 'moderator' ? '#60a5fa' : '#475569',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        flexShrink: 0,
                      }}
                    >
                      {p.role === 'moderator'
                        ? <Shield size={10} />
                        : <User size={10} />}
                      {p.role}
                    </div>

                    {/* Remove button */}
                    <button
                      type="button"
                      title="Remove participant"
                      onClick={() => void handleRemoveParticipant(p.user_id)}
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 7,
                        background: 'rgba(239,68,68,0.06)',
                        border: '1px solid rgba(239,68,68,0.15)',
                        color: '#64748b',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        flexShrink: 0,
                        transition: 'all 0.12s',
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = 'rgba(239,68,68,0.14)';
                        e.currentTarget.style.color = '#ef4444';
                        e.currentTarget.style.borderColor = 'rgba(239,68,68,0.35)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.background = 'rgba(239,68,68,0.06)';
                        e.currentTarget.style.color = '#64748b';
                        e.currentTarget.style.borderColor = 'rgba(239,68,68,0.15)';
                      }}
                    >
                      <X size={13} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Settings tab ─────────────────────────────────── */}
        {activeTab === 'settings' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 560 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#64748b' }}>
                Room configuration
              </div>
              {!editingSettings ? (
                <button
                  type="button"
                  onClick={() => setEditingSettings(true)}
                  style={secondaryBtn}
                >
                  <Edit2 size={13} />
                  Edit
                </button>
              ) : (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    onClick={() => setEditingSettings(false)}
                    style={secondaryBtn}
                  >
                    <X size={13} />
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSaveSettings()}
                    disabled={saving}
                    style={{ ...primaryBtn, opacity: saving ? 0.65 : 1 }}
                  >
                    <Check size={13} />
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                </div>
              )}
            </div>

            {editingSettings ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <FormField label="Room Name" required>
                  <input value={settingsName} onChange={(e) => setSettingsName(e.target.value)} style={inputStyle} />
                </FormField>
                <FormField label="Max Participants">
                  <input type="number" value={settingsMaxMembers} onChange={(e) => setSettingsMaxMembers(parseInt(e.target.value) || 25)} min={2} max={500} style={inputStyle} />
                </FormField>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <FormField label="Room PIN (optional)">
                    <input value={settingsPin} onChange={(e) => setSettingsPin(e.target.value.replace(/\D/g, ''))} placeholder="Leave empty for no PIN" style={inputStyle} />
                  </FormField>
                  <FormField label="Moderator PIN (optional)">
                    <input value={settingsModPin} onChange={(e) => setSettingsModPin(e.target.value.replace(/\D/g, ''))} placeholder="Leave empty for no PIN" style={inputStyle} />
                  </FormField>
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                  <ToggleField label="Video Enabled" value={settingsVideo} onChange={setSettingsVideo} />
                  <ToggleField label="Recording Enabled" value={settingsRecording} onChange={setSettingsRecording} />
                </div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {[
                  { label: 'Room Name',       value: conf.name },
                  { label: 'Dial Code',        value: dialCode },
                  { label: 'Max Participants', value: String(conf.max_members) },
                  { label: 'Room PIN',         value: conf.pin ?? 'None' },
                  { label: 'Moderator PIN',    value: conf.moderator_pin ?? 'None' },
                  { label: 'Video',            value: conf.video_enabled ? 'Enabled' : 'Disabled' },
                  { label: 'Recording',        value: conf.recording_enabled ? 'Enabled' : 'Disabled' },
                  { label: 'Status',           value: conf.status },
                  { label: 'Created',          value: formatDateTime(conf.created_at) },
                ].map(({ label, value }) => (
                  <div
                    key={label}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      padding: '10px 14px',
                      borderRadius: 8,
                      background: 'rgba(255,255,255,0.02)',
                      border: '1px solid rgba(255,255,255,0.05)',
                    }}
                  >
                    <span style={{ flex: 1, fontSize: '0.8rem', color: '#64748b', fontWeight: 500 }}>{label}</span>
                    <span style={{ fontSize: '0.85rem', color: '#cbd5e1', fontWeight: 600, fontFamily: label === 'Dial Code' ? 'monospace' : 'inherit' }}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Danger zone */}
            <div
              style={{
                marginTop: 12,
                padding: '16px 18px',
                borderRadius: 10,
                background: 'rgba(239,68,68,0.04)',
                border: '1px solid rgba(239,68,68,0.15)',
              }}
            >
              <div style={{ fontSize: '0.78rem', fontWeight: 700, color: '#ef4444', marginBottom: 10, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                Danger Zone
              </div>
              <div style={{ fontSize: '0.8rem', color: '#64748b', marginBottom: 12 }}>
                Permanently delete this conference room. All schedules and participant assignments will be lost.
              </div>
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`Delete "${conf.name}"? This cannot be undone.`)) {
                    void deleteConference(conf.id).then(() => onDelete(conf.id));
                  }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '7px 14px',
                  borderRadius: 7,
                  background: 'rgba(239,68,68,0.10)',
                  border: '1px solid rgba(239,68,68,0.25)',
                  color: '#ef4444',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                <Trash2 size={13} />
                Delete Conference Room
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Schedule modal */}
      {showScheduleModal && (
        <ScheduleModal
          conferenceId={conf.id}
          onClose={() => setShowScheduleModal(false)}
          onCreated={async () => {
            setShowScheduleModal(false);
            await loadSchedules();
          }}
        />
      )}

      {/* Invite participants modal */}
      {showInviteModal && (
        <InviteParticipantsModal
          conferenceId={conf.id}
          existingUserIds={new Set(participants.map((p) => p.user_id))}
          onClose={() => setShowInviteModal(false)}
          onInvited={() => {
            setShowInviteModal(false);
            void loadParticipants();
          }}
        />
      )}
    </div>
  );
}

/* ─── Empty right panel ──────────────────────────────────── */

function EmptyDetail() {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        background: '#0f1117',
        padding: 48,
      }}
    >
      <div
        style={{
          width: 80,
          height: 80,
          borderRadius: 22,
          background: 'linear-gradient(135deg, rgba(59,130,246,0.12) 0%, rgba(129,140,248,0.08) 100%)',
          border: '1px solid rgba(59,130,246,0.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#3b82f6',
          animation: 'confPulse 3s ease-in-out infinite',
        }}
      >
        <Video size={36} strokeWidth={1.5} />
      </div>
      <div style={{ textAlign: 'center', maxWidth: 280 }}>
        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: '#64748b', marginBottom: 7, letterSpacing: '-0.02em' }}>
          Select a conference room
        </div>
        <div style={{ fontSize: '0.82rem', color: '#334155', lineHeight: 1.65 }}>
          Pick a room from the list to see live status, schedule sessions, and manage participants.
        </div>
      </div>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────── */

export function ConferencePage() {
  const { makeCall, activeCall } = useSoftphone();

  const [conferences, setConferences] = useState<Conference[]>([]);
  const [liveStatuses, setLiveStatuses] = useState<Map<number, ConferenceLiveStatus>>(new Map());
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);

  /* ── Conference room overlay state ──────────────────────── */
  // If the active call destination matches *88XX and we have a selected room
  const isInConference = activeCall !== null &&
    activeCall.state === 'active' &&
    activeCall.remoteNumber.startsWith('*88') &&
    selectedId !== null;

  const activeConference = selectedId !== null
    ? conferences.find((c) => c.id === selectedId) ?? null
    : null;

  /* ── Load conferences ────────────────────────────────────── */

  const loadConferences = useCallback(async () => {
    try {
      const list = await listConferences();
      setConferences(list);
      setLoadError(null);
      // Auto-select first if nothing selected
      if (selectedId === null && list.length > 0) {
        setSelectedId(list[0].id);
      }
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load conferences');
    } finally {
      setIsLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void loadConferences();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Poll live statuses for all rooms ───────────────────── */

  const pollLiveStatuses = useCallback(async () => {
    if (conferences.length === 0) return;
    const results = await Promise.allSettled(
      conferences.map((c) => getConferenceLiveStatus(c.id).then((s) => ({ id: c.id, s }))),
    );
    const newMap = new Map<number, ConferenceLiveStatus>();
    for (const r of results) {
      if (r.status === 'fulfilled') {
        newMap.set(r.value.id, r.value.s);
      }
    }
    setLiveStatuses(newMap);
  }, [conferences]);

  useEffect(() => {
    void pollLiveStatuses();
    const timer = setInterval(() => void pollLiveStatuses(), 5_000);
    return () => clearInterval(timer);
  }, [pollLiveStatuses]);

  /* ── Join handler ────────────────────────────────────────── */

  const handleJoin = useCallback(async (conf: Conference) => {
    // Ensure the conference is selected BEFORE dialing so that when the call
    // transitions to 'active', isInConference is true and the overlay renders.
    setSelectedId(conf.id);

    const dialCode = `*88${conf.room_number}`;
    await makeCall(dialCode, { video: conf.video_enabled });
  }, [makeCall]);

  /* ── Created / deleted ───────────────────────────────────── */

  const handleCreated = useCallback((conf: Conference) => {
    setConferences((prev) => [...prev, conf]);
    setSelectedId(conf.id);
    setShowCreateModal(false);
  }, []);

  const handleDeleted = useCallback((id: number) => {
    setConferences((prev) => prev.filter((c) => c.id !== id));
    setSelectedId((prev) => (prev === id ? null : prev));
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        width: '100vw',
        overflow: 'hidden',
        background: '#0f1117',
      }}
    >
      <style>{GLOBAL_STYLES}</style>

      {/* Fixed sidebar */}
      <Sidebar />

      {/* Main shell */}
      <div
        style={{
          marginLeft: 240,
          flex: 1,
          display: 'flex',
          overflow: 'hidden',
          height: '100vh',
        }}
      >
        {/* Left panel — room list */}
        <div
          style={{
            width: 280,
            flexShrink: 0,
            borderRight: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: '#0c0e16',
          }}
        >
          {/* Panel header */}
          <div
            style={{
              padding: '18px 16px 12px',
              borderBottom: '1px solid rgba(255,255,255,0.05)',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
              Conferences
            </span>
            <button
              type="button"
              onClick={() => setShowCreateModal(true)}
              title="Create conference room"
              style={{
                background: 'rgba(59,130,246,0.12)',
                border: '1px solid rgba(59,130,246,0.25)',
                borderRadius: 7,
                cursor: 'pointer',
                color: '#60a5fa',
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                padding: '5px 9px',
                fontSize: '0.72rem',
                fontWeight: 600,
                transition: 'background 0.15s',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(59,130,246,0.20)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'rgba(59,130,246,0.12)'; }}
            >
              <Plus size={13} strokeWidth={2} />
              New
            </button>
          </div>

          {/* Room list */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
            {isLoading ? (
              <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
                <div
                  style={{
                    width: 24,
                    height: 24,
                    border: '2px solid rgba(59,130,246,0.15)',
                    borderTopColor: '#3b82f6',
                    borderRadius: '50%',
                    animation: 'spin 0.8s linear infinite',
                  }}
                />
              </div>
            ) : loadError ? (
              <div style={{ padding: 16, color: '#ef4444', fontSize: '0.8rem', textAlign: 'center' }}>
                {loadError}
              </div>
            ) : conferences.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center' }}>
                <div style={{ color: '#334155', fontSize: '0.85rem', marginBottom: 12 }}>
                  No conference rooms yet
                </div>
                <button
                  type="button"
                  onClick={() => setShowCreateModal(true)}
                  style={{ ...primaryBtn, fontSize: '0.8rem', padding: '7px 14px' }}
                >
                  <Plus size={13} />
                  Create Room
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                {conferences.map((conf) => (
                  <RoomListItem
                    key={conf.id}
                    conf={conf}
                    liveStatus={liveStatuses.get(conf.id) ?? null}
                    isSelected={selectedId === conf.id}
                    onClick={() => setSelectedId(conf.id)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right panel */}
        {activeConference ? (
          <DetailPanel
            key={activeConference.id}
            conf={activeConference}
            onJoin={(conf) => void handleJoin(conf)}
            onRefresh={() => void loadConferences()}
            onDelete={handleDeleted}
          />
        ) : (
          <EmptyDetail />
        )}
      </div>

      {/* Softphone overlay */}
      <SoftphoneWidget />

      {/* Conference room full-screen overlay */}
      {isInConference && activeConference && (
        <ConferenceRoom
          conferenceId={activeConference.id}
          conferenceName={activeConference.name}
          roomNumber={activeConference.room_number}
          isModerator={true}
        />
      )}

      {/* Create modal */}
      {showCreateModal && (
        <CreateRoomModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreated}
        />
      )}
    </div>
  );
}
