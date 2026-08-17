/**
 * CustomerRcfSection — RCF numbers panel on the admin Customer 360
 * (rcf/hybrid accounts): entry list with inline label / forward-to /
 * max-channels editors, enable-disable, delete, and the add-number form.
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * admin-area `dlx-*` primitives in dl-admin.css and the page-scoped `dlx3-*`
 * primitives in dl-customer360.css). Renders its own dl-panel — the parent
 * CustomerAccountPage contributes only page composition. Presentation only:
 * every query, mutation payload, confirm() and toast is unchanged.
 *
 * React #310: every hook in every component below is called unconditionally
 * at the top of its function, before any early return.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { PhoneForwarded } from 'lucide-react';
import { listRcf, createRcfEntry, updateRcfEntry, deleteRcfEntry } from '../../api/rcf';
import { Spinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import { fmt } from '../../utils/format';
import { normalizeNumberInput } from '../../utils/phone';
import type { RcfEntry } from '../../types/rcf';
import '../../styles/dl-admin.css';
import '../../styles/dl-customer360.css';

interface CustomerRcfSectionProps {
  customerId: number;
}

const MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

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
        style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 4 }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="text"
          className="dl-input"
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
            minWidth: 80,
            fontWeight: 600,
            fontSize: '0.82rem',
            padding: '3px 8px',
            opacity: mutation.isPending ? 0.5 : 1,
          }}
        />
        <button
          type="button"
          className="dl-btn dl-btn-primary dlx-btn-sm"
          onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? '…' : 'Save'}
        </button>
        <button
          type="button"
          className="dl-btn dl-btn-ghost dlx-btn-sm"
          onMouseDown={(e) => { e.preventDefault(); handleCancel(); }}
        >
          Cancel
        </button>
      </div>
    );
  }

  // View mode — click to enter edit mode
  return (
    <div style={{ marginBottom: 4 }}>
      <span
        onClick={(e) => { e.stopPropagation(); setEditing(true); }}
        title="Click to set a label"
        className={value.trim() ? 'dlx3-editlabel' : 'dlx3-editlabel dlx3-editlabel-empty'}
      >
        {value.trim() || 'Add label...'}
      </span>
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
    // Canonicalize to E.164 (strip separators, preserve country code) before write.
    const normalized = normalizeNumberInput(value);
    if (!normalized) {
      toastErr('Destination cannot be empty');
      return;
    }
    if (normalized === entry.forward_to) { setEditing(false); return; }
    mutation.mutate(normalized);
  }

  function handleCancel() {
    setValue(entry.forward_to);
    setEditing(false);
  }

  if (editing) {
    return (
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="tel"
          className="dl-input dl-input-mono"
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
          style={{ width: 150, padding: '5px 10px', opacity: mutation.isPending ? 0.5 : 1 }}
        />
        <button
          type="button"
          className="dl-btn dl-btn-primary dlx-btn-sm"
          onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? '…' : 'Save'}
        </button>
        <button
          type="button"
          className="dl-btn dl-btn-ghost dlx-btn-sm"
          onMouseDown={(e) => { e.preventDefault(); handleCancel(); }}
        >
          Cancel
        </button>
      </div>
    );
  }

  // View mode — click to enter edit mode
  return (
    <span
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      title="Click to edit forward destination"
      className={saved ? 'dlx3-editchip dlx3-editchip-saved' : 'dlx3-editchip'}
    >
      {fmt(entry.forward_to)}
    </span>
  );
}

// Inline editable max_channels field for a single RCF row
function RcfMaxChannelsInput({
  entry,
  customerId,
}: {
  entry: RcfEntry;
  customerId: number;
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
        style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="number"
          min={0}
          max={100}
          className="dl-input"
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
          style={{ width: 70, textAlign: 'center', padding: '5px 8px', opacity: mutation.isPending ? 0.5 : 1 }}
        />
        <button
          type="button"
          className="dl-btn dl-btn-primary dlx-btn-sm"
          onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
          disabled={mutation.isPending}
        >
          {mutation.isPending ? '…' : 'Save'}
        </button>
        <button
          type="button"
          className="dl-btn dl-btn-ghost dlx-btn-sm"
          onMouseDown={(e) => { e.preventDefault(); handleCancel(); }}
        >
          Cancel
        </button>
      </div>
    );
  }

  // View mode — click to enter edit mode
  return (
    <span
      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
      title="Click to set concurrent call limit (0 = no limit)"
      className={
        entry.max_channels === 0 ? 'dlx3-editchip dlx3-editchip-empty' : 'dlx3-editchip'
      }
    >
      {entry.max_channels === 0 ? 'No Limit' : String(entry.max_channels)}
    </span>
  );
}

// A single RCF entry rendered as a tinted item row
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
    <div className="dl-item dlx3-prodrow">
      {/* Left: name label + DID number */}
      <div style={{ minWidth: 150, flex: '0 0 auto' }}>
        <RcfNameInput entry={entry} customerId={customerId} />
        <div
          style={{
            fontFamily: MONO,
            fontSize: '0.92rem',
            color: 'var(--rcf-azure-deep)',
            fontWeight: 700,
            letterSpacing: '0.02em',
            whiteSpace: 'nowrap',
          }}
        >
          {entry.did}
        </div>
        {entry.ring_timeout != null && (
          <div style={{ fontSize: '0.66rem', color: 'var(--rcf-ink-dim)', marginTop: 2 }}>
            {entry.ring_timeout}s timeout
          </div>
        )}
      </div>

      {/* Divider */}
      <div className="dlx3-vdiv" aria-hidden="true" />

      {/* Middle: Forward To */}
      <div style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div className="dl-fact-label">Forward To</div>
        <RcfForwardInput entry={entry} customerId={customerId} />
      </div>

      {/* Max Channels */}
      <div style={{ flexShrink: 0 }}>
        <div className="dl-fact-label">Max Calls</div>
        <RcfMaxChannelsInput entry={entry} customerId={customerId} />
      </div>

      {/* Right: Status + actions */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, marginLeft: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <span className={entry.enabled ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
          {entry.enabled ? 'Active' : 'Off'}
        </span>

        <button
          type="button"
          className="dl-btn dl-btn-ghost dlx-btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          disabled={togglePending}
        >
          {entry.enabled ? 'Disable' : 'Enable'}
        </button>

        <button
          type="button"
          className="dl-btn dl-btn-danger dlx-btn-sm"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
        >
          Delete
        </button>
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
        // Canonicalize both the source DID and the forward target to E.164.
        did: normalizeNumberInput(newDid),
        forward_to: normalizeNumberInput(newFwd),
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
    <section className="dl-panel">
      {/* ── Panel head — title + count + manage link ── */}
      <div className="dl-panel-head" style={{ flexWrap: 'nowrap' }}>
        <span aria-hidden="true" style={{ display: 'inline-flex', color: 'var(--rcf-azure-deep)', flexShrink: 0 }}>
          <PhoneForwarded size={15} strokeWidth={2} />
        </span>
        <h3 className="dl-panel-title" style={{ margin: 0 }}>RCF Numbers</h3>
        {!isLoading && !isError && (
          <span className="dl-count">{count === 1 ? '1 number' : `${count} numbers`}</span>
        )}
        <button
          type="button"
          className="dlx-linkbtn"
          style={{ marginLeft: 'auto', flexShrink: 0 }}
          onClick={(e) => { e.stopPropagation(); navigate('/rcf'); }}
        >
          Manage RCF Numbers →
        </button>
      </div>

      <div className="dl-panel-body">
        {/* Loading state */}
        {isLoading && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              color: 'var(--rcf-ink-dim)',
              fontSize: '0.8rem',
              padding: '8px 0',
            }}
          >
            <Spinner size="xs" /> Loading…
          </div>
        )}

        {/* Error state */}
        {isError && (
          <div className="dl-banner dl-banner-err">Could not load RCF numbers.</div>
        )}

        {/* Empty state */}
        {!isLoading && !isError && entries.length === 0 && (
          <div className="dl-empty" style={{ marginBottom: 12 }}>
            No RCF numbers yet.
          </div>
        )}

        {/* RCF entry rows */}
        {!isLoading && entries.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
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
          style={{ paddingTop: 16, borderTop: '1px solid var(--rcf-line)' }}
        >
          <h4 className="dl-section-title">Add RCF Number</h4>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-end' }}>
            {/* DID field */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span className="dl-flabel">DID</span>
              <input
                type="tel"
                className="dl-input dl-input-mono"
                value={newDid}
                onChange={(e) => setNewDid(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="+1XXXXXXXXXX"
                style={{ width: 160 }}
              />
            </div>

            {/* Forward To field */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span className="dl-flabel">Forward To</span>
              <input
                type="tel"
                className="dl-input dl-input-mono"
                value={newFwd}
                onChange={(e) => setNewFwd(e.target.value)}
                onClick={(e) => e.stopPropagation()}
                placeholder="+1XXXXXXXXXX"
                style={{ width: 160 }}
              />
            </div>

            {/* Pass CID */}
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span className="dl-flabel">Pass CID</span>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '8px 0',
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                  color: 'var(--rcf-ink-soft)',
                }}
              >
                <input
                  type="checkbox"
                  checked={passCid}
                  onChange={(e) => setPassCid(e.target.checked)}
                  onClick={(e) => e.stopPropagation()}
                  style={{ accentColor: 'var(--rcf-azure)', width: 14, height: 14, cursor: 'pointer' }}
                />
                Yes
              </label>
            </div>

            {/* Submit */}
            <button
              type="submit"
              className="dl-btn dl-btn-primary"
              disabled={createMutation.isPending}
              onClick={(e) => e.stopPropagation()}
            >
              {createMutation.isPending ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
