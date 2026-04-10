import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { listRcf, createRcfEntry, updateRcfEntry, deleteRcfEntry } from '../../api/rcf';
import { Badge } from '../../components/ui/Badge';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import type { RcfEntry } from '../../types/rcf';

interface CustomerRcfSectionProps {
  customerId: number;
}

const darkInput: React.CSSProperties = {
  fontSize: '0.82rem',
  padding: '5px 10px',
  borderRadius: 8,
  border: '1px solid rgba(42,47,69,0.7)',
  background: '#0d0f15',
  color: '#e2e8f0',
  outline: 'none',
  fontFamily: 'inherit',
  transition: 'border-color 150ms, box-shadow 150ms',
};

// Shared tiny button styles for inline Save/Cancel actions
const inlineSaveBtn: React.CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 600,
  padding: '4px 10px',
  borderRadius: 4,
  border: 'none',
  background: '#22c55e',
  color: '#fff',
  cursor: 'pointer',
  flexShrink: 0,
  lineHeight: 1,
};

const inlineCancelBtn: React.CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 500,
  padding: '4px 8px',
  borderRadius: 4,
  border: 'none',
  background: 'transparent',
  color: '#718096',
  cursor: 'pointer',
  flexShrink: 0,
  lineHeight: 1,
};

// Inline editable name/label field for a single RCF row
function RcfNameInput({
  entry,
  customerId,
}: {
  entry: RcfEntry;
  customerId: number;
}) {
  const qc = useQueryClient();
  const { toastErr } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.name ?? '');

  // Keep local value in sync when the entry prop changes from a refetch (only when not editing)
  const [prevName, setPrevName] = useState(entry.name);
  if (entry.name !== prevName) {
    setPrevName(entry.name);
    if (!editing) setValue(entry.name ?? '');
  }

  const mutation = useMutation({
    mutationFn: (name: string | null) => updateRcfEntry(entry.id, { name }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customerRcf', customerId] });
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

  if (editing) {
    return (
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap', marginBottom: 3 }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
            if (e.key === 'Escape') handleCancel();
            e.stopPropagation();
          }}
          onBlur={handleCancel}
          disabled={mutation.isPending}
          autoFocus
          placeholder="Add label..."
          style={{
            flex: 1,
            minWidth: 60,
            fontSize: '0.85rem',
            fontWeight: 600,
            color: '#e2e8f0',
            background: 'rgba(13,15,23,0.8)',
            border: '1px solid rgba(59,130,246,0.55)',
            borderRadius: 6,
            outline: 'none',
            padding: '2px 7px',
            fontFamily: 'inherit',
            opacity: mutation.isPending ? 0.5 : 1,
            boxShadow: '0 0 0 3px rgba(59,130,246,0.12)',
            letterSpacing: '-0.01em',
          }}
        />
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
          disabled={mutation.isPending}
          style={{ ...inlineSaveBtn, opacity: mutation.isPending ? 0.6 : 1 }}
        >
          {mutation.isPending ? '…' : 'Save'}
        </button>
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); handleCancel(); }}
          style={inlineCancelBtn}
        >
          Cancel
        </button>
      </div>
    );
  }

  // View mode — click to enter edit mode
  return (
    <div
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      title="Click to set a label"
      style={{
        fontSize: value.trim() ? '0.85rem' : '0.78rem',
        fontWeight: value.trim() ? 600 : 400,
        color: value.trim() ? '#e2e8f0' : '#4a5568',
        fontStyle: value.trim() ? 'normal' : 'italic',
        letterSpacing: value.trim() ? '-0.01em' : 'normal',
        padding: '2px 0',
        cursor: 'pointer',
        marginBottom: 3,
        borderBottom: '1px dashed rgba(59,130,246,0.2)',
        width: '100%',
      }}
    >
      {value.trim() || 'Add label...'}
    </div>
  );
}

