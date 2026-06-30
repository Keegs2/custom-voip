/**
 * ScheduleModal — schedules a future session for a room. Wired to createSchedule.
 */

import { useState } from 'react';
import { Calendar, X } from 'lucide-react';
import { createSchedule } from '../../../api/conference';
import type { CreateSchedulePayload } from '../../../types/conference';
import { GLASS } from '../../../components/glass/glass';
import {
  inputStyle,
  primaryBtn,
  secondaryBtn,
  modalCloseBtn,
  modalIconBadge,
  errorBanner,
} from '../styles';
import { FormField } from './FormPrimitives';
import { GlassModalShell } from './GlassModalShell';

interface ScheduleModalProps {
  conferenceId: number;
  onClose: () => void;
  onCreated: () => void;
}

export function ScheduleModal({ conferenceId, onClose, onCreated }: ScheduleModalProps) {
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
    <GlassModalShell onClose={onClose} maxWidth={440}>
      <div
        style={{
          padding: '18px 20px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={modalIconBadge(32)}>
            <Calendar size={16} />
          </div>
          <span style={{ fontSize: '0.9rem', fontWeight: 700, color: GLASS.text }}>Schedule Session</span>
        </div>
        <button type="button" onClick={onClose} aria-label="Close" style={modalCloseBtn}>
          <X size={16} />
        </button>
      </div>

      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        {error && <div style={errorBanner}>{error}</div>}

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
          <button type="button" onClick={onClose} style={secondaryBtn}>
            Cancel
          </button>
          <button type="submit" disabled={loading} style={{ ...primaryBtn, opacity: loading ? 0.65 : 1 }}>
            {loading ? 'Saving...' : 'Schedule'}
          </button>
        </div>
      </form>
    </GlassModalShell>
  );
}
