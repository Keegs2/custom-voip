/**
 * DetailPanel — the right-hand room detail: header (live badge, dial code, join),
 * a tab bar, and the Live / Schedule / Participants / Settings tabs. Data, polling
 * and mutations live in `useDetailPanel`; this component is presentation + wiring.
 *
 * React #310: all hooks (the panel hook + local UI state) sit at the very top.
 */

import { useState } from 'react';
import {
  Video, Phone, Mic, MicOff, Users, Settings, Calendar, Plus, Play, PhoneOff,
  Hash, Lock, Shield, Clock, Trash2, Edit2, Check, X, UserPlus, User,
} from 'lucide-react';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import { GlassSheen, GlassChip } from '../../../components/glass/GlassCard';
import { deleteConference } from '../../../api/conference';
import type { Conference } from '../../../types/conference';
import type { DetailTab } from '../types';
import { useDetailPanel } from '../hooks';
import { formatDateTime, formatTime, formatDate, dialCodeFor } from '../helpers';
import {
  panelShell,
  primaryBtn,
  secondaryBtn,
  dangerBtn,
  inputStyle,
  spinner,
  joinBtn,
  tabBtn,
  sectionLabel,
  uppercaseLabel,
  listRow,
  iconTile,
  smallIconBtn,
  avatar,
  livePill,
  recordingPill,
  pulseDot,
  softIcon,
  errorBanner,
  monoAccent,
} from '../styles';
import { FormField, ToggleField } from './FormPrimitives';
import { ScheduleModal } from './ScheduleModal';
import { InviteParticipantsModal } from './InviteParticipantsModal';

interface DetailPanelProps {
  conf: Conference;
  onJoin: (conf: Conference) => void;
  onRefresh: () => void;
  onDelete: (id: number) => void;
}

const TABS: { id: DetailTab; label: string; icon: React.ReactNode }[] = [
  { id: 'live', label: 'Live', icon: <Play size={13} /> },
  { id: 'schedule', label: 'Schedule', icon: <Calendar size={13} /> },
  { id: 'participants', label: 'Participants', icon: <Users size={13} /> },
  { id: 'settings', label: 'Settings', icon: <Settings size={13} /> },
];

