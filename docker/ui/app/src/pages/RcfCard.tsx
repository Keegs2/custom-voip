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

async function updateRcfPassCallerId(id: number, pass_caller_id: boolean): Promise<RcfEntry> {
  return apiRequest('PATCH', `/rcf/${id}`, { pass_caller_id });
}

async function updateRcfMaxChannels(id: number, max_channels: number): Promise<RcfEntry> {
  return apiRequest('PATCH', `/rcf/${id}`, { max_channels });
}

// ─── GreenToggle ──────────────────────────────────────────────────────────────
// Compact on/off toggle using the RCF green accent.

function GreenToggle({
  checked,
  disabled,
  pending,
  onChange,
  title,
}: {
  checked: boolean;
  disabled: boolean;
  pending: boolean;
  onChange: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled || pending}
      onClick={onChange}
      title={title}
      style={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        width: 36,
        height: 20,
        borderRadius: 10,
        border: `1px solid ${checked ? 'rgba(74,222,128,0.55)' : 'rgba(255,255,255,0.10)'}`,
        background: checked
          ? 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)'
          : 'rgba(255,255,255,0.06)',
        cursor: disabled || pending ? 'not-allowed' : 'pointer',
        transition: 'background 0.22s ease, border-color 0.22s ease, box-shadow 0.22s',
        opacity: pending ? 0.55 : 1,
        flexShrink: 0,
        padding: 0,
        outline: 'none',
        boxShadow: checked ? '0 0 8px rgba(74,222,128,0.35)' : 'none',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: checked ? 18 : 2,
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 4px rgba(0,0,0,0.45)',
          transition: 'left 0.22s ease',
        }}
      />
    </button>
  );
}

// ─── StatusBadge ──────────────────────────────────────────────────────────────

function StatusBadge({ enabled, pending }: { enabled: boolean; pending: boolean }) {
  const color = enabled ? '#4ade80' : '#ef4444';
  const bg = enabled ? 'rgba(74,222,128,0.12)' : 'rgba(239,68,68,0.12)';
  const border = enabled ? 'rgba(74,222,128,0.28)' : 'rgba(239,68,68,0.28)';
  const label = pending ? '…' : enabled ? 'Active' : 'Disabled';

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: '0.62rem',
        fontWeight: 700,
        color,
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 20,
        padding: '3px 9px',
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        transition: 'color 0.2s, background 0.2s, border-color 0.2s',
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
          boxShadow: `0 0 5px ${color}`,
          display: 'inline-block',
        }}
      />
      {label}
    </span>
  );
}

// ─── ForwardToDisplay ─────────────────────────────────────────────────────────
// The large, clickable forwarding destination. Clicking switches to edit mode.

interface ForwardToDisplayProps {
  entry: RcfEntry;
  pendingValue: string;
  canEdit: boolean;
  onPendingChange: (did: string, value: string) => void;
}

