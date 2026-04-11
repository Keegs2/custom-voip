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
} from '../api/conference';
import type {
  Conference,
  ConferenceLiveStatus,
  ConferenceSchedule,
  CreateConferencePayload,
  CreateSchedulePayload,
} from '../types/conference';

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
        padding: '10px 12px',
        borderRadius: 10,
        background: isSelected
          ? 'linear-gradient(135deg, rgba(59,130,246,0.14) 0%, rgba(59,130,246,0.07) 100%)'
          : 'transparent',
        border: isSelected
          ? '1px solid rgba(59,130,246,0.28)'
          : '1px solid transparent',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background 0.15s, border-color 0.15s',
        boxShadow: isSelected
          ? '0 2px 12px rgba(59,130,246,0.10)'
          : 'none',
      }}
      onMouseEnter={(e) => {
        if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.03)';
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
            fontSize: '0.85rem',
            fontWeight: 600,
            color: isSelected ? '#e2e8f0' : '#94a3b8',
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ fontSize: '0.75rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 4 }}>
              Invited members
            </div>
            {conf.participants.length === 0 ? (
              <div style={{ textAlign: 'center', padding: '36px 24px', color: '#334155', fontSize: '0.85rem' }}>
                No participants configured.
              </div>
            ) : (
              conf.participants.map((p) => (
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
                  }}
                >
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
                    {p.name.charAt(0).toUpperCase()}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: '0.875rem', fontWeight: 600, color: '#e2e8f0' }}>{p.name}</div>
                    <div style={{ fontSize: '0.73rem', color: '#475569' }}>Ext {p.extension}</div>
                  </div>
                  <div
                    style={{
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
                    }}
                  >
                    {p.role}
                  </div>
                </div>
              ))
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
            width: 320,
            flexShrink: 0,
            borderRight: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: '#131520',
          }}
        >
          {/* Panel header */}
          <div
            style={{
              padding: '20px 16px 14px',
              borderBottom: '1px solid rgba(255,255,255,0.06)',
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Video size={17} color="#60a5fa" strokeWidth={1.75} />
                <span style={{ fontSize: '0.95rem', fontWeight: 700, color: '#e2e8f0', letterSpacing: '-0.02em' }}>
                  Conferences
                </span>
              </div>
              <button
                type="button"
                onClick={() => setShowCreateModal(true)}
                title="Create conference room"
                style={{
                  width: 30,
                  height: 30,
                  borderRadius: 8,
                  background: 'rgba(59,130,246,0.14)',
                  border: '1px solid rgba(59,130,246,0.30)',
                  color: '#60a5fa',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'background 0.15s',
                }}
              >
                <Plus size={15} />
              </button>
            </div>
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