// Inline editable forward-to field for a single RCF row
function RcfForwardInput({
  entry,
  customerId,
}: {
  entry: RcfEntry;
  customerId: number;
}) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.forward_to);
  const [saved, setSaved] = useState(false);

  // Sync when entry refreshes (not while editing)
  const [prevFwd, setPrevFwd] = useState(entry.forward_to);
  if (entry.forward_to !== prevFwd) {
    setPrevFwd(entry.forward_to);
    if (!editing) setValue(entry.forward_to);
  }

  const mutation = useMutation({
    mutationFn: (fwd: string) => updateRcfEntry(entry.id, { forward_to: fwd }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customerRcf', customerId] });
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
      toastOk(`Forward updated for ${entry.did}`);
      setEditing(false);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleSave() {
    const trimmed = value.trim();
    if (!trimmed) {
      toastErr('Destination cannot be empty');
      return;
    }
    if (trimmed === entry.forward_to) { setEditing(false); return; }
    mutation.mutate(trimmed);
  }

  function handleCancel() {
    setValue(entry.forward_to);
    setEditing(false);
  }

  if (editing) {
    return (
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="tel"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
            if (e.key === 'Escape') handleCancel();
            e.stopPropagation();
          }}
          onBlur={handleCancel}
          disabled={mutation.isPending}
          autoFocus
          placeholder="+1XXXXXXXXXX"
          style={{
            ...darkInput,
            width: 140,
            borderColor: 'rgba(59,130,246,0.7)',
            boxShadow: '0 0 0 3px rgba(59,130,246,0.15)',
            opacity: mutation.isPending ? 0.5 : 1,
          }}
        />
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
          disabled={mutation.isPending}
          style={{ ...inlineSaveBtn, opacity: mutation.isPending ? 0.6 : 1 }}
        >
          {mutation.isPending ? '…' : 'Save'}
        </button>
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); handleCancel(); }}
          style={inlineCancelBtn}
        >
          Cancel
        </button>
      </div>
    );
  }

  // View mode — click to enter edit mode
  return (
    <div
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      title="Click to edit forward destination"
      style={{
        ...darkInput,
        display: 'inline-flex',
        alignItems: 'center',
        width: 160,
        color: saved ? '#4ade80' : '#e2e8f0',
        borderColor: saved ? 'rgba(34,197,94,0.55)' : 'rgba(42,47,69,0.7)',
        boxShadow: saved ? '0 0 0 3px rgba(34,197,94,0.12)' : 'none',
        cursor: 'pointer',
        userSelect: 'none',
        fontFamily: 'monospace',
      }}
    >
      {entry.forward_to}
    </div>
  );
}

// A single RCF entry rendered as a card row
function RcfEntryRow({
  entry,
  customerId,
  onToggle,
  onDelete,
  togglePending,
}: {
  entry: RcfEntry;
  customerId: number;
  onToggle: () => void;
  onDelete: () => void;
  togglePending: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '14px 16px',
        background: 'rgba(13,15,23,0.7)',
        border: '1px solid rgba(42,47,69,0.55)',
        borderRadius: 10,
        flexWrap: 'wrap',
      }}
    >
      {/* Left: name label + DID number */}
      <div style={{ minWidth: 130, flex: '0 0 auto' }}>
        {/* Editable name above DID */}
        <RcfNameInput entry={entry} customerId={customerId} />
        <div
          style={{
            fontFamily: 'monospace',
            fontSize: '0.92rem',
            color: '#22c55e',
            fontWeight: 600,
            letterSpacing: '0.3px',
            whiteSpace: 'nowrap',
          }}
        >
          {entry.did}
        </div>
        {entry.ring_timeout != null && (
          <div
            style={{
              fontSize: '0.6rem',
              color: '#4a5568',
              marginTop: 2,
              letterSpacing: '0.3px',
            }}
          >
            {entry.ring_timeout}s timeout
          </div>
        )}
      </div>

      {/* Divider */}
      <div
        style={{
          width: 1,
          alignSelf: 'stretch',
          background: 'rgba(42,47,69,0.5)',
          flexShrink: 0,
        }}
      />

      {/* Middle: Forward To */}
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div
          style={{
            fontSize: '0.6rem',
            fontWeight: 700,
            color: '#4a5568',
            textTransform: 'uppercase',
            letterSpacing: '0.7px',
            marginBottom: 5,
          }}
        >
          Forward To
        </div>
        <RcfForwardInput entry={entry} customerId={customerId} />
      </div>

      {/* Right: Status + actions */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          flexShrink: 0,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Badge variant={entry.enabled ? 'active' : 'disabled'}>
          {entry.enabled ? 'Active' : 'Off'}
        </Badge>

        <div
          style={{
            width: 1,
            height: 20,
            background: 'rgba(42,47,69,0.5)',
          }}
        />

        <Button
          variant="ghost"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          disabled={togglePending}
        >
          {entry.enabled ? 'Disable' : 'Enable'}
        </Button>

        <Button
          variant="danger"
          size="xs"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          Delete
        </Button>
      </div>
    </div>
  );
}