function ForwardToDisplay({ entry, pendingValue, canEdit, onPendingChange }: ForwardToDisplayProps) {
  // ALL hooks unconditionally at the top (rules-of-hooks)
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [editing, setEditing] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [hovered, setHovered] = useState(false);

  const isDirty = pendingValue !== entry.forward_to && pendingValue !== '';

  const mutation = useMutation({
    mutationFn: (newValue: string) => updateRcfForwardTo(entry.did, newValue.trim()),
    onSuccess: (_data, newValue) => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      onPendingChange(entry.did, newValue.trim());
      setEditing(false);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1800);
      toastOk(`Saved — calls to ${fmt(entry.did)} now ring ${fmt(newValue.trim())}`);
    },
    onError: (error: Error) => toastErr(error.message ?? 'Failed to save'),
  });

  const handleSave = useCallback(() => {
    const trimmed = pendingValue.trim();
    if (!trimmed) { toastErr('Destination cannot be empty'); return; }
    mutation.mutate(trimmed);
  }, [pendingValue, mutation, toastErr]);

  const handleCancel = useCallback(() => {
    onPendingChange(entry.did, entry.forward_to);
    setEditing(false);
  }, [entry.did, entry.forward_to, onPendingChange]);

  // Editing mode — inline input replaces the display number
  if (editing && canEdit) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <input
          type="tel"
          value={pendingValue}
          autoFocus
          placeholder="+1XXXXXXXXXX"
          disabled={mutation.isPending}
          onChange={(e) => onPendingChange(entry.did, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
            if (e.key === 'Escape') handleCancel();
          }}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            fontSize: '1.3rem',
            fontWeight: 700,
            fontFamily: 'monospace',
            letterSpacing: '0.02em',
            padding: '10px 14px',
            borderRadius: 10,
            border: `1px solid ${isDirty ? 'rgba(74,222,128,0.6)' : 'rgba(74,222,128,0.3)'}`,
            background: 'rgba(15,17,23,0.90)',
            color: '#4ade80',
            outline: 'none',
            boxShadow: isDirty
              ? '0 0 0 3px rgba(74,222,128,0.14)'
              : '0 0 0 2px rgba(74,222,128,0.08)',
            opacity: mutation.isPending ? 0.55 : 1,
            transition: 'border-color 0.15s, box-shadow 0.15s',
          }}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            disabled={!isDirty || mutation.isPending}
            onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
            style={{
              flex: 1,
              padding: '8px 0',
              borderRadius: 8,
              border: 'none',
              background: isDirty && !mutation.isPending
                ? 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)'
                : 'rgba(74,222,128,0.15)',
              color: isDirty && !mutation.isPending ? '#fff' : 'rgba(74,222,128,0.4)',
              fontSize: '0.78rem',
              fontWeight: 700,
              cursor: isDirty && !mutation.isPending ? 'pointer' : 'not-allowed',
              fontFamily: 'inherit',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              boxShadow: isDirty && !mutation.isPending ? '0 2px 10px rgba(34,197,94,0.35)' : 'none',
              transition: 'background 0.15s, color 0.15s',
              letterSpacing: '-0.01em',
            }}
          >
            {mutation.isPending ? <Spinner size="xs" /> : 'Save'}
          </button>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); handleCancel(); }}
            style={{
              padding: '8px 16px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.04)',
              color: '#64748b',
              fontSize: '0.78rem',
              fontWeight: 500,
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'color 0.15s',
            }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Display mode — the large green number, clickable to edit
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        position: 'relative',
        cursor: canEdit ? 'pointer' : 'default',
        minWidth: 0,
      }}
      onMouseEnter={() => { if (canEdit) setHovered(true); }}
      onMouseLeave={() => setHovered(false)}
      onClick={() => { if (canEdit) setEditing(true); }}
      title={canEdit ? 'Click to change forwarding destination' : undefined}
    >
      <span
        style={{
          fontSize: '1.45rem',
          fontWeight: 800,
          fontFamily: 'monospace',
          letterSpacing: '0.02em',
          color: savedFlash ? '#86efac' : '#4ade80',
          textShadow: savedFlash
            ? '0 0 16px rgba(74,222,128,0.45)'
            : '0 0 12px rgba(74,222,128,0.22)',
          transition: 'color 0.25s, text-shadow 0.25s',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {fmt(entry.forward_to)}
      </span>
      {canEdit && (
        <span
          style={{
            position: 'absolute',
            right: 0,
            top: '50%',
            transform: 'translateY(-50%)',
            opacity: hovered ? 1 : 0,
            transition: 'opacity 0.18s',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            borderRadius: 7,
            background: hovered ? 'rgba(74,222,128,0.12)' : 'transparent',
            border: hovered ? '1px solid rgba(74,222,128,0.24)' : '1px solid transparent',
          }}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="#4ade80"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ width: 12, height: 12 }}
          >
            <path d="M11.5 2.5a1.414 1.414 0 0 1 2 2L5 13H2v-3L11.5 2.5z" />
          </svg>
        </span>
      )}
    </div>
  );
}

// ─── StatPill ─────────────────────────────────────────────────────────────────
// A small info chip for the settings row at the bottom of the card.