export function DetailPanel({ conf, onJoin, onRefresh, onDelete }: DetailPanelProps) {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const panel = useDetailPanel(conf, onRefresh);
  const [showScheduleModal, setShowScheduleModal] = useState(false);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [joinHover, setJoinHover] = useState(false);

  const {
    activeTab, setActiveTab, liveStatus, liveError, schedules, loadSchedules, removeSchedule,
    participants, participantsLoading, participantError, loadParticipants, handleRemoveParticipant,
    editingSettings, setEditingSettings, settingsName, setSettingsName, settingsMaxMembers,
    setSettingsMaxMembers, settingsPin, setSettingsPin, settingsModPin, setSettingsModPin,
    settingsVideo, setSettingsVideo, settingsRecording, setSettingsRecording, saving,
    handleSaveSettings, handleKick, handleMute,
  } = panel;

  const dialCode = dialCodeFor(conf.room_number);

  return (
    <div style={{ ...panelShell(), flex: 1 }}>
      <GlassSheen />
      <div style={{ position: 'relative', zIndex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%' }}>
        {/* ── Header ──────────────────────────────────────────────────────── */}
        <div style={{ padding: '24px 28px 0', borderBottom: '1px solid rgba(255,255,255,0.07)', flexShrink: 0 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18, gap: 16 }}>
            <div>
              {liveStatus?.is_active && (
                <div style={{ marginBottom: 8 }}>
                  <span style={livePill}>
                    <span style={pulseDot(GLASS.success)} />
                    <span style={{ fontSize: '0.65rem', fontWeight: 700, color: GLASS.success, letterSpacing: '0.06em' }}>
                      LIVE · {liveStatus.members.length} IN MEETING
                    </span>
                  </span>
                </div>
              )}

              <h1 style={{ fontSize: '1.45rem', fontWeight: 800, color: GLASS.text, letterSpacing: '-0.03em', lineHeight: 1.2, margin: 0 }}>
                {conf.name}
              </h1>

              <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginTop: 10, flexWrap: 'wrap' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: GLASS.textMuted, fontSize: '0.8rem' }}>
                  <Hash size={13} />
                  Dial <span style={monoAccent}>{dialCode}</span>
                </span>
                {conf.pin && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: GLASS.textMuted, fontSize: '0.8rem' }}>
                    <Lock size={12} /> PIN required
                  </span>
                )}
                {conf.moderator_pin && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: GLASS.textMuted, fontSize: '0.8rem' }}>
                    <Shield size={12} /> Moderator PIN
                  </span>
                )}
                <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: GLASS.textMuted, fontSize: '0.8rem' }}>
                  <Users size={12} /> Max {conf.max_members}
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => onJoin(conf)}
              onMouseEnter={() => setJoinHover(true)}
              onMouseLeave={() => setJoinHover(false)}
              style={joinBtn(joinHover)}
            >
              <Phone size={15} />
              Join Meeting
            </button>
          </div>

          {/* Tab bar */}
          <div style={{ display: 'flex', gap: 6, paddingBottom: 14 }}>
            {TABS.map((tab) => (
              <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)} style={tabBtn(activeTab === tab.id)}>
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── Tab content ─────────────────────────────────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px', minHeight: 0 }}>
          {/* Live */}
          {activeTab === 'live' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
              {liveError && <div style={errorBanner}>{liveError}</div>}

              {!liveStatus?.is_active ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, padding: '48px 0' }}>
                  <div style={softIcon()}>
                    <Video size={28} strokeWidth={1.5} />
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '0.95rem', fontWeight: 600, color: GLASS.text, marginBottom: 6 }}>
                      Meeting room is empty
                    </div>
                    <div style={{ fontSize: '0.82rem', color: GLASS.textMuted, lineHeight: 1.6, maxWidth: 360 }}>
                      Dial <span style={monoAccent}>{dialCode}</span> from your softphone, or click "Join Now" to join instantly.
                    </div>
                  </div>
                  <button type="button" onClick={() => onJoin(conf)} style={primaryBtn}>
                    <Phone size={14} />
                    Join Now
                  </button>
                </div>
              ) : (
                <div>
                  {liveStatus.recording && (
                    <div style={{ marginBottom: 16 }}>
                      <span style={recordingPill}>
                        <span style={pulseDot(GLASS.danger, 7)} />
                        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: GLASS.danger, letterSpacing: '0.06em' }}>
                          RECORDING
                        </span>
                      </span>
                    </div>
                  )}

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <div style={{ ...uppercaseLabel, marginBottom: 2 }}>Members in meeting</div>
                    {liveStatus.members.map((m) => (
                      <div key={m.id} style={listRow(m.talking)}>
                        <div style={{ ...avatar(36), border: m.talking ? `1.5px solid ${GLASS.accent}` : '1.5px solid transparent' }}>
                          {m.name.charAt(0).toUpperCase()}
                        </div>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '0.875rem', fontWeight: 600, color: GLASS.text }}>{m.name}</div>
                          {m.talking && <div style={{ fontSize: '0.72rem', color: GLASS.success, fontWeight: 500 }}>Speaking</div>}
                        </div>
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          {m.muted && <GlassChip label="Muted" color={GLASS.danger} icon={<MicOff size={11} />} />}
                          {m.video && <GlassChip label="Video" color={GLASS.accent} icon={<Video size={11} />} />}
                        </div>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button type="button" onClick={() => void handleMute(m.id)} title={m.muted ? 'Unmute' : 'Mute'} style={smallIconBtn()}>
                            {m.muted ? <Mic size={13} /> : <MicOff size={13} />}
                          </button>
                          <button type="button" onClick={() => void handleKick(m.id)} title="Remove from meeting" style={smallIconBtn('danger')}>
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

          {/* Schedule */}
          {activeTab === 'schedule' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={sectionLabel}>Upcoming sessions</div>
                <button type="button" onClick={() => setShowScheduleModal(true)} style={{ ...primaryBtn, fontSize: '0.8rem', padding: '8px 14px' }}>
                  <Plus size={13} />
                  Schedule
                </button>
              </div>

              {schedules.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '36px 24px', color: GLASS.textMuted, fontSize: '0.85rem' }}>
                  No sessions scheduled yet.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {schedules.map((s) => (
                    <div key={s.id} style={{ ...listRow(), alignItems: 'flex-start' }}>
                      <div style={iconTile(36)}>
                        <Calendar size={16} />
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '0.875rem', fontWeight: 600, color: GLASS.text }}>{s.title}</div>
                        {s.description && <div style={{ fontSize: '0.78rem', color: GLASS.textMuted, marginTop: 2 }}>{s.description}</div>}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                          <Clock size={11} color={GLASS.textFaint} />
                          <span style={{ fontSize: '0.73rem', color: GLASS.textFaint }}>
                            {formatDate(s.start_time)} · {formatTime(s.start_time)} – {formatTime(s.end_time)}
                          </span>
                        </div>
                      </div>
                      <button type="button" onClick={() => void removeSchedule(s.id)} title="Delete schedule" style={smallIconBtn()}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Participants */}
          {activeTab === 'participants' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={sectionLabel}>Invited members</div>
                <button type="button" onClick={() => setShowInviteModal(true)} style={{ ...primaryBtn, fontSize: '0.8rem', padding: '8px 14px' }}>
                  <UserPlus size={13} />
                  Invite
                </button>
              </div>

              {participantError && <div style={errorBanner}>{participantError}</div>}

              {participantsLoading ? (
                <div style={{ display: 'flex', justifyContent: 'center', padding: 32 }}>
                  <div style={spinner(22)} />
                </div>
              ) : participants.length === 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14, padding: '36px 24px' }}>
                  <div style={softIcon()}>
                    <Users size={22} strokeWidth={1.5} />
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <div style={{ fontSize: '0.875rem', fontWeight: 600, color: GLASS.text, marginBottom: 4 }}>No participants yet</div>
                    <div style={{ fontSize: '0.78rem', color: GLASS.textMuted }}>Invite people to give them quick access to this room.</div>
                  </div>
                  <button type="button" onClick={() => setShowInviteModal(true)} style={{ ...primaryBtn, fontSize: '0.8rem', padding: '8px 14px' }}>
                    <UserPlus size={13} />
                    Invite Someone
                  </button>
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {participants.map((p) => (
                    <div key={p.user_id} style={listRow()}>
                      <div style={avatar(34)}>{(p.user_name ?? '?').charAt(0).toUpperCase()}</div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '0.875rem', fontWeight: 600, color: GLASS.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {p.user_name ?? p.user_email ?? 'Unknown'}
                        </div>
                        <div style={{ fontSize: '0.73rem', color: GLASS.textFaint }}>
                          {p.extension ? `Ext ${p.extension}` : p.user_email ?? ''}
                        </div>
                      </div>
                      <GlassChip
                        label={p.role}
                        color={p.role === 'moderator' ? GLASS.accent : GLASS.textMuted}
                        icon={p.role === 'moderator' ? <Shield size={10} /> : <User size={10} />}
                      />
                      <button type="button" title="Remove participant" onClick={() => void handleRemoveParticipant(p.user_id)} style={smallIconBtn('danger')}>
                        <X size={13} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Settings */}
          {activeTab === 'settings' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 20, maxWidth: 580 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div style={sectionLabel}>Meeting room configuration</div>
                {!editingSettings ? (
                  <button type="button" onClick={() => setEditingSettings(true)} style={secondaryBtn}>
                    <Edit2 size={13} />
                    Edit
                  </button>
                ) : (
                  <div style={{ display: 'flex', gap: 8 }}>
                    <button type="button" onClick={() => setEditingSettings(false)} style={secondaryBtn}>
                      <X size={13} />
                      Cancel
                    </button>
                    <button type="button" onClick={() => void handleSaveSettings()} disabled={saving} style={{ ...primaryBtn, opacity: saving ? 0.65 : 1 }}>
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
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {[
                    { label: 'Room Name', value: conf.name },
                    { label: 'Dial Code', value: dialCode },
                    { label: 'Max Participants', value: String(conf.max_members) },
                    { label: 'Room PIN', value: conf.pin ?? 'None' },
                    { label: 'Moderator PIN', value: conf.moderator_pin ?? 'None' },
                    { label: 'Video', value: conf.video_enabled ? 'Enabled' : 'Disabled' },
                    { label: 'Recording', value: conf.recording_enabled ? 'Enabled' : 'Disabled' },
                    { label: 'Status', value: conf.status },
                    { label: 'Created', value: formatDateTime(conf.created_at) },
                  ].map(({ label, value }) => (
                    <div
                      key={label}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        padding: '11px 14px',
                        borderRadius: 10,
                        background: 'rgba(255,255,255,0.03)',
                        border: '1px solid rgba(255,255,255,0.06)',
                      }}
                    >
                      <span style={{ flex: 1, fontSize: '0.8rem', color: GLASS.textMuted, fontWeight: 500 }}>{label}</span>
                      <span style={{ fontSize: '0.85rem', color: GLASS.text, fontWeight: 600, fontFamily: label === 'Dial Code' ? 'ui-monospace, monospace' : 'inherit' }}>
                        {value}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Danger zone */}
              <div style={{ marginTop: 8, padding: '16px 18px', borderRadius: 12, background: hexToRgba(GLASS.danger, 0.04), border: `1px solid ${hexToRgba(GLASS.danger, 0.15)}` }}>
                <div style={{ fontSize: '0.78rem', fontWeight: 700, color: GLASS.danger, marginBottom: 10, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
                  Danger Zone
                </div>
                <div style={{ fontSize: '0.8rem', color: GLASS.textMuted, marginBottom: 12 }}>
                  Permanently delete this meeting room. All schedules and participant assignments will be lost.
                </div>
                <button
                  type="button"
                  onClick={() => {
                    if (window.confirm(`Delete "${conf.name}"? This cannot be undone.`)) {
                      void deleteConference(conf.id).then(() => onDelete(conf.id));
                    }
                  }}
                  style={dangerBtn}
                >
                  <Trash2 size={13} />
                  Delete Meeting Room
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modals */}
      {showScheduleModal && (
        <ScheduleModal
          conferenceId={conf.id}
          onClose={() => setShowScheduleModal(false)}
          onCreated={() => {
            setShowScheduleModal(false);
            loadSchedules();
          }}
        />
      )}

      {showInviteModal && (
        <InviteParticipantsModal
          conferenceId={conf.id}
          existingUserIds={new Set(participants.map((p) => p.user_id))}
          onClose={() => setShowInviteModal(false)}
          onInvited={() => {
            setShowInviteModal(false);
            loadParticipants();
          }}
        />
      )}
    </div>
  );
}
