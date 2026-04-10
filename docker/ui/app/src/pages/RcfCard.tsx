import { useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { RcfEntry } from '../types/rcf';
import { apiRequest } from '../api/client';
import { updateRcfEntry } from '../api/rcf';
import { Badge } from '../components/ui/Badge';
import { Button } from '../components/ui/Button';
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

interface RcfUpdatePayload {
  forward_to: string;
}

async function updateRcfForwardTo(did: string, payload: RcfUpdatePayload): Promise<RcfEntry> {
  return apiRequest('PUT', `/rcf/${encodeURIComponent(did)}`, payload);
}

// Inline-editable name label for the portal RCF card
function RcfNameField({
  entry,
  canEdit,
}: {
  entry: RcfEntry;
  canEdit: boolean;
}) {
  const queryClient = useQueryClient();
  const { toastErr } = useToast();

  const [value, setValue] = useState(entry.name ?? '');
  const [focused, setFocused] = useState(false);

  // Sync when external data changes
  const [prevName, setPrevName] = useState(entry.name);
  if (entry.name !== prevName) {
    setPrevName(entry.name);
    setValue(entry.name ?? '');
  }

  const mutation = useMutation({
    mutationFn: (name: string | null) => updateRcfEntry(entry.id, { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleBlur() {
    setFocused(false);
    const trimmed = value.trim();
    const newName = trimmed === '' ? null : trimmed;
    const currentName = entry.name ?? null;
    if (newName !== currentName) {
      mutation.mutate(newName);
    }
  }

  // Display-only when readonly
  if (!canEdit) {
    if (!entry.name) return null;
    return (
      <div
        style={{
          fontSize: '1rem',
          fontWeight: 700,
          color: '#e2e8f0',
          letterSpacing: '-0.01em',
          marginBottom: 6,
          lineHeight: 1.3,
        }}
      >
        {entry.name}
      </div>
    );
  }

  return (
    <input
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onFocus={() => setFocused(true)}
      onBlur={handleBlur}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
      disabled={mutation.isPending}
      placeholder="Add label..."
      title="Click to set a name for this number"
      style={{
        display: 'block',
        width: '100%',
        fontSize: value.trim() ? '1rem' : '0.85rem',
        fontWeight: value.trim() ? 700 : 400,
        color: value.trim() ? '#e2e8f0' : '#4a5568',
        fontStyle: value.trim() ? 'normal' : 'italic',
        letterSpacing: value.trim() ? '-0.01em' : 'normal',
        lineHeight: 1.3,
        background: focused ? 'rgba(19,21,29,0.8)' : 'transparent',
        border: focused
          ? '1px solid rgba(59,130,246,0.55)'
          : '1px solid transparent',
        borderRadius: 6,
        outline: 'none',
        padding: focused ? '3px 8px' : '3px 0',
        fontFamily: 'inherit',
        cursor: focused ? 'text' : 'pointer',
        transition: 'border-color 150ms, background 150ms, padding 100ms',
        opacity: mutation.isPending ? 0.5 : 1,
        boxShadow: focused ? '0 0 0 3px rgba(59,130,246,0.12)' : 'none',
        marginBottom: 6,
      }}
    />
  );
}

export function RcfCard({ entry, pendingValue, onPendingChange }: RcfCardProps) {
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const { user } = useAuth();
  const canEdit = user?.role !== 'readonly';

  // Track whether the save just succeeded for the green flash animation
  const [savedFlash, setSavedFlash] = useState(false);

  const isDirty = pendingValue !== entry.forward_to && pendingValue !== '';
  const isEmpty = pendingValue.trim() === '';

  const mutation = useMutation({
    mutationFn: (newValue: string) =>
      updateRcfForwardTo(entry.did, { forward_to: newValue.trim() }),

    onSuccess: (_data, newValue) => {
      // Invalidate the RCF list so the updated entry refreshes
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });

      // Reset the pending edit back to the saved value
      onPendingChange(entry.did, newValue.trim());

      // Show success flash then clear it after 1800ms
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);

      toastOk(`Saved — calls to ${fmt(entry.did)} now ring ${fmt(newValue.trim())}`);
    },

    onError: (error: Error) => {
      toastErr(error.message ?? 'Failed to save');
    },
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

  const accent = '#22c55e';
  const borderColor = savedFlash
    ? 'rgba(34,197,94,0.5)'
    : 'rgba(42,47,69,0.6)';
  const boxShadow = savedFlash
    ? '0 0 0 3px rgba(34,197,94,0.15), 0 4px 20px rgba(0,0,0,0.4)'
    : '0 4px 20px rgba(0,0,0,0.3)';

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: `1px solid ${borderColor}`,
        borderRadius: 16,
        padding: '24px',
        boxShadow,
        transition: 'border-color 0.3s, box-shadow 0.3s',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Top accent line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 32,
          right: 32,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accent}80, transparent)`,
          opacity: savedFlash ? 1 : 0.3,
          transition: 'opacity 0.3s',
        }}
      />

      {/* Card header: formatted DID + status badge */}
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
          {/* Editable name label — prominent when set, subtle placeholder when empty */}
          <RcfNameField entry={entry} canEdit={canEdit} />
          <div
            style={{
              fontSize: '1.2rem',
              fontWeight: 700,
              color: '#e2e8f0',
              lineHeight: 1.3,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              letterSpacing: '-0.01em',
            }}
          >
            {fmt(entry.did)}
          </div>
          <div
            style={{
              fontSize: '0.72rem',
              fontFamily: 'monospace',
              color: '#718096',
              marginTop: 3,
            }}
          >
            {entry.did}
          </div>
        </div>
        <div style={{ flexShrink: 0, marginTop: 2 }}>
          <Badge variant={entry.enabled ? 'active' : 'disabled'}>
            {entry.enabled ? 'Active' : 'Disabled'}
          </Badge>
        </div>
      </div>

      {/* Forward-to action area */}
      <div>
        <label
          htmlFor={`rcf-fwd-${entry.id}`}
          style={{
            display: 'block',
            fontSize: '0.7rem',
            fontWeight: 700,
            color: '#718096',
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
            marginBottom: 8,
          }}
        >
          Forward Calls To
        </label>

        <div className="flex gap-2 items-center">
          <input
            id={`rcf-fwd-${entry.id}`}
            type="tel"
            value={pendingValue}
            placeholder="+1XXXXXXXXXX"
            onChange={(e) => onPendingChange(entry.did, e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={mutation.isPending}
            style={{
              flex: 1,
              minWidth: 0,
              fontSize: '0.92rem',
              padding: '9px 12px',
              borderRadius: 8,
              border: `1px solid ${
                savedFlash
                  ? '#22c55e'
                  : isDirty
                  ? '#3b82f6'
                  : 'rgba(42,47,69,0.8)'
              }`,
              background: 'rgba(19,21,29,0.8)',
              color: '#e2e8f0',
              outline: 'none',
              transition: 'border-color 0.15s, box-shadow 0.15s',
              boxShadow: savedFlash
                ? '0 0 0 3px rgba(34,197,94,0.2)'
                : isDirty
                ? '0 0 0 3px rgba(59,130,246,0.2)'
                : 'none',
              opacity: mutation.isPending ? 0.5 : 1,
            }}
          />

          <Button
            variant="success"
            size="sm"
            disabled={!isDirty || isEmpty || mutation.isPending}
            onClick={handleSave}
            loading={mutation.isPending}
          >
            {mutation.isPending ? <Spinner size="xs" /> : 'Save'}
          </Button>
        </div>

        {/* Info notes below the input */}
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 5 }}>
          {entry.pass_caller_id && (
            <InfoNote>Caller ID passed through to destination</InfoNote>
          )}
          <InfoNote>
            Ring timeout:{' '}
            {entry.ring_timeout != null ? `${entry.ring_timeout}s` : '30s'}
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
        fontSize: '0.72rem',
        color: '#718096',
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
          border: '1px solid rgba(113,128,150,0.5)',
          fontSize: '0.55rem',
          fontWeight: 700,
          flexShrink: 0,
          color: '#718096',
        }}
      >
        i
      </span>
      <span>{children}</span>
    </div>
  );
}
