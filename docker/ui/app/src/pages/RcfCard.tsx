import { useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RcfEntry } from '../types/rcf';
import { apiRequest } from '../api/client';
import { updateRcfEntry } from '../api/rcf';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import { useAuth } from '../contexts/AuthContext';
import { fmt } from '../utils/format';

interface RcfCardProps {
  entry: RcfEntry;
  /** Controlled edit value from parent's pendingEdits state */
  pendingValue: string;
  onPendingChange: (did: string, value: string) => void;
}

async function updateRcfForwardTo(did: string, forward_to: string): Promise<RcfEntry> {
  return apiRequest('PUT', `/rcf/${encodeURIComponent(did)}`, { forward_to });
}

async function updateRcfEnabled(id: number, enabled: boolean): Promise<RcfEntry> {
  return apiRequest('PATCH', `/rcf/${id}`, { enabled });
}

// ─── CardEnableToggle ─────────────────────────────────────────────────────────

function CardEnableToggle({
  entry,
  canEdit,
}: {
  entry: RcfEntry;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const mutation = useMutation({
    mutationFn: (enabled: boolean) => updateRcfEnabled(entry.id, enabled),
    onSuccess: (_, enabled) => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      toastOk(enabled ? `${fmt(entry.did)} enabled` : `${fmt(entry.did)} disabled`);
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to update'),
  });

  const enabled = entry.enabled;
  const pending = mutation.isPending;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={!canEdit || pending}
        onClick={() => { if (canEdit && !pending) mutation.mutate(!enabled); }}
        title={canEdit ? (enabled ? 'Click to disable' : 'Click to enable') : undefined}
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          width: 40,
          height: 22,
          borderRadius: 11,
          border: `1px solid ${enabled ? 'rgba(59,130,246,0.55)' : 'rgba(255,255,255,0.12)'}`,
          background: enabled
            ? 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)'
            : 'rgba(255,255,255,0.06)',
          cursor: canEdit && !pending ? 'pointer' : 'not-allowed',
          transition: 'background 0.22s ease, border-color 0.22s ease, box-shadow 0.22s',
          opacity: pending ? 0.55 : 1,
          flexShrink: 0,
          padding: 0,
          outline: 'none',
          boxShadow: enabled ? '0 0 10px rgba(59,130,246,0.38)' : 'none',
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: enabled ? 20 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
            transition: 'left 0.22s ease',
          }}
        />
      </button>
      <span
        style={{
          fontSize: '0.72rem',
          fontWeight: 700,
          color: enabled ? '#60a5fa' : '#475569',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          transition: 'color 0.2s',
        }}
      >
        {pending ? '…' : enabled ? 'Active' : 'Disabled'}
      </span>
    </div>
  );
}

// ─── RcfNameField ─────────────────────────────────────────────────────────────

function RcfNameField({
  entry,
  canEdit,
}: {
  entry: RcfEntry;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const { toastErr } = useToast();

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.name ?? '');

  // Sync when external data changes (only when not actively editing)
  const [prevName, setPrevName] = useState(entry.name);
  if (entry.name !== prevName) {
    setPrevName(entry.name);
    if (!editing) setValue(entry.name ?? '');
  }

  const mutation = useMutation({
    mutationFn: (name: string | null) => updateRcfEntry(entry.id, { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      setEditing(false);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleSave() {
    const trimmed = value.trim();
    const newName = trimmed === '' ? null : trimmed;
    const currentName = entry.name ?? null;
    if (newName === currentName) { setEditing(false); return; }
    mutation.mutate(newName);
  }

  function handleCancel() {
    setValue(entry.name ?? '');
    setEditing(false);
  }

  if (!canEdit) {
    if (!entry.name) return null;
    return (
      <div
        style={{
          fontSize: '1rem',
          fontWeight: 700,
          color: '#e2e8f0',
          letterSpacing: '-0.01em',
          marginBottom: 4,
          lineHeight: 1.3,
        }}
      >
        {entry.name}
      </div>
    );
  }

  if (editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
            if (e.key === 'Escape') handleCancel();
          }}
          onBlur={handleCancel}
          disabled={mutation.isPending}
          autoFocus
          placeholder="Add label..."
          style={{
            flex: 1,
            minWidth: 80,
            fontSize: '0.95rem',
            fontWeight: 700,
            color: '#e2e8f0',
            letterSpacing: '-0.01em',
            lineHeight: 1.3,
            background: 'rgba(15,17,23,0.85)',
            border: '1px solid rgba(59,130,246,0.55)',
            borderRadius: 7,
            outline: 'none',
            padding: '4px 9px',
            fontFamily: 'inherit',
            opacity: mutation.isPending ? 0.5 : 1,
            boxShadow: '0 0 0 3px rgba(59,130,246,0.12)',
          }}
        />
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
          disabled={mutation.isPending}
          style={{
            fontSize: '0.65rem',
            fontWeight: 700,
            padding: '5px 11px',
            borderRadius: 5,
            border: 'none',
            background: mutation.isPending
              ? 'rgba(59,130,246,0.3)'
              : 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
            color: '#fff',
            cursor: mutation.isPending ? 'not-allowed' : 'pointer',
            flexShrink: 0,
            lineHeight: 1,
            opacity: mutation.isPending ? 0.6 : 1,
          }}
        >
          {mutation.isPending ? '…' : 'Save'}
        </button>
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); handleCancel(); }}
          style={{
            fontSize: '0.65rem',
            fontWeight: 500,
            padding: '5px 9px',
            borderRadius: 5,
            border: 'none',
            background: 'transparent',
            color: '#718096',
            cursor: 'pointer',
            flexShrink: 0,
            lineHeight: 1,
          }}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div
      onClick={() => setEditing(true)}
      title="Click to set a name for this number"
      style={{
        display: 'block',
        width: '100%',
        fontSize: value.trim() ? '0.95rem' : '0.82rem',
        fontWeight: value.trim() ? 700 : 400,
        color: value.trim() ? '#e2e8f0' : '#3b4560',
        fontStyle: value.trim() ? 'normal' : 'italic',
        letterSpacing: value.trim() ? '-0.01em' : 'normal',
        lineHeight: 1.3,
        padding: '3px 0',
        cursor: 'pointer',
        marginBottom: 4,
        borderBottom: '1px dashed rgba(59,130,246,0.22)',
      }}
    >
      {value.trim() || 'Add label...'}
    </div>
  );
}