function StatPill({
  icon,
  label,
  value,
  hint,
  onClick,
  active,
  clickable,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
  onClick?: () => void;
  active?: boolean;
  clickable?: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const isInteractive = clickable && !!onClick;

  return (
    <button
      type="button"
      onClick={isInteractive ? onClick : undefined}
      disabled={!isInteractive}
      onMouseEnter={() => { if (isInteractive) setHovered(true); }}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 3,
        padding: '8px 10px',
        borderRadius: 10,
        border: active
          ? '1px solid rgba(74,222,128,0.28)'
          : `1px solid ${hovered && isInteractive ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.06)'}`,
        background: active
          ? 'rgba(74,222,128,0.08)'
          : hovered && isInteractive
          ? 'rgba(255,255,255,0.04)'
          : 'rgba(255,255,255,0.02)',
        cursor: isInteractive ? 'pointer' : 'default',
        fontFamily: 'inherit',
        transition: 'border-color 0.15s, background 0.15s',
        flex: '1 1 0',
        minWidth: 0,
        outline: 'none',
      }}
    >
      <span style={{ color: active ? '#4ade80' : '#475569', display: 'flex', alignItems: 'center' }}>
        {icon}
      </span>
      <span
        style={{
          fontSize: '0.62rem',
          fontWeight: 700,
          color: active ? '#4ade80' : '#e2e8f0',
          whiteSpace: 'nowrap',
          letterSpacing: '0.01em',
          lineHeight: 1.2,
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontSize: '0.55rem',
          fontWeight: 600,
          color: '#334155',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      {hint && (
        <span
          style={{
            fontSize: '0.5rem',
            color: active ? 'rgba(74,222,128,0.5)' : 'rgba(148,163,184,0.4)',
            fontStyle: 'italic',
            marginTop: 1,
            whiteSpace: 'nowrap',
          }}
        >
          {hint}
        </span>
      )}
    </button>
  );
}

// ─── CallerIdPill ─────────────────────────────────────────────────────────────
// Clickable StatPill wired to the pass_caller_id toggle.

function CallerIdPill({ entry, canEdit }: { entry: RcfEntry; canEdit: boolean }) {
  // ALL hooks unconditionally at the top
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const mutation = useMutation({
    mutationFn: (pass: boolean) => updateRcfPassCallerId(entry.id, pass),
    onSuccess: (_, pass) => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      toastOk(
        pass
          ? `Caller ID pass-through enabled for ${fmt(entry.did)}`
          : `Caller ID will show ${fmt(entry.did)} instead`,
      );
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to update'),
  });

  const passthrough = entry.pass_caller_id;
  const pending = mutation.isPending;

  return (
    <StatPill
      icon={
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
          <path d="M2 3a1.5 1.5 0 0 1 1.5-1.5h1.75a.5.5 0 0 1 .47.33l1 3a.5.5 0 0 1-.25.61L5 6.2a7.5 7.5 0 0 0 2.8 2.8l1.37-1.5a.5.5 0 0 1 .61-.25l3 1a.5.5 0 0 1 .32.47V10.5A1.5 1.5 0 0 1 11.5 12H11C5.477 12 1 7.523 1 2V2" />
        </svg>
      }
      label="Caller ID"
      value={passthrough ? 'Pass-thru' : 'Show DID'}
      hint={canEdit ? 'click to toggle' : undefined}
      active={passthrough}
      clickable={canEdit && !pending}
      onClick={() => { if (canEdit && !pending) mutation.mutate(!passthrough); }}
    />
  );
}

// ─── MaxChannelsPill ─────────────────────────────────────────────────────────
// Clickable stat pill that lets admins edit the per-DID concurrent call limit.

function MaxChannelsPill({ entry, canEdit }: { entry: RcfEntry; canEdit: boolean }) {
  // ALL hooks unconditionally at the top
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(entry.max_channels));

  const mutation = useMutation({
    mutationFn: (v: number) => updateRcfMaxChannels(entry.id, v),
    onSuccess: (_, v) => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      setEditing(false);
      toastOk(v === 0 ? `Concurrent call limit removed for ${fmt(entry.did)}` : `Max ${v} concurrent calls set for ${fmt(entry.did)}`);
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to update'),
  });

  if (editing && canEdit) {
    return (
      <div
        style={{
          flex: '1 1 0',
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 4,
          padding: '6px 8px',
          borderRadius: 10,
          border: '1px solid rgba(74,222,128,0.35)',
          background: 'rgba(74,222,128,0.06)',
        }}
      >
        <input
          type="number"
          min={0}
          max={100}
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const n = parseInt(value, 10);
              if (!isNaN(n) && n >= 0 && n <= 100) mutation.mutate(n);
            }
            if (e.key === 'Escape') { setEditing(false); setValue(String(entry.max_channels)); }
          }}
          onBlur={() => { setEditing(false); setValue(String(entry.max_channels)); }}
          style={{
            width: 50,
            textAlign: 'center',
            fontSize: '0.72rem',
            fontWeight: 700,
            color: '#4ade80',
            background: 'rgba(15,17,23,0.85)',
            border: '1px solid rgba(74,222,128,0.35)',
            borderRadius: 5,
            padding: '3px 4px',
            outline: 'none',
            fontFamily: 'inherit',
          }}
        />
        <span style={{ fontSize: '0.5rem', color: 'rgba(74,222,128,0.5)', fontStyle: 'italic' }}>
          0 = no limit
        </span>
      </div>
    );
  }

  return (
    <StatPill
      icon={
        <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
          <path d="M1 4h12M1 7h12M1 10h12" />
        </svg>
      }
      label="Max Calls"
      value={entry.max_channels === 0 ? 'No Limit' : String(entry.max_channels)}
      hint={canEdit ? 'click to edit' : undefined}
      active={entry.max_channels > 0}
      clickable={canEdit && !mutation.isPending}
      onClick={() => { if (canEdit) { setValue(String(entry.max_channels)); setEditing(true); } }}
    />
  );
}

