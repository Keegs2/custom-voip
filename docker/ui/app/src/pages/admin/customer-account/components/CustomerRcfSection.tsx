/**
 * CustomerRcfSection — RCF number management inside the customer 360. Renders on
 * glass: a header eyebrow + count chip, a list of inline-editable RCF rows (label
 * / forward-to / max-channels), and an accent-tinted "Add RCF Number" form. All
 * queries + mutations operate on live data exactly as before.
 */

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { listRcf, createRcfEntry, updateRcfEntry, deleteRcfEntry } from '../../../../api/rcf';
import { Button } from '../../../../components/ui/Button';
import { Spinner } from '../../../../components/ui/Spinner';
import { useToast } from '../../../../components/ui/Toast';
import { GlassChip } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import type { RcfEntry } from '../../../../types/rcf';
import {
  emptyNote,
  errorNote,
  fieldLabel,
  glassFieldInput,
  glassFormPanel,
  glassRow,
  inlineLoading,
  manageLink,
  sectionEyebrow,
} from '../styles';

interface CustomerRcfSectionProps {
  customerId: number;
  accent?: string;
}

// Shared tiny button styles for inline Save/Cancel actions
const inlineSaveBtn: React.CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 600,
  padding: '4px 10px',
  borderRadius: 6,
  border: 'none',
  background: GLASS.success,
  color: '#fff',
  cursor: 'pointer',
  flexShrink: 0,
  lineHeight: 1,
};

const inlineCancelBtn: React.CSSProperties = {
  fontSize: '0.65rem',
  fontWeight: 500,
  padding: '4px 8px',
  borderRadius: 6,
  border: 'none',
  background: 'transparent',
  color: GLASS.textMuted,
  cursor: 'pointer',
  flexShrink: 0,
  lineHeight: 1,
};

const fieldEyebrow: React.CSSProperties = {
  ...fieldLabel,
  letterSpacing: '0.09em',
  marginBottom: 5,
};

// Inline editable name/label field for a single RCF row
function RcfNameInput({
  entry,
  customerId,
  accent,
}: {
  entry: RcfEntry;
  customerId: number;
  accent: string;
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
            ...glassFieldInput(true, accent),
            flex: 1,
            minWidth: 60,
            fontSize: '0.85rem',
            fontWeight: 600,
            padding: '3px 8px',
            opacity: mutation.isPending ? 0.5 : 1,
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
        color: value.trim() ? GLASS.text : GLASS.textFaint,
        fontStyle: value.trim() ? 'normal' : 'italic',
        letterSpacing: value.trim() ? '-0.01em' : 'normal',
        padding: '2px 0',
        cursor: 'pointer',
        marginBottom: 3,
        borderBottom: `1px dashed ${hexToRgba(accent, 0.25)}`,
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
  accent,
}: {
  entry: RcfEntry;
  customerId: number;
  accent: string;
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
            ...glassFieldInput(true, accent),
            width: 140,
            fontFamily: 'monospace',
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
        ...glassFieldInput(false, accent),
        display: 'inline-flex',
        alignItems: 'center',
        width: 160,
        color: saved ? '#4ade80' : GLASS.text,
        borderColor: saved ? hexToRgba(GLASS.success, 0.55) : 'rgba(255,255,255,0.12)',
        boxShadow: saved ? `0 0 0 3px ${hexToRgba(GLASS.success, 0.14)}` : 'none',
        cursor: 'pointer',
        userSelect: 'none',
        fontFamily: 'monospace',
      }}
    >
      {entry.forward_to}
    </div>
  );
}

