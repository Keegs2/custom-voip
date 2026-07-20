/**
 * CreateRoomModal — creates a persistent meeting room (with a *88XX dial code).
 * Admins also pick the owning customer. Wired to the live createConference API.
 */

import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useAuth } from '../../../contexts/useAuth';
import { listCustomers } from '../../../api/customers';
import { createConference } from '../../../api/conference';
import type { Customer } from '../../../types/customer';
import type { Conference, CreateConferencePayload } from '../../../types/conference';
import { GLASS } from '../../../components/glass/glass';
import {
  inputStyle,
  primaryBtn,
  secondaryBtn,
  modalCloseBtn,
  modalIconBadge,
  errorBanner,
  spinner,
} from '../styles';
import { FormField, ToggleField } from './FormPrimitives';
import { GlassModalShell } from './GlassModalShell';

interface CreateRoomModalProps {
  onClose: () => void;
  onCreate: (conf: Conference) => void;
}

export function CreateRoomModal({ onClose, onCreate }: CreateRoomModalProps) {
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

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<number | ''>('');

  useEffect(() => {
    if (!isAdmin) return;
    setCustomersLoading(true);
    listCustomers({ limit: 500, status: 'active' })
      .then(({ items }) => {
        setCustomers(items);
        if (items.length > 0) setSelectedCustomerId(items[0].id);
      })
      .catch(() => setError('Failed to load customer list'))
      .finally(() => setCustomersLoading(false));
  }, [isAdmin]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Name is required');
      return;
    }
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
        ...(isAdmin && selectedCustomerId !== ''
          ? { customer_id: selectedCustomerId as number }
          : {}),
      };
      onCreate(await createConference(payload));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create meeting room');
    } finally {
      setLoading(false);
    }
  };

  return (
    <GlassModalShell onClose={onClose} maxWidth={480}>
      {/* Header */}
      <div
        style={{
          padding: '20px 24px 16px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
          <div style={modalIconBadge(36)}>
            <Plus size={18} />
          </div>
          <div>
            <div style={{ fontSize: '0.95rem', fontWeight: 700, color: GLASS.text }}>
              New Meeting Room
            </div>
            <div style={{ fontSize: '0.73rem', color: GLASS.textFaint }}>
              Creates a persistent room with a dial code
            </div>
          </div>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" style={modalCloseBtn}>
          <X size={18} />
        </button>
      </div>

      {/* Form */}
      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}
      >
        {error && <div style={errorBanner}>{error}</div>}

        {isAdmin && (
          <FormField label="Customer" required>
            {customersLoading ? (
              <div style={{ ...inputStyle, color: GLASS.textFaint, display: 'flex', alignItems: 'center', gap: 8 }}>
                <div style={spinner(14)} />
                Loading customers...
              </div>
            ) : (
              <select
                value={selectedCustomerId}
                onChange={(e) => setSelectedCustomerId(e.target.value === '' ? '' : Number(e.target.value))}
                style={{
                  ...inputStyle,
                  appearance: 'none',
                  backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
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
          <ToggleField label="Video Enabled" value={videoEnabled} onChange={setVideoEnabled} />
          <ToggleField label="Recording Enabled" value={recordingEnabled} onChange={setRecordingEnabled} />
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', paddingTop: 4 }}>
          <button type="button" onClick={onClose} style={secondaryBtn}>
            Cancel
          </button>
          <button type="submit" disabled={loading} style={{ ...primaryBtn, opacity: loading ? 0.65 : 1 }}>
            {loading ? 'Creating...' : 'Create Meeting Room'}
          </button>
        </div>
      </form>
    </GlassModalShell>
  );
}