// ─── RcfNameField ─────────────────────────────────────────────────────────────
// Small editable label above the DID number. Only shown when a name exists,
// or when canEdit is true (shows placeholder).

function RcfNameField({ entry, canEdit }: { entry: RcfEntry; canEdit: boolean }) {
  // ALL hooks unconditionally at the top
  const queryClient = useQueryClient();
  const { toastErr } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(entry.name ?? '');
  const [prevName, setPrevName] = useState(entry.name);

  // Sync external changes when not editing
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
    if (newName === (entry.name ?? null)) { setEditing(false); return; }
    mutation.mutate(newName);
  }

  function handleCancel() {
    setValue(entry.name ?? '');
    setEditing(false);
  }

  // Read-only: only show if there is a name
  if (!canEdit) {
    if (!entry.name) return null;
    return (
      <span
        style={{
          fontSize: '0.70rem',
          fontWeight: 600,
          color: '#64748b',
          letterSpacing: '0.03em',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: 'block',
        }}
      >
        {entry.name}
      </span>
    );
  }

  if (editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <input
          type="text"
          value={value}
          autoFocus
          placeholder="Add label..."
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); handleSave(); }
            if (e.key === 'Escape') handleCancel();
          }}
          onBlur={handleCancel}
          disabled={mutation.isPending}
          style={{
            flex: 1,
            fontSize: '0.70rem',
            fontWeight: 600,
            color: '#94a3b8',
            background: 'rgba(15,17,23,0.85)',
            border: '1px solid rgba(74,222,128,0.40)',
            borderRadius: 5,
            outline: 'none',
            padding: '3px 7px',
            fontFamily: 'inherit',
            opacity: mutation.isPending ? 0.5 : 1,
            letterSpacing: '0.03em',
          }}
        />
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
          disabled={mutation.isPending}
          style={{
            fontSize: '0.60rem',
            fontWeight: 700,
            padding: '3px 9px',
            borderRadius: 4,
            border: 'none',
            background: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)',
            color: '#fff',
            cursor: mutation.isPending ? 'not-allowed' : 'pointer',
            lineHeight: 1,
            opacity: mutation.isPending ? 0.6 : 1,
            flexShrink: 0,
          }}
        >
          {mutation.isPending ? '…' : 'OK'}
        </button>
      </div>
    );
  }

  const hasName = !!value.trim();

  return (
    <span
      onClick={() => setEditing(true)}
      title="Click to edit this label"
      style={{
        fontSize: '0.70rem',
        fontWeight: 600,
        color: hasName ? '#64748b' : '#334155',
        fontStyle: hasName ? 'normal' : 'italic',
        letterSpacing: '0.03em',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        paddingBottom: 1,
        borderBottom: '1px dashed rgba(74,222,128,0.18)',
        transition: 'color 0.15s, border-color 0.15s',
      }}
    >
      {hasName ? value.trim() : 'Name this line — click to edit'}
      <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="round" strokeLinejoin="round"
        style={{ width: 10, height: 10, color: 'rgba(74,222,128,0.4)', flexShrink: 0 }}>
        <path d="M8.5 1.5l2 2L4 10H2v-2L8.5 1.5z" />
      </svg>
    </span>
  );
}