// Inline editable max_channels field for a single RCF row
function RcfMaxChannelsInput({
  entry,
  customerId,
  accent,
}: {
  entry: RcfEntry;
  customerId: number;
  accent: string;
}) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(entry.max_channels));

  // Sync when entry refreshes (not while editing)
  const [prevChannels, setPrevChannels] = useState(entry.max_channels);
  if (entry.max_channels !== prevChannels) {
    setPrevChannels(entry.max_channels);
    if (!editing) setValue(String(entry.max_channels));
  }

  const mutation = useMutation({
    mutationFn: (n: number) => updateRcfEntry(entry.id, { max_channels: n }),
    onSuccess: (_data, n) => {
      qc.invalidateQueries({ queryKey: ['customerRcf', customerId] });
      toastOk(
        n === 0
          ? `Concurrent call limit removed for ${entry.did}`
          : `Max ${n} concurrent calls set for ${entry.did}`,
      );
      setEditing(false);
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleSave() {
    const n = parseInt(value, 10);
    if (isNaN(n) || n < 0 || n > 100) {
      toastErr('Enter a number 0–100 (0 = no limit)');
      return;
    }
    if (n === entry.max_channels) { setEditing(false); return; }
    mutation.mutate(n);
  }

  function handleCancel() {
    setValue(String(entry.max_channels));
    setEditing(false);
  }

  if (editing) {
    return (
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="number"
          min={0}
          max={100}
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
          style={{
            ...glassFieldInput(true, accent),
            width: 64,
            textAlign: 'center',
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
  const hasLimit = entry.max_channels > 0;
  return (
    <div
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      title="Click to set concurrent call limit (0 = no limit)"
      style={{
        ...glassFieldInput(false, accent),
        display: 'inline-flex',
        alignItems: 'center',
        width: 80,
        cursor: 'pointer',
        userSelect: 'none',
        color: hasLimit ? '#4ade80' : GLASS.textFaint,
        borderColor: hasLimit ? hexToRgba(GLASS.success, 0.35) : 'rgba(255,255,255,0.12)',
        fontStyle: hasLimit ? 'normal' : 'italic',
        fontSize: '0.78rem',
      }}
    >
      {entry.max_channels === 0 ? 'No Limit' : String(entry.max_channels)}
    </div>
  );
}

// A single RCF entry rendered as a card row
function RcfEntryRow({
  entry,
  customerId,
  accent,
  onToggle,
  onDelete,
  togglePending,
}: {
  entry: RcfEntry;
  customerId: number;
  accent: string;
  onToggle: () => void;
  onDelete: () => void;
  togglePending: boolean;
}) {
  return (
    <div
      style={{
        ...glassRow,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        padding: '14px 16px',
        flexWrap: 'wrap',
      }}
    >
      {/* Left: name label + DID number */}
      <div style={{ minWidth: 130, flex: '0 0 auto' }}>
        {/* Editable name above DID */}
        <RcfNameInput entry={entry} customerId={customerId} accent={accent} />
        <div
          style={{
            fontFamily: 'monospace',
            fontSize: '0.92rem',
            color: '#4ade80',
            fontWeight: 600,
            letterSpacing: '0.3px',
            whiteSpace: 'nowrap',
          }}
        >
          {entry.did}
        </div>
        {entry.ring_timeout != null && (
          <div style={{ fontSize: '0.6rem', color: GLASS.textFaint, marginTop: 2, letterSpacing: '0.3px' }}>
            {entry.ring_timeout}s timeout
          </div>
        )}
      </div>

      {/* Divider */}
      <div style={{ width: 1, alignSelf: 'stretch', background: 'rgba(255,255,255,0.08)', flexShrink: 0 }} />

      {/* Middle: Forward To */}
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div style={fieldEyebrow}>Forward To</div>
        <RcfForwardInput entry={entry} customerId={customerId} accent={accent} />
      </div>

      {/* Max Channels */}
      <div style={{ flexShrink: 0 }}>
        <div style={fieldEyebrow}>Max Calls</div>
        <RcfMaxChannelsInput entry={entry} customerId={customerId} accent={accent} />
      </div>

      {/* Right: Status + actions */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}
        onClick={(e) => e.stopPropagation()}
      >
        <GlassChip
          label={entry.enabled ? 'Active' : 'Off'}
          color={entry.enabled ? GLASS.success : GLASS.textFaint}
          dot={entry.enabled}
        />

        <div style={{ width: 1, height: 20, background: 'rgba(255,255,255,0.08)' }} />

        <Button
          variant="ghost"
          size="xs"
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          disabled={togglePending}
        >
          {entry.enabled ? 'Disable' : 'Enable'}
        </Button>

        <Button variant="danger" size="xs" onClick={(e) => { e.stopPropagation(); onDelete(); }}>
          Delete
        </Button>
      </div>
    </div>
  );
}

export function CustomerRcfSection({ customerId, accent = GLASS.success }: CustomerRcfSectionProps) {
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
    <div>
      {/* Section header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={sectionEyebrow(accent)}>RCF Numbers</span>
          {!isLoading && !isError && (
            <GlassChip label={count === 1 ? '1 number' : `${count} numbers`} color={accent} />
          )}
        </div>

        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); navigate('/rcf'); }}
          style={manageLink(accent)}
          onMouseEnter={(e) => (e.currentTarget.style.textDecoration = 'underline')}
          onMouseLeave={(e) => (e.currentTarget.style.textDecoration = 'none')}
        >
          Manage RCF Numbers
        </button>
      </div>

      {isLoading && (
        <div style={inlineLoading}>
          <Spinner size="xs" /> Loading…
        </div>
      )}

      {isError && <div style={errorNote()}>Could not load RCF numbers.</div>}

      {!isLoading && !isError && entries.length === 0 && (
        <div style={{ ...emptyNote, padding: '20px 0', textAlign: 'left' }}>No RCF numbers yet.</div>
      )}

      {/* RCF entry cards */}
      {!isLoading && entries.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
          {entries.map((entry) => (
            <RcfEntryRow
              key={entry.id}
              entry={entry}
              customerId={customerId}
              accent={accent}
              onToggle={() => toggleMutation.mutate({ id: entry.id, enabled: !entry.enabled })}
              onDelete={() => handleDelete(entry)}
              togglePending={toggleMutation.isPending}
            />
          ))}
        </div>
      )}

      {/* Add RCF Number form */}
      <form onSubmit={handleCreate} onClick={(e) => e.stopPropagation()} style={glassFormPanel(accent)}>
        <div
          style={{
            ...sectionEyebrow(accent),
            marginBottom: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 7,
          }}
        >
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 16,
              height: 16,
              borderRadius: '50%',
              background: hexToRgba(accent, 0.15),
              border: `1px solid ${hexToRgba(accent, 0.4)}`,
              fontSize: '0.72rem',
              lineHeight: 1,
              color: accent,
            }}
          >
            +
          </span>
          Add RCF Number
        </div>

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
          {/* DID field */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={fieldLabel}>DID</label>
            <input
              type="tel"
              value={newDid}
              onChange={(e) => setNewDid(e.target.value)}
              onFocus={() => setDidFocused(true)}
              onBlur={() => setDidFocused(false)}
              onClick={(e) => e.stopPropagation()}
              placeholder="+1XXXXXXXXXX"
              style={{ ...glassFieldInput(didFocused, accent), width: 155, fontFamily: 'monospace' }}
            />
          </div>

          {/* Forward To field */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={fieldLabel}>Forward To</label>
            <input
              type="tel"
              value={newFwd}
              onChange={(e) => setNewFwd(e.target.value)}
              onFocus={() => setFwdFocused(true)}
              onBlur={() => setFwdFocused(false)}
              onClick={(e) => e.stopPropagation()}
              placeholder="+1XXXXXXXXXX"
              style={{ ...glassFieldInput(fwdFocused, accent), width: 155, fontFamily: 'monospace' }}
            />
          </div>

          {/* Pass CID */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <label style={fieldLabel}>Pass CID</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 0' }}>
              <input
                type="checkbox"
                checked={passCid}
                onChange={(e) => setPassCid(e.target.checked)}
                onClick={(e) => e.stopPropagation()}
                style={{ accentColor: accent, width: 14, height: 14, cursor: 'pointer' }}
              />
              <span style={{ fontSize: '0.8rem', color: GLASS.textMuted }}>Yes</span>
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