export function CustomerRcfSection({ customerId }: CustomerRcfSectionProps) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { toastOk, toastErr } = useToast();

  const [newDid, setNewDid] = useState('');
  const [newFwd, setNewFwd] = useState('');
  const [passCid, setPassCid] = useState(true);

  const [didFocused, setDidFocused] = useState(false);
  const [fwdFocused, setFwdFocused] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['customerRcf', customerId],
    queryFn: () => listRcf({ customer_id: customerId, limit: 200 }),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      updateRcfEntry(id, { enabled }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['customerRcf', customerId] });
      toastOk(vars.enabled ? 'RCF number enabled' : 'RCF number disabled');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteRcfEntry(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customerRcf', customerId] });
      toastOk('RCF number deleted');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      createRcfEntry({
        customer_id: customerId,
        did: newDid.trim(),
        forward_to: newFwd.trim(),
        pass_caller_id: passCid,
        ring_timeout: 30,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['customerRcf', customerId] });
      setNewDid('');
      setNewFwd('');
      setPassCid(true);
      toastOk('RCF number created');
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    e.stopPropagation();
    if (!newDid.trim()) { toastErr('DID is required'); return; }
    if (!newFwd.trim()) { toastErr('Forward-to is required'); return; }
    createMutation.mutate();
  }

  function handleDelete(entry: RcfEntry) {
    if (!confirm(`Delete ${entry.did}?\n\nThis cannot be undone.`)) return;
    deleteMutation.mutate(entry.id);
  }

  const entries = data?.items ?? [];
  const count = entries.length;

  return (
    <div style={{ paddingTop: 16, borderTop: '1px solid rgba(42,47,69,0.5)' }}>

      {/* Section header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontSize: '0.65rem',
              fontWeight: 700,
              color: '#4a5568',
              textTransform: 'uppercase',
              letterSpacing: '0.8px',
            }}
          >
            RCF Numbers
          </span>
          {!isLoading && !isError && (
            <span
              style={{
                fontSize: '0.62rem',
                fontWeight: 700,
                color: '#22c55e',
                background: 'rgba(34,197,94,0.12)',
                border: '1px solid rgba(34,197,94,0.25)',
                borderRadius: 20,
                padding: '1px 7px',
                letterSpacing: '0.3px',
                lineHeight: 1.6,
              }}
            >
              {count === 1 ? '1 number' : `${count} numbers`}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); navigate('/rcf'); }}
          style={{
            fontSize: '0.72rem',
            color: '#3b82f6',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            textDecoration: 'none',
          }}
          onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
          onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
        >
          Manage RCF Numbers
        </button>
      </div>

      {/* Loading state */}
      {isLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: '#718096',
            fontSize: '0.8rem',
            padding: '8px 0',
          }}
        >
          <Spinner size="xs" /> Loading…
        </div>
      )}

      {/* Error state */}
      {isError && (
        <p style={{ color: '#f87171', fontSize: '0.8rem', margin: 0 }}>
          Could not load RCF numbers.
        </p>
      )}

      {/* Empty state */}
      {!isLoading && !isError && entries.length === 0 && (
        <p
          style={{
            color: '#4a5568',
            fontSize: '0.8rem',
            margin: '0 0 4px',
            fontStyle: 'italic',
          }}
        >
          No RCF numbers yet.
        </p>
      )}

      {/* RCF entry cards */}
      {!isLoading && entries.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 12 }}>
          {entries.map((entry) => (
            <RcfEntryRow
              key={entry.id}
              entry={entry}
              customerId={customerId}
              onToggle={() => toggleMutation.mutate({ id: entry.id, enabled: !entry.enabled })}
              onDelete={() => handleDelete(entry)}
              togglePending={toggleMutation.isPending}
            />
          ))}
        </div>
      )}

      {/* Add RCF Number form */}
      <form
        onSubmit={handleCreate}
        onClick={(e) => e.stopPropagation()}
        style={{
          marginTop: entries.length > 0 ? 4 : 8,
          padding: '14px 16px',
          background: 'rgba(13,15,23,0.7)',
          border: '1px solid rgba(42,47,69,0.55)',
          borderRadius: 10,
        }}
      >
        {/* Form header */}
        <div
          style={{
            fontSize: '0.62rem',
            fontWeight: 700,
            color: '#22c55e',
            textTransform: 'uppercase',
            letterSpacing: '0.8px',
            marginBottom: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span
            style={{
              display: 'inline-block',
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: 'rgba(34,197,94,0.15)',
              border: '1px solid rgba(34,197,94,0.4)',
              lineHeight: '13px',
              textAlign: 'center',
              fontSize: '0.7rem',
              color: '#22c55e',
            }}
          >
            +
          </span>
          Add RCF Number
        </div>

        {/* Form fields */}
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            alignItems: 'flex-end',
          }}
        >
          {/* DID field */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label
              style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                color: '#4a5568',
                textTransform: 'uppercase',
                letterSpacing: '0.7px',
              }}
            >
              DID
            </label>
            <input
              type="tel"
              value={newDid}
              onChange={(e) => setNewDid(e.target.value)}
              onFocus={() => setDidFocused(true)}
              onBlur={() => setDidFocused(false)}
              onClick={(e) => e.stopPropagation()}
              placeholder="+1XXXXXXXXXX"
              style={{
                ...darkInput,
                width: 155,
                borderColor: didFocused ? 'rgba(59,130,246,0.7)' : 'rgba(42,47,69,0.7)',
                boxShadow: didFocused ? '0 0 0 3px rgba(59,130,246,0.15)' : 'none',
                fontFamily: 'monospace',
              }}
            />
          </div>

          {/* Forward To field */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label
              style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                color: '#4a5568',
                textTransform: 'uppercase',
                letterSpacing: '0.7px',
              }}
            >
              Forward To
            </label>
            <input
              type="tel"
              value={newFwd}
              onChange={(e) => setNewFwd(e.target.value)}
              onFocus={() => setFwdFocused(true)}
              onBlur={() => setFwdFocused(false)}
              onClick={(e) => e.stopPropagation()}
              placeholder="+1XXXXXXXXXX"
              style={{
                ...darkInput,
                width: 155,
                borderColor: fwdFocused ? 'rgba(59,130,246,0.7)' : 'rgba(42,47,69,0.7)',
                boxShadow: fwdFocused ? '0 0 0 3px rgba(59,130,246,0.15)' : 'none',
                fontFamily: 'monospace',
              }}
            />
          </div>

          {/* Pass CID */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <label
              style={{
                fontSize: '0.6rem',
                fontWeight: 700,
                color: '#4a5568',
                textTransform: 'uppercase',
                letterSpacing: '0.7px',
              }}
            >
              Pass CID
            </label>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 0',
              }}
            >
              <input
                type="checkbox"
                checked={passCid}
                onChange={(e) => setPassCid(e.target.checked)}
                onClick={(e) => e.stopPropagation()}
                style={{
                  accentColor: '#22c55e',
                  width: 14,
                  height: 14,
                  cursor: 'pointer',
                }}
              />
              <span style={{ fontSize: '0.8rem', color: '#718096' }}>Yes</span>
            </div>
          </div>

          {/* Submit */}
          <Button
            type="submit"
            variant="primary"
            size="sm"
            loading={createMutation.isPending}
            onClick={(e) => e.stopPropagation()}
          >
            Create
          </Button>
        </div>
      </form>
    </div>
  );
}