// ─── RcfCard ──────────────────────────────────────────────────────────────────

export function RcfCard({ entry, pendingValue, onPendingChange }: RcfCardProps) {
  // ALL hooks unconditionally at the top (rules-of-hooks)
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const { user } = useAuth();
  const [cardHovered, setCardHovered] = useState(false);

  const canEdit = user?.role !== 'readonly';

  const enableMutation = useMutation({
    mutationFn: (enabled: boolean) => updateRcfEnabled(entry.id, enabled),
    onSuccess: (_, enabled) => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      toastOk(enabled ? `${fmt(entry.did)} enabled` : `${fmt(entry.did)} disabled`);
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to update'),
  });

  const enabled = entry.enabled;
  const enablePending = enableMutation.isPending;

  // ── Layout constants ──────────────────────────────────────────────────────────
  const GREEN = '#4ade80';
  const GREEN_DIM = 'rgba(74,222,128,0.22)';

  return (
    <div
      style={{
        position: 'relative',
        background: 'linear-gradient(160deg, rgba(22,26,37,0.96) 0%, rgba(15,17,23,0.98) 100%)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: `1px solid ${
          cardHovered
            ? 'rgba(74,222,128,0.22)'
            : enabled
            ? 'rgba(74,222,128,0.12)'
            : 'rgba(42,47,69,0.6)'
        }`,
        borderRadius: 20,
        overflow: 'hidden',
        transition: 'border-color 0.25s ease, box-shadow 0.25s ease',
        boxShadow: cardHovered
          ? `0 0 0 1px ${GREEN_DIM}, 0 20px 48px -12px rgba(0,0,0,0.60), 0 0 32px -8px rgba(74,222,128,0.08)`
          : '0 4px 24px -6px rgba(0,0,0,0.50)',
      }}
      onMouseEnter={() => setCardHovered(true)}
      onMouseLeave={() => setCardHovered(false)}
    >
      {/* Top accent line — green tint, brighter on hover */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 32,
          right: 32,
          height: 1,
          background: `linear-gradient(90deg, transparent, ${GREEN}55, transparent)`,
          opacity: cardHovered ? 1 : 0.35,
          transition: 'opacity 0.25s ease',
        }}
      />

      {/* Ambient glow — subtle green radial in the top-left corner */}
      <div
        style={{
          position: 'absolute',
          top: -30,
          left: -30,
          width: 160,
          height: 160,
          borderRadius: '50%',
          background: `radial-gradient(circle, rgba(74,222,128,0.06) 0%, transparent 70%)`,
          pointerEvents: 'none',
        }}
      />

      {/* ── Card body ─────────────────────────────────────────────────────────── */}
      <div style={{ padding: '20px 22px 18px', display: 'flex', flexDirection: 'column', gap: 0 }}>

        {/* ── Row 1: Status badge + enable toggle ─────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 16,
          }}
        >
          <StatusBadge enabled={enabled} pending={enablePending} />

          {/* Toggle — right side, small and unobtrusive */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {entry.customer_name && user?.role === 'admin' && (
              <span
                style={{
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  color: '#94a3b8',
                  background: 'rgba(74,222,128,0.10)',
                  border: '1px solid rgba(74,222,128,0.22)',
                  borderRadius: 6,
                  padding: '3px 10px',
                  textTransform: 'uppercase',
                  letterSpacing: '0.07em',
                  whiteSpace: 'nowrap',
                }}
              >
                {entry.customer_name}
              </span>
            )}
            <GreenToggle
              checked={enabled}
              disabled={!canEdit}
              pending={enablePending}
              onChange={() => { if (canEdit && !enablePending) enableMutation.mutate(!enabled); }}
              title={canEdit ? (enabled ? 'Click to disable' : 'Click to enable') : undefined}
            />
          </div>
        </div>

        {/* ── Row 2: Source DID ───────────────────────────────────────────────── */}
        <div style={{ marginBottom: 14, textAlign: 'center' }}>
          {/* Optional label above the DID */}
          <div style={{ marginBottom: 4, display: 'flex', justifyContent: 'center' }}>
            <RcfNameField entry={entry} canEdit={canEdit} />
          </div>

          {/* The DID number — large, primary text */}
          <div
            style={{
              fontSize: '1.45rem',
              fontWeight: 800,
              fontFamily: 'monospace',
              letterSpacing: '0.01em',
              color: '#e2e8f0',
              lineHeight: 1.15,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {fmt(entry.did)}
          </div>
        </div>

        {/* ── Row 3: Routing arrow divider ────────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 10,
          }}
        >
          {/* Left rule */}
          <div
            style={{
              flex: 1,
              height: 1,
              background: 'linear-gradient(90deg, transparent, rgba(74,222,128,0.22))',
            }}
          />

          {/* Arrow + label */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: '3px 10px',
              borderRadius: 20,
              background: 'rgba(74,222,128,0.06)',
              border: '1px solid rgba(74,222,128,0.14)',
              flexShrink: 0,
            }}
          >
            <svg
              viewBox="0 0 18 10"
              fill="none"
              style={{ width: 18, height: 10 }}
            >
              {/* Arrow shaft */}
              <line x1="1" y1="5" x2="14" y2="5" stroke={GREEN} strokeWidth={1.5} strokeLinecap="round" />
              {/* Arrowhead */}
              <path d="M11 2l3 3-3 3" stroke={GREEN} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
            </svg>
            <span
              style={{
                fontSize: '0.55rem',
                fontWeight: 700,
                color: 'rgba(74,222,128,0.65)',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                whiteSpace: 'nowrap',
              }}
            >
              Forwards to
            </span>
          </div>

          {/* Right rule */}
          <div
            style={{
              flex: 1,
              height: 1,
              background: 'linear-gradient(90deg, rgba(74,222,128,0.22), transparent)',
            }}
          />
        </div>

        {/* ── Row 4: Forwarding destination ───────────────────────────────────── */}
        <div style={{ marginBottom: 20, textAlign: 'center' }}>
          <ForwardToDisplay
            entry={entry}
            pendingValue={pendingValue}
            canEdit={canEdit}
            onPendingChange={onPendingChange}
          />
        </div>

        {/* ── Row 5: Settings stat pills ──────────────────────────────────────── */}
        <div
          style={{
            display: 'flex',
            gap: 6,
            paddingTop: 14,
            borderTop: '1px solid rgba(255,255,255,0.04)',
          }}
        >
          {/* Caller ID pill */}
          <CallerIdPill entry={entry} canEdit={canEdit} />

          {/* Ring timeout pill */}
          <StatPill
            icon={
              <svg viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" style={{ width: 13, height: 13 }}>
                <circle cx="7" cy="7" r="5.5" />
                <path d="M7 4v3l1.8 1.8" />
              </svg>
            }
            label="Timeout"
            value={entry.ring_timeout != null ? `${entry.ring_timeout}s` : '30s'}
          />

          {/* Max channels pill — always read-only on the RCF page; editable only on admin account page */}
          <MaxChannelsPill entry={entry} canEdit={false} />
        </div>
      </div>
    </div>
  );
}