// ─── RcfCard ──────────────────────────────────────────────────────────────────

export function RcfCard({ entry, pendingValue, onPendingChange }: RcfCardProps) {
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const { user } = useAuth();
  const canEdit = user?.role !== 'readonly';

  const [savedFlash, setSavedFlash] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [fwdFocused, setFwdFocused] = useState(false);

  const isDirty = pendingValue !== entry.forward_to && pendingValue !== '';
  const isEmpty = pendingValue.trim() === '';

  const mutation = useMutation({
    mutationFn: (newValue: string) => updateRcfForwardTo(entry.did, newValue.trim()),
    onSuccess: (_data, newValue) => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      onPendingChange(entry.did, newValue.trim());
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
      toastOk(`Saved — calls to ${fmt(entry.did)} now ring ${fmt(newValue.trim())}`);
    },
    onError: (error: Error) => toastErr(error.message ?? 'Failed to save'),
  });

  const handleSave = useCallback(() => {
    const trimmed = pendingValue.trim();
    if (!trimmed) {
      toastErr('Destination cannot be empty');
      return;
    }
    mutation.mutate(trimmed);
  }, [pendingValue, mutation, toastErr]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') handleSave();
    },
    [handleSave],
  );

  return (
    <div
      style={{
        position: 'relative',
        background: 'rgba(19, 21, 29, 0.72)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        border: `1px solid ${
          savedFlash
            ? 'rgba(59,130,246,0.5)'
            : hovered
            ? 'rgba(59,130,246,0.30)'
            : 'rgba(59,130,246,0.12)'
        }`,
        borderRadius: 18,
        padding: '24px 24px 22px',
        overflow: 'hidden',
        transition: 'border-color 0.25s ease, box-shadow 0.25s ease',
        boxShadow: hovered
          ? '0 0 0 1px rgba(59,130,246,0.14), 0 16px 40px -10px rgba(0,0,0,0.55)'
          : savedFlash
          ? '0 0 20px rgba(59,130,246,0.25), 0 4px 20px rgba(0,0,0,0.35)'
          : '0 4px 20px -4px rgba(0,0,0,0.4)',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Top accent line — animates brighter on hover and save */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 28,
          right: 28,
          height: 2,
          background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.75), transparent)',
          opacity: savedFlash ? 1 : hovered ? 0.7 : 0.25,
          transition: 'opacity 0.25s ease',
          borderRadius: '0 0 2px 2px',
        }}
      />

      {/* Card header: name (editable) + DID + enable toggle */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 20,
        }}
      >
        <div style={{ minWidth: 0, flex: 1 }}>
          {/* Editable name label */}
          <RcfNameField entry={entry} canEdit={canEdit} />

          {/* Customer label for admin multi-customer view */}
          {entry.customer_name && user?.role === 'admin' && (
            <div
              style={{
                fontSize: '0.68rem',
                fontWeight: 600,
                color: '#3b82f6',
                opacity: 0.7,
                marginBottom: 6,
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              {entry.customer_name}
            </div>
          )}

          {/* DID — prominent monospace */}
          <div
            style={{
              fontSize: '1.15rem',
              fontWeight: 700,
              color: '#e2e8f0',
              lineHeight: 1.25,
              fontFamily: 'monospace',
              letterSpacing: '0.02em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {fmt(entry.did)}
          </div>
          <div
            style={{
              fontSize: '0.68rem',
              fontFamily: 'monospace',
              color: '#334155',
              marginTop: 3,
              letterSpacing: '0.01em',
            }}
          >
            {entry.did}
          </div>
        </div>

        {/* Enable toggle — top right */}
        <div style={{ flexShrink: 0, marginTop: 2 }}>
          <CardEnableToggle entry={entry} canEdit={canEdit} />
        </div>
      </div>

      {/* Forward-to field */}
      <div>
        <label
          htmlFor={`rcf-fwd-${entry.id}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            fontSize: '0.62rem',
            fontWeight: 700,
            color: '#475569',
            textTransform: 'uppercase',
            letterSpacing: '0.1em',
            marginBottom: 8,
          }}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ width: 11, height: 11, color: '#3b82f6', opacity: 0.7 }}
          >
            <path d="M14 10c0 .74-.16 1.44-.45 2.07C12.8 13.8 11.01 15 9 15H3a2 2 0 0 1-2-2V3a2 2 0 0 1 2-2h1.5" />
            <path d="M14 6V2h-4" />
            <path d="M10 6 14 2" />
          </svg>
          Forward Calls To
        </label>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            id={`rcf-fwd-${entry.id}`}
            type="tel"
            value={pendingValue}
            placeholder="+1XXXXXXXXXX"
            onChange={(e) => onPendingChange(entry.did, e.target.value)}
            onKeyDown={handleKeyDown}
            onFocus={() => setFwdFocused(true)}
            onBlur={() => setFwdFocused(false)}
            disabled={mutation.isPending || !canEdit}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: '0.9rem',
              padding: '9px 13px',
              borderRadius: 9,
              fontFamily: 'monospace',
              letterSpacing: '0.02em',
              border: `1px solid ${
                savedFlash
                  ? 'rgba(59,130,246,0.6)'
                  : isDirty || fwdFocused
                  ? 'rgba(59,130,246,0.5)'
                  : 'rgba(59,130,246,0.15)'
              }`,
              background: 'rgba(15,17,23,0.75)',
              color: '#e2e8f0',
              outline: 'none',
              transition: 'border-color 0.2s, box-shadow 0.2s',
              boxShadow: savedFlash
                ? '0 0 0 3px rgba(59,130,246,0.18)'
                : isDirty || fwdFocused
                ? '0 0 0 3px rgba(59,130,246,0.12)'
                : 'none',
              opacity: mutation.isPending || !canEdit ? 0.6 : 1,
            }}
          />

          {canEdit && (
            <button
              type="button"
              disabled={!isDirty || isEmpty || mutation.isPending}
              onClick={handleSave}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 5,
                fontSize: '0.75rem',
                fontWeight: 700,
                padding: '9px 16px',
                borderRadius: 9,
                border: 'none',
                background:
                  isDirty && !isEmpty && !mutation.isPending
                    ? 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)'
                    : 'rgba(59,130,246,0.18)',
                color: isDirty && !isEmpty && !mutation.isPending ? '#fff' : 'rgba(255,255,255,0.35)',
                cursor: isDirty && !isEmpty && !mutation.isPending ? 'pointer' : 'not-allowed',
                flexShrink: 0,
                lineHeight: 1,
                transition: 'background 0.18s, color 0.18s',
                boxShadow:
                  isDirty && !isEmpty && !mutation.isPending
                    ? '0 2px 10px rgba(59,130,246,0.35)'
                    : 'none',
              }}
            >
              {mutation.isPending ? <Spinner size="xs" /> : 'Save'}
            </button>
          )}
        </div>

        {/* Info notes */}
        <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {entry.pass_caller_id && <InfoNote>Caller ID passed through to destination</InfoNote>}
          <InfoNote>
            Ring timeout: {entry.ring_timeout != null ? `${entry.ring_timeout}s` : '30s'}
          </InfoNote>
        </div>
      </div>
    </div>
  );
}

function InfoNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        fontSize: '0.71rem',
        color: '#475569',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 14,
          height: 14,
          borderRadius: '50%',
          border: '1px solid rgba(59,130,246,0.25)',
          fontSize: '0.52rem',
          fontWeight: 700,
          flexShrink: 0,
          color: '#3b82f6',
          opacity: 0.65,
        }}
      >
        i
      </span>
      <span>{children}</span>
    </div>
  );
}
