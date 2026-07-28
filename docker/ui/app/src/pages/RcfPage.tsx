import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Spinner } from '../components/ui/Spinner';
import { listRcf } from '../api/rcf';
import type { RcfEntry } from '../types/rcf';
import { RcfCard } from './RcfCard';
import { useAuth } from '../contexts/AuthContext';
import { AdminCustomerSelector } from '../components/AdminCustomerSelector';
import { fmt } from '../utils/format';
import { apiRequest } from '../api/client';
import { useToast } from '../components/ui/Toast';
import { searchCdrs } from '../api/cdrs';
import type { Cdr } from '../types/cdr';
import { listAvailableDids, listMyDids, requestDid, unassignDid } from '../api/didInventory';
import type { DidInventoryItem } from '../types/didInventory';

// Alias — customer-facing name for the unassign operation
const releaseDid = (did: string) => unassignDid(did);

// ─── API helpers ──────────────────────────────────────────────────────────────

async function updateRcfForwardTo(did: string, forward_to: string): Promise<RcfEntry> {
  return apiRequest('PUT', `/rcf/${encodeURIComponent(did)}`, { forward_to });
}

async function updateRcfEnabled(id: number, enabled: boolean): Promise<RcfEntry> {
  return apiRequest('PATCH', `/rcf/${id}`, { enabled });
}

async function updateRcfPassCallerId(id: number, pass_caller_id: boolean): Promise<RcfEntry> {
  return apiRequest('PATCH', `/rcf/${id}`, { pass_caller_id });
}

// ─── Types ────────────────────────────────────────────────────────────────────

type SortField = 'did' | 'name' | 'forward_to' | 'customer' | 'status';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;
const DEFAULT_PAGE_SIZE = 25;

// ─── Sort helpers ─────────────────────────────────────────────────────────────

function sortEntries(entries: RcfEntry[], field: SortField, dir: SortDir): RcfEntry[] {
  return [...entries].sort((a, b) => {
    let aVal = '';
    let bVal = '';
    switch (field) {
      case 'did':        aVal = a.did;                  bVal = b.did;                  break;
      case 'name':       aVal = a.name ?? '';            bVal = b.name ?? '';           break;
      case 'forward_to': aVal = a.forward_to;            bVal = b.forward_to;           break;
      case 'customer':   aVal = a.customer_name ?? '';   bVal = b.customer_name ?? '';  break;
      case 'status':     aVal = String(a.enabled);       bVal = String(b.enabled);      break;
    }
    const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
    return dir === 'asc' ? cmp : -cmp;
  });
}

// ─── EnableToggle ─────────────────────────────────────────────────────────────

function EnableToggle({ entry, canEdit }: { entry: RcfEntry; canEdit: boolean }) {
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
        width: 38,
        height: 22,
        borderRadius: 11,
        border: `1px solid ${enabled ? 'rgba(59,130,246,0.55)' : 'rgba(255,255,255,0.12)'}`,
        background: enabled
          ? 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)'
          : 'rgba(255,255,255,0.06)',
        cursor: canEdit && !pending ? 'pointer' : 'not-allowed',
        transition: 'background 0.2s ease, border-color 0.2s ease, opacity 0.2s',
        opacity: pending ? 0.55 : 1,
        flexShrink: 0,
        padding: 0,
        outline: 'none',
        boxShadow: enabled ? '0 0 8px rgba(59,130,246,0.35)' : 'none',
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: enabled ? 18 : 2,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: '#fff',
          boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
          transition: 'left 0.2s ease',
        }}
      />
    </button>
  );
}

// ─── CallerIdToggle ──────────────────────────────────────────────────────────

function CallerIdToggle({ entry, canEdit }: { entry: RcfEntry; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const mutation = useMutation({
    mutationFn: (pass: boolean) => updateRcfPassCallerId(entry.id, pass),
    onSuccess: (_, pass) => {
      void queryClient.invalidateQueries({ queryKey: ['rcf'] });
      toastOk(pass ? `Caller ID pass-through enabled for ${fmt(entry.did)}` : `Caller ID will show ${fmt(entry.did)} instead`);
    },
    onError: (err: Error) => toastErr(err.message ?? 'Failed to update'),
  });

  const passthrough = entry.pass_caller_id;
  const pending = mutation.isPending;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        role="switch"
        aria-checked={passthrough}
        disabled={!canEdit || pending}
        onClick={() => { if (canEdit && !pending) mutation.mutate(!passthrough); }}
        title={canEdit ? (passthrough ? 'Showing original caller ID — click to show your DID instead' : 'Showing your DID — click to pass through original caller ID') : 'Caller ID setting'}
        style={{
          position: 'relative',
          display: 'inline-flex',
          alignItems: 'center',
          width: 38,
          height: 22,
          borderRadius: 11,
          border: `1px solid ${passthrough ? 'rgba(59,130,246,0.55)' : 'rgba(255,255,255,0.12)'}`,
          background: passthrough
            ? 'linear-gradient(135deg, rgba(59,130,246,0.5) 0%, rgba(59,130,246,0.35) 100%)'
            : 'rgba(255,255,255,0.06)',
          cursor: canEdit ? 'pointer' : 'not-allowed',
          transition: 'background 0.2s, border-color 0.2s, box-shadow 0.2s',
          flexShrink: 0,
          padding: 0,
          outline: 'none',
          boxShadow: passthrough ? '0 0 8px rgba(59,130,246,0.35)' : 'none',
          opacity: pending ? 0.5 : 1,
        }}
      >
        <span
          style={{
            position: 'absolute',
            left: passthrough ? 18 : 2,
            width: 16,
            height: 16,
            borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 1px 3px rgba(0,0,0,0.4)',
            transition: 'left 0.2s ease',
          }}
        />
      </button>
      <span style={{ fontSize: '0.72rem', color: passthrough ? '#60a5fa' : '#475569', fontWeight: 500, whiteSpace: 'nowrap' }}>
        {passthrough ? 'Pass-through' : 'Show DID'}
      </span>
    </div>
  );
}

// ─── SortHeader ───────────────────────────────────────────────────────────────

interface SortHeaderProps {
  label: string;
  field: SortField;
  currentField: SortField;
  currentDir: SortDir;
  onSort: (field: SortField) => void;
}

function SortHeader({ label, field, currentField, currentDir, onSort }: SortHeaderProps) {
  const isActive = currentField === field;
  return (
    <th
      onClick={() => onSort(field)}
      style={{
        padding: '12px 16px',
        textAlign: 'left',
        fontSize: '0.6rem',
        fontWeight: 700,
        color: isActive ? '#60a5fa' : '#475569',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        whiteSpace: 'nowrap',
        background: 'rgba(59,130,246,0.04)',
        cursor: 'pointer',
        userSelect: 'none',
        transition: 'color 0.15s',
        borderBottom: '1px solid rgba(59,130,246,0.10)',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {label}
        {isActive ? (
          <span style={{ color: '#3b82f6', fontSize: '0.75rem', lineHeight: 1 }}>
            {currentDir === 'asc' ? '↑' : '↓'}
          </span>
        ) : (
          <span style={{ color: '#334155', fontSize: '0.75rem', lineHeight: 1 }}>↕</span>
        )}
      </span>
    </th>
  );
}

// ─── ForwardToCell ────────────────────────────────────────────────────────────

interface ForwardToCellProps {
  entry: RcfEntry;
  canEdit: boolean;
  pendingValue: string;
  onPendingChange: (did: string, value: string) => void;
}

function ForwardToCell({ entry, canEdit, pendingValue, onPendingChange }: ForwardToCellProps) {
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

  if (editing && canEdit) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
            width: 150,
            fontSize: '0.82rem',
            padding: '5px 9px',
            borderRadius: 7,
            border: `1px solid ${isDirty ? '#3b82f6' : 'rgba(59,130,246,0.25)'}`,
            background: 'rgba(15,17,23,0.85)',
            color: '#e2e8f0',
            fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
            outline: 'none',
            boxShadow: isDirty ? '0 0 0 3px rgba(59,130,246,0.18)' : '0 0 0 2px rgba(59,130,246,0.1)',
            opacity: mutation.isPending ? 0.5 : 1,
            transition: 'border-color 0.15s, box-shadow 0.15s',
          }}
        />
        <button
          type="button"
          disabled={!isDirty || mutation.isPending}
          onMouseDown={(e) => { e.preventDefault(); handleSave(); }}
          style={{
            fontSize: '0.65rem',
            fontWeight: 700,
            padding: '5px 11px',
            borderRadius: 5,
            border: 'none',
            background: isDirty && !mutation.isPending
              ? 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)'
              : 'rgba(59,130,246,0.25)',
            color: '#fff',
            cursor: isDirty && !mutation.isPending ? 'pointer' : 'not-allowed',
            flexShrink: 0,
            lineHeight: 1,
            letterSpacing: '0.02em',
            transition: 'background 0.15s',
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
            color: '#64748b',
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
      style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: canEdit ? 'pointer' : 'default' }}
      onMouseEnter={() => { if (canEdit) setHovered(true); }}
      onMouseLeave={() => setHovered(false)}
      onClick={() => { if (canEdit) setEditing(true); }}
      title={canEdit ? 'Click to edit destination' : undefined}
    >
      <span
        style={{
          fontSize: '0.84rem',
          color: savedFlash ? '#60a5fa' : '#3b82f6',
          fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
          fontWeight: 600,
          letterSpacing: '0.01em',
          borderBottom: canEdit ? `1px dashed rgba(59,130,246,${hovered ? '0.6' : '0.28'})` : 'none',
          paddingBottom: canEdit ? 1 : 0,
          transition: 'color 0.25s, border-color 0.2s',
        }}
      >
        {fmt(entry.forward_to)}
      </span>
      {canEdit && (
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            width: 12,
            height: 12,
            color: '#3b82f6',
            opacity: hovered ? 0.7 : 0,
            transition: 'opacity 0.2s',
            flexShrink: 0,
          }}
        >
          <path d="M11.5 2.5a1.414 1.414 0 0 1 2 2L5 13H2v-3L11.5 2.5z" />
        </svg>
      )}
    </div>
  );
}

// ─── TableRow ─────────────────────────────────────────────────────────────────

interface TableRowProps {
  entry: RcfEntry;
  isAdmin: boolean;
  canEdit: boolean;
  pendingValue: string;
  onPendingChange: (did: string, value: string) => void;
}

function TableRow({ entry, isAdmin, canEdit, pendingValue, onPendingChange }: TableRowProps) {
  const [hovered, setHovered] = useState(false);

  return (
    <tr
      style={{
        borderBottom: '1px solid rgba(59,130,246,0.06)',
        background: hovered ? 'rgba(59,130,246,0.05)' : 'transparent',
        transition: 'background 0.18s ease',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* DID */}
      <td style={{ padding: '14px 16px' }}>
        <div>
          <div
            style={{
              fontSize: '0.9rem',
              fontWeight: 700,
              color: '#e2e8f0',
              fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
              letterSpacing: '0.02em',
              lineHeight: 1.2,
            }}
          >
            {fmt(entry.did)}
          </div>
          <div style={{ fontSize: '0.63rem', color: '#334155', fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', marginTop: 3, letterSpacing: '0.01em' }}>
            {entry.did}
          </div>
        </div>
      </td>

      {/* Name */}
      <td style={{ padding: '14px 16px' }}>
        <span
          style={{
            fontSize: '0.83rem',
            color: entry.name ? '#cbd5e0' : '#2d3748',
            fontStyle: entry.name ? 'normal' : 'italic',
          }}
        >
          {entry.name ?? 'No label'}
        </span>
      </td>

      {/* Forward To */}
      <td style={{ padding: '10px 16px' }}>
        <ForwardToCell
          entry={entry}
          canEdit={canEdit}
          pendingValue={pendingValue}
          onPendingChange={onPendingChange}
        />
      </td>

      {/* Status — toggle switch */}
      <td style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <EnableToggle entry={entry} canEdit={canEdit} />
          <span
            style={{
              fontSize: '0.72rem',
              fontWeight: 600,
              color: entry.enabled ? '#60a5fa' : '#475569',
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              transition: 'color 0.2s',
            }}
          >
            {entry.enabled ? 'Active' : 'Disabled'}
          </span>
        </div>
      </td>

      {/* Caller ID — pass-through toggle */}
      <td style={{ padding: '14px 16px' }}>
        <CallerIdToggle entry={entry} canEdit={canEdit} />
      </td>

      {/* Customer (admin only) */}
      {isAdmin && (
        <td style={{ padding: '14px 16px' }}>
          <span
            style={{
              fontSize: '0.78rem',
              color: '#64748b',
              background: 'rgba(59,130,246,0.06)',
              border: '1px solid rgba(59,130,246,0.12)',
              borderRadius: 6,
              padding: '2px 8px',
              whiteSpace: 'nowrap',
            }}
          >
            {entry.customer_name ?? `ID ${entry.customer_id}`}
          </span>
        </td>
      )}
    </tr>
  );
}

// ─── PaginationControls ───────────────────────────────────────────────────────

interface PaginationControlsProps {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

function PaginationControls({
  currentPage,
  totalPages,
  pageSize,
  totalItems,
  onPageChange,
  onPageSizeChange,
}: PaginationControlsProps) {
  const start = (currentPage - 1) * pageSize + 1;
  const end = Math.min(currentPage * pageSize, totalItems);

  const pageNumbers: (number | 'ellipsis')[] = [];
  if (totalPages <= 7) {
    for (let i = 1; i <= totalPages; i++) pageNumbers.push(i);
  } else {
    pageNumbers.push(1);
    if (currentPage > 3) pageNumbers.push('ellipsis');
    const rangeStart = Math.max(2, currentPage - 1);
    const rangeEnd = Math.min(totalPages - 1, currentPage + 1);
    for (let i = rangeStart; i <= rangeEnd; i++) pageNumbers.push(i);
    if (currentPage < totalPages - 2) pageNumbers.push('ellipsis');
    pageNumbers.push(totalPages);
  }

  const btnStyle = (active: boolean, disabled: boolean): React.CSSProperties => ({
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 32,
    height: 32,
    padding: '0 8px',
    borderRadius: 7,
    fontSize: '0.78rem',
    fontWeight: active ? 700 : 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    border: active ? '1px solid rgba(59,130,246,0.45)' : '1px solid rgba(255,255,255,0.06)',
    background: active
      ? 'linear-gradient(135deg, rgba(59,130,246,0.22) 0%, rgba(59,130,246,0.10) 100%)'
      : 'rgba(255,255,255,0.02)',
    color: active ? '#60a5fa' : disabled ? '#1e293b' : '#64748b',
    opacity: disabled ? 0.4 : 1,
    transition: 'background 0.12s, color 0.12s, border-color 0.12s',
    userSelect: 'none',
    fontFamily: 'inherit',
    boxShadow: active ? '0 0 10px rgba(59,130,246,0.15)' : 'none',
  });

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexWrap: 'wrap',
        gap: 12,
        padding: '14px 20px',
        borderTop: '1px solid rgba(59,130,246,0.08)',
        background: 'rgba(59,130,246,0.02)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
          Showing{' '}
          <strong style={{ color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>{start}–{end}</strong>
          {' '}of{' '}
          <strong style={{ color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>{totalItems}</strong>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: '0.7rem', color: '#475569' }}>Per page:</span>
          <select
            value={pageSize}
            onChange={(e) => { onPageSizeChange(Number(e.target.value)); onPageChange(1); }}
            style={{
              fontSize: '0.75rem',
              background: 'rgba(15,17,23,0.8)',
              border: '1px solid rgba(59,130,246,0.18)',
              borderRadius: 7,
              color: '#94a3b8',
              padding: '4px 8px',
              cursor: 'pointer',
              fontFamily: 'inherit',
              outline: 'none',
            }}
          >
            {PAGE_SIZE_OPTIONS.map((n) => (
              <option key={n} value={n}>{n}</option>
            ))}
          </select>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
        <button
          type="button"
          disabled={currentPage === 1}
          onClick={() => onPageChange(currentPage - 1)}
          style={btnStyle(false, currentPage === 1)}
          aria-label="Previous page"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 11, height: 11 }}>
            <path d="M10 12L6 8l4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {pageNumbers.map((p, i) =>
          p === 'ellipsis' ? (
            <span key={`ell-${i}`} style={{ color: '#334155', padding: '0 4px', fontSize: '0.78rem' }}>…</span>
          ) : (
            <button key={p} type="button" onClick={() => onPageChange(p)} style={btnStyle(currentPage === p, false)}>
              {p}
            </button>
          ),
        )}

        <button
          type="button"
          disabled={currentPage === totalPages}
          onClick={() => onPageChange(currentPage + 1)}
          style={btnStyle(false, currentPage === totalPages)}
          aria-label="Next page"
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 11, height: 11 }}>
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ─── Page header ──────────────────────────────────────────────────────────────

interface RcfPageHeaderProps {
  title: string;
  subtitle: string;
  totalNumbers: number;
  activeCount: number;
  disabledCount: number;
}

function RcfPageHeader({ title, subtitle, totalNumbers, activeCount, disabledCount }: RcfPageHeaderProps) {
  return (
    <div
      className="animate-fade-in-up"
      style={{
        position: 'relative',
        background: 'rgba(19, 21, 29, 0.72)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        border: '1px solid rgba(59,130,246,0.16)',
        borderRadius: 20,
        padding: '32px 36px 28px',
        marginBottom: 28,
        overflow: 'hidden',
        boxShadow: '0 8px 40px -12px rgba(0,0,0,0.55), 0 0 0 1px rgba(59,130,246,0.06)',
      }}
    >
      {/* Top accent line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 48,
          right: 48,
          height: 2,
          background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.7), transparent)',
          borderRadius: '0 0 2px 2px',
        }}
      />

      {/* Subtle radial glow background */}
      <div
        style={{
          position: 'absolute',
          top: -60,
          right: -60,
          width: 280,
          height: 280,
          background: 'radial-gradient(circle, rgba(59,130,246,0.07) 0%, transparent 70%)',
          pointerEvents: 'none',
        }}
      />

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 24 }}>
        {/* CRAG logo with glow */}
        <div style={{ flexShrink: 0, position: 'relative' }}>
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: 'linear-gradient(135deg, rgba(59,130,246,0.18) 0%, rgba(59,130,246,0.08) 100%)',
              border: '1px solid rgba(59,130,246,0.28)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 24px rgba(59,130,246,0.20)',
            }}
          >
            <img
              src="/crag.png"
              alt="CRAG"
              style={{
                width: 36,
                height: 36,
                objectFit: 'contain',
                filter: 'drop-shadow(0 0 8px rgba(59,130,246,0.55)) brightness(1.1)',
              }}
            />
          </div>
        </div>

        {/* Title + subtitle */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: '0.6rem',
              fontWeight: 600,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: '#3b82f6',
              opacity: 0.8,
              marginBottom: 6,
            }}
          >
            Remote Call Forwarding
          </div>
          <h1
            style={{
              fontSize: 'clamp(1.2rem, 2.5vw, 1.55rem)',
              fontWeight: 800,
              color: '#e2e8f0',
              letterSpacing: '-0.025em',
              lineHeight: 1.15,
              margin: '0 0 8px',
            }}
          >
            {title}
          </h1>
          <p
            style={{
              fontSize: '0.85rem',
              color: '#718096',
              lineHeight: 1.65,
              margin: 0,
              maxWidth: 500,
            }}
          >
            {subtitle}
          </p>
        </div>

        {/* Stats row — right aligned */}
        {totalNumbers > 0 && (
          <div
            style={{
              display: 'flex',
              gap: 12,
              flexShrink: 0,
              alignSelf: 'center',
            }}
          >
            {(
              [
                { value: totalNumbers, label: 'Total', color: '#60a5fa' },
                { value: activeCount, label: 'Active', color: '#3b82f6' },
                ...(disabledCount > 0 ? [{ value: disabledCount, label: 'Disabled', color: '#ef4444' }] : []),
              ] as { value: number; label: string; color: string }[]
            ).map(({ value, label, color }) => (
              <div
                key={label}
                style={{
                  textAlign: 'center',
                  padding: '12px 16px',
                  background: 'rgba(15,17,23,0.55)',
                  border: '1px solid rgba(59,130,246,0.12)',
                  borderRadius: 12,
                  minWidth: 68,
                }}
              >
                <div
                  style={{
                    fontSize: '1.6rem',
                    fontWeight: 800,
                    color,
                    lineHeight: 1,
                    letterSpacing: '-0.03em',
                    fontVariantNumeric: 'tabular-nums',
                    marginBottom: 4,
                  }}
                >
                  {value}
                </div>
                <div
                  style={{
                    fontSize: '0.62rem',
                    fontWeight: 600,
                    color: '#475569',
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                  }}
                >
                  {label}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Empty states ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '80px 24px',
        gap: 16,
        textAlign: 'center',
        background: 'rgba(19, 21, 29, 0.65)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: '1px solid rgba(59,130,246,0.10)',
        borderRadius: 20,
      }}
    >
      <div
        style={{
          width: 72,
          height: 72,
          borderRadius: 18,
          background: 'linear-gradient(135deg, rgba(59,130,246,0.14) 0%, rgba(59,130,246,0.06) 100%)',
          border: '1px solid rgba(59,130,246,0.22)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 8,
          boxShadow: '0 0 24px rgba(59,130,246,0.12)',
        }}
      >
        <img
          src="/crag.png"
          alt="CRAG"
          style={{
            width: 44,
            height: 44,
            objectFit: 'contain',
            filter: 'drop-shadow(0 0 8px rgba(59,130,246,0.5)) brightness(1.1)',
            opacity: 0.7,
          }}
        />
      </div>
      <div>
        <p style={{ color: '#94a3b8', fontSize: '1rem', fontWeight: 600, margin: '0 0 6px' }}>
          No numbers configured yet
        </p>
        <p style={{ color: '#475569', fontSize: '0.82rem', margin: 0, lineHeight: 1.6 }}>
          Contact support to provision Remote Call Forwarding numbers for your account.
        </p>
      </div>
    </div>
  );
}

function SearchEmptyState({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '60px 24px',
        gap: 12,
        textAlign: 'center',
        background: 'rgba(19, 21, 29, 0.55)',
        border: '1px solid rgba(59,130,246,0.08)',
        borderRadius: 16,
      }}
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        style={{ width: 36, height: 36, color: '#3b4560', marginBottom: 4 }}
      >
        <path d="m21 21-5.197-5.197M15.803 15.803A7.5 7.5 0 1 0 4.197 4.197a7.5 7.5 0 0 0 11.606 11.606Z" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <p style={{ color: '#64748b', fontSize: '0.9rem', fontWeight: 500, margin: 0 }}>
        No numbers match &ldquo;{query}&rdquo;
      </p>
      <button
        type="button"
        onClick={onClear}
        style={{
          background: 'transparent',
          border: 'none',
          color: '#3b82f6',
          fontSize: '0.8rem',
          cursor: 'pointer',
          textDecoration: 'underline',
          fontFamily: 'inherit',
          padding: 0,
        }}
      >
        Clear filter
      </button>
    </div>
  );
}

// ─── Tab types ────────────────────────────────────────────────────────────────

type DashboardTab = 'numbers' | 'activity' | 'dids';

// ─── Time helpers ─────────────────────────────────────────────────────────────

function timeAgo(isoString: string): string {
  const now = Date.now();
  const then = new Date(isoString).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// ─── Quality colour helpers ────────────────────────────────────────────────────

function mosLabel(mos: number | null | undefined): { text: string; color: string; dot: string } {
  if (mos == null) return { text: '—', color: '#4a5568', dot: '#4a5568' };
  if (mos >= 4.0) return { text: 'Great', color: '#22c55e', dot: '#22c55e' };
  if (mos >= 3.0) return { text: 'OK', color: '#f59e0b', dot: '#f59e0b' };
  return { text: 'Poor', color: '#ef4444', dot: '#ef4444' };
}

function carrierDisplayName(carrier: string | null | undefined): string {
  if (!carrier) return '—';
  switch (carrier) {
    case 'carrier_primary': return 'Bandwidth Dallas';
    case 'carrier_secondary': return 'Bandwidth LA';
    default: return carrier.replace(/^carrier_/, '').replace(/_/g, ' ');
  }
}

function callStatusInfo(cdr: Cdr): { label: string; bg: string; color: string; border: string } {
  const GREEN  = { bg: 'rgba(34,197,94,0.12)',  color: '#4ade80', border: '1px solid rgba(34,197,94,0.2)' };
  const AMBER  = { bg: 'rgba(245,158,11,0.12)', color: '#f59e0b', border: '1px solid rgba(245,158,11,0.2)' };
  const RED    = { bg: 'rgba(239,68,68,0.12)',   color: '#f87171', border: '1px solid rgba(239,68,68,0.2)' };
  const BLUE   = { bg: 'rgba(59,130,246,0.12)',  color: '#60a5fa', border: '1px solid rgba(59,130,246,0.2)' };

  const cause = (cdr.hangup_cause ?? '').toUpperCase();

  // Answered calls (has answer_time and non-zero duration)
  if (cdr.answer_time != null && cdr.duration_seconds > 0) {
    return { label: 'Answered', ...GREEN };
  }

  // Map specific hangup causes to friendly labels
  switch (cause) {
    case 'ORIGINATOR_CANCEL':
      return { label: 'Caller Hung Up', ...AMBER };
    case 'NO_ANSWER':
      return { label: 'No Answer', ...AMBER };
    case 'USER_BUSY':
      return { label: 'Busy', ...RED };
    case 'CALL_REJECTED':
      return { label: 'Rejected', ...RED };
    case 'NORMAL_TEMPORARY_FAILURE':
      return { label: 'Unavailable', ...RED };
    case 'UNALLOCATED_NUMBER':
      return { label: 'Invalid Number', ...RED };
    case 'NO_ROUTE_DESTINATION':
      return { label: 'No Route', ...RED };
    case 'RECOVERY_ON_TIMER_EXPIRE':
      return { label: 'Timed Out', ...RED };
    case 'NORMAL_CLEARING':
      // NORMAL_CLEARING without answer_time = very short call or signaling-only
      if (cdr.answer_time == null) return { label: 'Not Connected', ...AMBER };
      return { label: 'Answered', ...GREEN };
    default:
      break;
  }

  // SIP error codes
  if (cdr.sip_code != null && cdr.sip_code >= 400) {
    if (cdr.sip_code === 486) return { label: 'Busy', ...RED };
    if (cdr.sip_code === 487) return { label: 'Cancelled', ...AMBER };
    if (cdr.sip_code === 603) return { label: 'Declined', ...RED };
    return { label: 'Failed', ...RED };
  }

  // Fallback: no answer_time and zero duration = never connected
  if (cdr.answer_time == null) {
    return { label: 'No Answer', ...AMBER };
  }

  return { label: 'Answered', ...BLUE };
}

// ─── TabBar ───────────────────────────────────────────────────────────────────

interface TabBarProps {
  active: DashboardTab;
  onChange: (tab: DashboardTab) => void;
}

function TabBar({ active, onChange }: TabBarProps) {
  const tabs: { id: DashboardTab; label: string; icon: React.ReactNode }[] = [
    {
      id: 'numbers',
      label: 'Numbers',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 13, height: 13 }}>
          <rect x="2" y="2" width="5" height="5" rx="1.5" />
          <rect x="9" y="2" width="5" height="5" rx="1.5" />
          <rect x="2" y="9" width="5" height="5" rx="1.5" />
          <rect x="9" y="9" width="5" height="5" rx="1.5" />
        </svg>
      ),
    },
    {
      id: 'activity',
      label: 'Call Activity',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 13, height: 13 }}>
          <path d="M2 12 L4 8 L6 10 L9 5 L11 7 L14 3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ),
    },
    {
      id: 'dids',
      label: 'DID Management',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 13, height: 13 }}>
          <rect x="2" y="2" width="12" height="12" rx="2" />
          <path d="M5 8h6M8 5v6" strokeLinecap="round" />
        </svg>
      ),
    },
  ];

  return (
    <div
      style={{
        display: 'flex',
        gap: 0,
        background: 'rgba(15,17,23,0.55)',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        border: '1px solid rgba(59,130,246,0.12)',
        borderRadius: 12,
        padding: 4,
        marginBottom: 24,
      }}
    >
      {tabs.map((tab) => {
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              padding: '9px 16px',
              borderRadius: 9,
              border: 'none',
              cursor: 'pointer',
              fontSize: '0.82rem',
              fontWeight: isActive ? 700 : 500,
              fontFamily: 'inherit',
              color: isActive ? '#e2e8f0' : '#64748b',
              background: isActive
                ? 'linear-gradient(135deg, rgba(59,130,246,0.22) 0%, rgba(59,130,246,0.12) 100%)'
                : 'transparent',
              boxShadow: isActive
                ? '0 0 14px rgba(59,130,246,0.18), inset 0 1px 0 rgba(255,255,255,0.06)'
                : 'none',
              transition: 'all 0.18s ease',
              whiteSpace: 'nowrap',
              letterSpacing: isActive ? '-0.01em' : 'normal',
              position: 'relative',
            }}
          >
            <span style={{ color: isActive ? '#60a5fa' : '#475569', transition: 'color 0.18s' }}>
              {tab.icon}
            </span>
            {tab.label}
            {isActive && (
              <span
                style={{
                  position: 'absolute',
                  bottom: -4,
                  left: '30%',
                  right: '30%',
                  height: 2,
                  background: 'linear-gradient(90deg, transparent, #3b82f6, transparent)',
                  borderRadius: 2,
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

// ─── CallActivityTab ──────────────────────────────────────────────────────────

interface CallActivityTabProps {
  customerId: number | undefined;
}

/** Compute aggregate quality stats from a list of CDRs. */
function computeQualityStats(cdrs: Cdr[]) {
  let answered = 0;
  let mosSum = 0;
  let mosCount = 0;
  let durationSum = 0;

  for (const cdr of cdrs) {
    if (cdr.answer_time != null && cdr.duration_seconds > 0) {
      answered++;
      durationSum += cdr.duration_seconds;
    }
    if (cdr.mos != null) {
      mosSum += cdr.mos;
      mosCount++;
    }
  }

  const total = cdrs.length;
  const asr = total > 0 ? (answered / total) * 100 : null;
  const avgMos = mosCount > 0 ? mosSum / mosCount : null;
  const acd = answered > 0 ? durationSum / answered : null;

  return { total, answered, asr, avgMos, acd };
}

// ─── DailyStats type ─────────────────────────────────────────────────────────

interface DailyStats {
  date: string;          // YYYY-MM-DD
  label: string;         // "Mon, Apr 28"
  shortLabel: string;    // "Mon"
  total: number;
  answered: number;
  asr: number | null;    // 0–100, null if no calls
  avgMos: number | null; // 1.0–5.0, null if no MOS data
}

/** Build daily quality summary for the last 7 days. */
function buildDailyDots(cdrs: Cdr[]): DailyStats[] {
  const byDate = new Map<string, { mosSum: number; mosCount: number; total: number; answered: number }>();

  for (const cdr of cdrs) {
    const key = cdr.start_time.slice(0, 10);
    const bucket = byDate.get(key) ?? { mosSum: 0, mosCount: 0, total: 0, answered: 0 };
    bucket.total++;
    if (cdr.answer_time != null && cdr.duration_seconds > 0) bucket.answered++;
    if (cdr.mos != null) { bucket.mosSum += cdr.mos; bucket.mosCount++; }
    byDate.set(key, bucket);
  }

  const result: DailyStats[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const shortLabel = d.toLocaleDateString(undefined, { weekday: 'short' });
    const b = byDate.get(key);

    if (!b || b.total === 0) {
      result.push({ date: key, label, shortLabel, total: 0, answered: 0, asr: null, avgMos: null });
      continue;
    }

    const asr = (b.answered / b.total) * 100;
    const avgMos = b.mosCount > 0 ? b.mosSum / b.mosCount : null;
    result.push({ date: key, label, shortLabel, total: b.total, answered: b.answered, asr, avgMos });
  }
  return result;
}

// ─── WeeklyChart ──────────────────────────────────────────────────────────────

interface WeeklyChartProps {
  days: DailyStats[];
}

function WeeklyChart({ days }: WeeklyChartProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  // Chart geometry constants
  const W = 600;
  const H = 180;
  const PAD_LEFT = 36;   // room for left Y-axis labels
  const PAD_RIGHT = 36;  // room for right Y-axis labels
  const PAD_TOP = 14;
  const PAD_BOTTOM = 28; // room for X-axis labels
  const innerW = W - PAD_LEFT - PAD_RIGHT;
  const innerH = H - PAD_TOP - PAD_BOTTOM;

  // X positions for 7 evenly spaced data points
  const xPos = (i: number) => PAD_LEFT + (i / 6) * innerW;

  // Y scale helpers: MOS 1–5 on left, ASR 0–100 on right
  const yMos = (v: number) => PAD_TOP + (1 - (v - 1) / 4) * innerH;
  const yAsr = (v: number) => PAD_TOP + (1 - v / 100) * innerH;

  // Build monotone cubic spline paths, skipping gaps where data is null.
  // Returns a single SVG path `d` string with M/C segments.
  function buildSplinePath(
    points: Array<{ x: number; y: number } | null>,
  ): string {
    const segments: string[] = [];
    let runStart = -1;
    let run: Array<{ x: number; y: number }> = [];

    const flushRun = () => {
      if (run.length === 0) return;
      if (run.length === 1) {
        // Single isolated point — just move there, no line
        segments.push(`M ${run[0].x} ${run[0].y}`);
      } else {
        segments.push(monotoneCubicPath(run));
      }
      run = [];
      runStart = -1;
    };

    for (let i = 0; i < points.length; i++) {
      const pt = points[i];
      if (pt === null) {
        flushRun();
      } else {
        if (runStart === -1) runStart = i;
        run.push(pt);
      }
    }
    flushRun();
    return segments.join(' ');
  }

  // Monotone cubic interpolation — produces smooth curves that never overshoot
  function monotoneCubicPath(pts: Array<{ x: number; y: number }>): string {
    if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;
    const n = pts.length;
    // Compute slopes
    const dx = pts.map((p, i) => i < n - 1 ? pts[i + 1].x - p.x : 0);
    const dy = pts.map((p, i) => i < n - 1 ? pts[i + 1].y - p.y : 0);
    const m = pts.map((_, i) => i < n - 1 ? dy[i] / dx[i] : 0);
    // Tangents
    const t: number[] = new Array(n).fill(0);
    t[0] = m[0];
    t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = (m[i - 1] + m[i]) / 2;
    // Monotonicity correction
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = t[i + 1] = 0; continue; }
      const alpha = t[i] / m[i];
      const beta = t[i + 1] / m[i];
      const s = alpha * alpha + beta * beta;
      if (s > 9) { const k = 3 / Math.sqrt(s); t[i] *= k; t[i + 1] *= k; }
    }
    // Build path
    let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
    for (let i = 0; i < n - 1; i++) {
      const cp1x = pts[i].x + dx[i] / 3;
      const cp1y = pts[i].y + t[i] * dx[i] / 3;
      const cp2x = pts[i + 1].x - dx[i] / 3;
      const cp2y = pts[i + 1].y - t[i + 1] * dx[i] / 3;
      d += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${pts[i + 1].x.toFixed(2)} ${pts[i + 1].y.toFixed(2)}`;
    }
    return d;
  }

  // Build area fill path: line path + vertical drop to baseline + close
  function buildAreaPath(
    points: Array<{ x: number; y: number } | null>,
    baseline: number,
  ): string {
    // Collect contiguous runs and build filled polygons for each
    const areas: string[] = [];
    let run: Array<{ x: number; y: number }> = [];

    const flushArea = () => {
      if (run.length < 2) { run = []; return; }
      const linePath = monotoneCubicPath(run);
      // Drop from last point to baseline, go left to first point's X, close
      const closeSegment = ` L ${run[run.length - 1].x.toFixed(2)} ${baseline.toFixed(2)} L ${run[0].x.toFixed(2)} ${baseline.toFixed(2)} Z`;
      areas.push(linePath + closeSegment);
      run = [];
    };

    for (const pt of points) {
      if (pt === null) { flushArea(); } else { run.push(pt); }
    }
    flushArea();
    return areas.join(' ');
  }

  const mosMemo = useMemo(() => {
    const pts = days.map((d, i) =>
      d.avgMos !== null ? { x: xPos(i), y: yMos(d.avgMos) } : null,
    );
    return {
      linePath: buildSplinePath(pts),
      areaPath: buildAreaPath(pts, PAD_TOP + innerH),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const asrMemo = useMemo(() => {
    const pts = days.map((d, i) =>
      d.asr !== null ? { x: xPos(i), y: yAsr(d.asr) } : null,
    );
    return {
      linePath: buildSplinePath(pts),
      areaPath: buildAreaPath(pts, PAD_TOP + innerH),
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const hoveredDay = hoveredIdx !== null ? days[hoveredIdx] : null;

  return (
    <div
      style={{
        background: 'rgba(19,21,29,0.68)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        border: '1px solid rgba(59,130,246,0.10)',
        borderRadius: 14,
        padding: '16px 20px',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
        <div
          style={{
            width: 22,
            height: 22,
            borderRadius: 6,
            background: 'rgba(96,165,250,0.12)',
            border: '1px solid rgba(96,165,250,0.22)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="#60a5fa" strokeWidth={1.8} style={{ width: 10, height: 10 }}>
            <polyline points="1,12 5,7 8,9 12,4 15,6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <span style={{ fontSize: '0.68rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          7-Day Performance
        </span>
      </div>

      {/* SVG chart — uses viewBox for responsive width */}
      <div style={{ position: 'relative' }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
          aria-label="7-day call quality chart"
        >
          <defs>
            {/* MOS gradient */}
            <linearGradient id="mos-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#4ade80" stopOpacity="0.18" />
              <stop offset="100%" stopColor="#4ade80" stopOpacity="0" />
            </linearGradient>
            {/* ASR gradient */}
            <linearGradient id="asr-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.14" />
              <stop offset="100%" stopColor="#60a5fa" stopOpacity="0" />
            </linearGradient>
            {/* MOS line glow filter */}
            <filter id="mos-glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
            {/* ASR line glow filter */}
            <filter id="asr-glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          {/* ── Background grid lines (regular, very subtle) ──────── */}
          {[1, 2, 3, 4, 5].map((mosVal) => {
            const y = yMos(mosVal);
            return (
              <line
                key={`mos-grid-${mosVal}`}
                x1={PAD_LEFT} y1={y} x2={PAD_LEFT + innerW} y2={y}
                stroke="rgba(255,255,255,0.03)"
                strokeWidth={1}
              />
            );
          })}

          {/* ── Threshold grid lines (slightly brighter, dashed) ──── */}
          {/* MOS 3.0 threshold (amber zone boundary) */}
          <line
            x1={PAD_LEFT} y1={yMos(3.0)} x2={PAD_LEFT + innerW} y2={yMos(3.0)}
            stroke="rgba(245,158,11,0.18)"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
          {/* MOS 4.0 threshold (excellent boundary) */}
          <line
            x1={PAD_LEFT} y1={yMos(4.0)} x2={PAD_LEFT + innerW} y2={yMos(4.0)}
            stroke="rgba(74,222,128,0.14)"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
          {/* ASR 85% threshold */}
          <line
            x1={PAD_LEFT} y1={yAsr(85)} x2={PAD_LEFT + innerW} y2={yAsr(85)}
            stroke="rgba(245,158,11,0.12)"
            strokeWidth={1}
            strokeDasharray="3 5"
          />
          {/* ASR 95% threshold */}
          <line
            x1={PAD_LEFT} y1={yAsr(95)} x2={PAD_LEFT + innerW} y2={yAsr(95)}
            stroke="rgba(96,165,250,0.12)"
            strokeWidth={1}
            strokeDasharray="3 5"
          />

          {/* ── Y-axis labels (left = MOS) ─────────────────────────── */}
          {[1, 2, 3, 4, 5].map((v) => (
            <text
              key={`mos-label-${v}`}
              x={PAD_LEFT - 5}
              y={yMos(v) + 4}
              textAnchor="end"
              fill="#334155"
              fontSize={8}
              fontFamily={'"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace'}
            >
              {v}
            </text>
          ))}

          {/* ── Y-axis labels (right = ASR%) ──────────────────────── */}
          {[0, 50, 85, 95, 100].map((v) => (
            <text
              key={`asr-label-${v}`}
              x={PAD_LEFT + innerW + 5}
              y={yAsr(v) + 4}
              textAnchor="start"
              fill="#334155"
              fontSize={8}
              fontFamily={'"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace'}
            >
              {v}%
            </text>
          ))}

          {/* ── Left axis label ───────────────────────────────────── */}
          <text
            x={8}
            y={PAD_TOP + innerH / 2}
            textAnchor="middle"
            fill="#334155"
            fontSize={7.5}
            fontFamily="system-ui, sans-serif"
            letterSpacing="0.05em"
            transform={`rotate(-90, 8, ${PAD_TOP + innerH / 2})`}
          >
            MOS
          </text>

          {/* ── Right axis label ──────────────────────────────────── */}
          <text
            x={W - 6}
            y={PAD_TOP + innerH / 2}
            textAnchor="middle"
            fill="#334155"
            fontSize={7.5}
            fontFamily="system-ui, sans-serif"
            letterSpacing="0.05em"
            transform={`rotate(90, ${W - 6}, ${PAD_TOP + innerH / 2})`}
          >
            ASR%
          </text>

          {/* ── Area fills ────────────────────────────────────────── */}
          <path d={mosMemo.areaPath} fill="url(#mos-fill)" />
          <path d={asrMemo.areaPath} fill="url(#asr-fill)" />

          {/* ── Line paths ────────────────────────────────────────── */}
          <path
            d={mosMemo.linePath}
            fill="none"
            stroke="#4ade80"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#mos-glow)"
          />
          <path
            d={asrMemo.linePath}
            fill="none"
            stroke="#60a5fa"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            filter="url(#asr-glow)"
          />

          {/* ── X-axis labels + data dots ─────────────────────────── */}
          {days.map((day, i) => {
            const x = xPos(i);
            const hasData = day.total > 0;
            const isHovered = hoveredIdx === i;

            return (
              <g key={day.date}>
                {/* X-axis day label */}
                <text
                  x={x}
                  y={H - 4}
                  textAnchor="middle"
                  fill={isHovered ? '#94a3b8' : '#334155'}
                  fontSize={8.5}
                  fontFamily="system-ui, sans-serif"
                  style={{ transition: 'fill 0.15s' }}
                >
                  {day.shortLabel}
                </text>

                {/* Invisible wide hit area for hover */}
                <rect
                  x={x - innerW / 14}
                  y={PAD_TOP}
                  width={innerW / 7}
                  height={innerH}
                  fill="transparent"
                  style={{ cursor: hasData ? 'crosshair' : 'default' }}
                  onMouseEnter={() => setHoveredIdx(i)}
                  onMouseLeave={() => setHoveredIdx(null)}
                />

                {hasData ? (
                  <>
                    {/* MOS dot */}
                    {day.avgMos !== null && (
                      <circle
                        cx={x}
                        cy={yMos(day.avgMos)}
                        r={isHovered ? 4.5 : 3}
                        fill={isHovered ? '#4ade80' : '#13151d'}
                        stroke="#4ade80"
                        strokeWidth={isHovered ? 2 : 1.5}
                        style={{ transition: 'r 0.15s, fill 0.15s' }}
                        onMouseEnter={() => setHoveredIdx(i)}
                        onMouseLeave={() => setHoveredIdx(null)}
                      />
                    )}
                    {/* ASR dot */}
                    {day.asr !== null && (
                      <circle
                        cx={x}
                        cy={yAsr(day.asr)}
                        r={isHovered ? 4.5 : 3}
                        fill={isHovered ? '#60a5fa' : '#13151d'}
                        stroke="#60a5fa"
                        strokeWidth={isHovered ? 2 : 1.5}
                        style={{ transition: 'r 0.15s, fill 0.15s' }}
                        onMouseEnter={() => setHoveredIdx(i)}
                        onMouseLeave={() => setHoveredIdx(null)}
                      />
                    )}
                    {/* Vertical hover line */}
                    {isHovered && (
                      <line
                        x1={x} y1={PAD_TOP} x2={x} y2={PAD_TOP + innerH}
                        stroke="rgba(255,255,255,0.06)"
                        strokeWidth={1}
                      />
                    )}
                  </>
                ) : (
                  /* No-data marker: subtle hollow circle at chart midpoint */
                  <circle
                    cx={x}
                    cy={PAD_TOP + innerH / 2}
                    r={2.5}
                    fill="none"
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth={1}
                    strokeDasharray="2 2"
                  />
                )}
              </g>
            );
          })}
        </svg>

        {/* ── Hover tooltip (absolutely positioned over SVG) ─────── */}
        {hoveredDay !== null && hoveredIdx !== null && (
          <div
            style={{
              position: 'absolute',
              // Position tooltip above the hovered column; clamp to stay inside card
              left: `clamp(0px, calc(${((hoveredIdx / 6) * 100).toFixed(1)}% - 90px), calc(100% - 200px))`,
              top: 4,
              pointerEvents: 'none',
              background: 'rgba(15,17,23,0.95)',
              border: '1px solid rgba(96,165,250,0.22)',
              borderRadius: 8,
              padding: '8px 12px',
              minWidth: 190,
              boxShadow: '0 8px 24px -4px rgba(0,0,0,0.6)',
              backdropFilter: 'blur(12px)',
              WebkitBackdropFilter: 'blur(12px)',
              zIndex: 10,
            }}
          >
            <div style={{ fontSize: '0.7rem', fontWeight: 700, color: '#94a3b8', marginBottom: 6 }}>
              {hoveredDay.label}
            </div>
            {hoveredDay.total === 0 ? (
              <div style={{ fontSize: '0.68rem', color: '#475569' }}>No calls recorded</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span style={{ fontSize: '0.68rem', color: '#64748b' }}>Calls</span>
                  <span style={{ fontSize: '0.68rem', fontWeight: 600, color: '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>
                    {hoveredDay.total}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.68rem', color: '#60a5fa' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#60a5fa', display: 'inline-block', flexShrink: 0 }} />
                    ASR
                  </span>
                  <span style={{ fontSize: '0.68rem', fontWeight: 600, color: '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>
                    {hoveredDay.asr !== null ? `${hoveredDay.asr.toFixed(1)}%` : '—'}
                  </span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.68rem', color: '#4ade80' }}>
                    <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#4ade80', display: 'inline-block', flexShrink: 0 }} />
                    MOS
                  </span>
                  <span style={{ fontSize: '0.68rem', fontWeight: 600, color: '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>
                    {hoveredDay.avgMos !== null ? hoveredDay.avgMos.toFixed(2) : '—'}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Legend */}
      <div style={{ display: 'flex', gap: 18, marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="20" height="6" style={{ flexShrink: 0 }}>
            <line x1="0" y1="3" x2="20" y2="3" stroke="#4ade80" strokeWidth="2" strokeLinecap="round" />
            <circle cx="10" cy="3" r="2.5" fill="#13151d" stroke="#4ade80" strokeWidth="1.5" />
          </svg>
          <span style={{ fontSize: '0.66rem', color: '#475569' }}>MOS (left axis, 1–5)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="20" height="6" style={{ flexShrink: 0 }}>
            <line x1="0" y1="3" x2="20" y2="3" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" />
            <circle cx="10" cy="3" r="2.5" fill="#13151d" stroke="#60a5fa" strokeWidth="1.5" />
          </svg>
          <span style={{ fontSize: '0.66rem', color: '#475569' }}>ASR% (right axis, 0–100%)</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <svg width="14" height="14" style={{ flexShrink: 0 }}>
            <circle cx="7" cy="7" r="4" fill="none" stroke="rgba(255,255,255,0.15)" strokeWidth="1" strokeDasharray="2 2" />
          </svg>
          <span style={{ fontSize: '0.66rem', color: '#334155' }}>No data</span>
        </div>
      </div>
    </div>
  );
}

function CallActivityTab({ customerId }: CallActivityTabProps) {
  // ALL hooks unconditionally at top — rules of hooks (#310 prevention)
  const [activitySearch, setActivitySearch] = useState('');
  const [selectedDid, setSelectedDid] = useState<string | null>(null);
  const [didDropdownOpen, setDidDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['rcf-activity', customerId],
    queryFn: () =>
      searchCdrs({
        customer_id: customerId,
        product_type: 'rcf',
        limit: 200,
        sort_by: 'start_time',
        sort_dir: 'desc',
      }),
    enabled: true,
    staleTime: 60_000,
  });

  const { data: rcfData } = useQuery({
    queryKey: ['rcf-dids', customerId],
    queryFn: () => listRcf({ customer_id: customerId, limit: 500 }),
    staleTime: 60_000,
  });
  const rcfEntries: RcfEntry[] = rcfData?.items ?? [];

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!didDropdownOpen) return;
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDidDropdownOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [didDropdownOpen]);

  const allCalls = data?.items ?? [];

  // Client-side DID filter — applies before search and stats
  const filteredCalls = useMemo(() => {
    if (!selectedDid) return allCalls;
    return allCalls.filter((c) => c.destination === selectedDid);
  }, [allCalls, selectedDid]);

  const stats = useMemo(() => computeQualityStats(filteredCalls), [filteredCalls]);
  const dailyDots = useMemo(() => buildDailyDots(filteredCalls), [filteredCalls]);

  // Table rows: DID filter + search filter stacked
  const calls = useMemo(() => {
    if (!activitySearch.trim()) return filteredCalls;
    const q = activitySearch.trim().toLowerCase();
    return filteredCalls.filter((c) => {
      const fields = [
        c.caller_id,
        c.destination,
        c.hangup_cause,
        c.carrier_used,
        c.start_time,
        c.sip_code?.toString(),
        fmt(c.caller_id),
        fmt(c.destination),
      ];
      return fields.some((f) => f && f.toLowerCase().includes(q));
    });
  }, [filteredCalls, activitySearch]);

  // Selected DID label for display
  const selectedEntry = rcfEntries.find((e) => e.did === selectedDid) ?? null;
  const selectedLabel = selectedEntry
    ? `${fmt(selectedEntry.did)}${selectedEntry.name ? ` — ${selectedEntry.name}` : ''}`
    : null;

  // Colour thresholds for stat cards
  // ASR is informational (neutral blue) — we can't control answer rates
  const asrColor = '#60a5fa';

  // MOS is quality we measure — red/amber/green thresholds apply
  const avgMosColor =
    stats.avgMos == null ? '#4a5568'
    : stats.avgMos >= 4.0 ? '#22c55e'
    : stats.avgMos >= 3.0 ? '#f59e0b'
    : '#ef4444';

  // ACD is informational (amber accent)
  const acdColor = '#fbbf24';

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', padding: '64px 0', color: '#64748b' }}>
        <Spinner size="sm" />
        <span style={{ fontSize: '0.875rem' }}>Loading recent calls…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div style={{ padding: '16px 20px', borderRadius: 12, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171', fontSize: '0.875rem' }}>
        Unable to load call activity. Please try refreshing.
      </div>
    );
  }

  if (allCalls.length === 0) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '72px 24px',
          gap: 16,
          textAlign: 'center',
          background: 'rgba(19,21,29,0.65)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
          border: '1px solid rgba(59,130,246,0.10)',
          borderRadius: 16,
        }}
      >
        <div
          style={{
            width: 60,
            height: 60,
            borderRadius: 15,
            background: 'linear-gradient(135deg, rgba(59,130,246,0.14) 0%, rgba(59,130,246,0.06) 100%)',
            border: '1px solid rgba(59,130,246,0.22)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth={1.5} style={{ width: 28, height: 28, opacity: 0.6 }}>
            <path d="M2 12 L5 8 L7 11 L11 5 L13 8 L17 4 L22 9" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div>
          <p style={{ color: '#94a3b8', fontSize: '1rem', fontWeight: 600, margin: '0 0 6px' }}>
            No recent calls
          </p>
          <p style={{ color: '#475569', fontSize: '0.82rem', margin: 0, lineHeight: 1.6, maxWidth: 360 }}>
            Once calls start flowing, your activity log will light up here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingBottom: 60 }}>

      {/* ── DID Selector bar ───────────────────────────────────── */}
      {rcfEntries.length > 0 && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'rgba(19,21,29,0.72)',
            backdropFilter: 'blur(12px)',
            WebkitBackdropFilter: 'blur(12px)',
            border: selectedDid
              ? '1px solid rgba(74,222,128,0.28)'
              : '1px solid rgba(42,47,69,0.6)',
            borderRadius: 14,
            padding: '12px 18px',
            boxShadow: selectedDid
              ? '0 0 0 1px rgba(74,222,128,0.08), 0 6px 24px -6px rgba(0,0,0,0.4)'
              : '0 6px 24px -6px rgba(0,0,0,0.4)',
            transition: 'border-color 0.2s, box-shadow 0.2s',
            position: 'relative',
            zIndex: 50,
          }}
        >
          {/* Left: icon + label */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: 7,
                background: selectedDid ? 'rgba(74,222,128,0.14)' : 'rgba(59,130,246,0.10)',
                border: selectedDid ? '1px solid rgba(74,222,128,0.28)' : '1px solid rgba(59,130,246,0.20)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'background 0.2s, border-color 0.2s',
                flexShrink: 0,
              }}
            >
              <svg viewBox="0 0 16 16" fill="none" stroke={selectedDid ? '#4ade80' : '#60a5fa'} strokeWidth={1.7} style={{ width: 11, height: 11 }}>
                <path d="M3 5a2 2 0 0 1 2-2h1.28a.8.8 0 0 1 .758.547l.6 1.797a.8.8 0 0 1-.401.968l-.903.452a8.833 8.833 0 0 0 4.413 4.413l.452-.903a.8.8 0 0 1 .968-.401l1.797.6A.8.8 0 0 1 14 11.72V13a2 2 0 0 1-2 2h-.4C5.87 15 1 10.13 1 4.4V4a1 1 0 0 1 1-1h1z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span style={{ fontSize: '0.68rem', fontWeight: 600, color: '#94a3b8', letterSpacing: '0.04em', textTransform: 'uppercase' }}>
              Viewing
            </span>
          </div>

          {/* Centre: custom dropdown */}
          <div ref={dropdownRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
            <button
              type="button"
              onClick={() => setDidDropdownOpen((o) => !o)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '7px 12px',
                borderRadius: 10,
                border: didDropdownOpen
                  ? '1px solid rgba(74,222,128,0.55)'
                  : selectedDid
                    ? '1px solid rgba(74,222,128,0.30)'
                    : '1px solid rgba(59,130,246,0.20)',
                background: didDropdownOpen
                  ? 'rgba(74,222,128,0.06)'
                  : selectedDid
                    ? 'rgba(74,222,128,0.05)'
                    : 'rgba(15,17,23,0.5)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                boxShadow: didDropdownOpen ? '0 0 0 3px rgba(74,222,128,0.12)' : 'none',
                transition: 'border-color 0.18s, background 0.18s, box-shadow 0.18s',
                outline: 'none',
                minWidth: 0,
              }}
            >
              {/* Selected value */}
              <span style={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {selectedDid ? (
                  <span style={{ fontSize: '0.84rem', fontWeight: 700, color: '#4ade80', fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', letterSpacing: '0.01em' }}>
                    {selectedLabel}
                  </span>
                ) : (
                  <span style={{ fontSize: '0.84rem', fontWeight: 700, color: '#e2e8f0' }}>
                    All Numbers
                  </span>
                )}
              </span>
              {/* Chevron */}
              <svg
                viewBox="0 0 16 16"
                fill="none"
                stroke={selectedDid ? '#4ade80' : '#64748b'}
                strokeWidth={2}
                style={{
                  width: 12,
                  height: 12,
                  flexShrink: 0,
                  transform: didDropdownOpen ? 'rotate(180deg)' : 'none',
                  transition: 'transform 0.18s',
                }}
              >
                <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>

            {/* Dropdown panel */}
            {didDropdownOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 6px)',
                  left: 0,
                  right: 0,
                  zIndex: 999,
                  background: 'rgba(15,17,23,0.97)',
                  backdropFilter: 'blur(16px)',
                  WebkitBackdropFilter: 'blur(16px)',
                  border: '1px solid rgba(74,222,128,0.22)',
                  borderRadius: 12,
                  overflow: 'hidden',
                  boxShadow: '0 16px 40px -8px rgba(0,0,0,0.7), 0 0 0 1px rgba(74,222,128,0.06)',
                  animation: 'fadeInUp 0.12s ease',
                }}
              >
                {/* All Numbers option */}
                <button
                  type="button"
                  onClick={() => { setSelectedDid(null); setDidDropdownOpen(false); }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '11px 14px',
                    border: 'none',
                    borderBottom: '1px solid rgba(42,47,69,0.6)',
                    background: !selectedDid ? 'rgba(74,222,128,0.08)' : 'transparent',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    textAlign: 'left',
                    transition: 'background 0.14s',
                  }}
                  onMouseEnter={(e) => { if (selectedDid) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                  onMouseLeave={(e) => { if (selectedDid) e.currentTarget.style.background = 'transparent'; }}
                >
                  <div
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 7,
                      background: !selectedDid ? 'rgba(74,222,128,0.18)' : 'rgba(255,255,255,0.05)',
                      border: !selectedDid ? '1px solid rgba(74,222,128,0.35)' : '1px solid rgba(255,255,255,0.08)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      transition: 'background 0.14s, border-color 0.14s',
                    }}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke={!selectedDid ? '#4ade80' : '#64748b'} strokeWidth={1.7} style={{ width: 11, height: 11 }}>
                      <rect x="2" y="2" width="5" height="5" rx="1.2" />
                      <rect x="9" y="2" width="5" height="5" rx="1.2" />
                      <rect x="2" y="9" width="5" height="5" rx="1.2" />
                      <rect x="9" y="9" width="5" height="5" rx="1.2" />
                    </svg>
                  </div>
                  <div>
                    <div style={{ fontSize: '0.84rem', fontWeight: 800, color: !selectedDid ? '#4ade80' : '#e2e8f0', letterSpacing: '-0.01em' }}>
                      All Numbers
                    </div>
                    <div style={{ fontSize: '0.65rem', color: '#475569', marginTop: 1 }}>
                      Aggregate data for all {rcfEntries.length} number{rcfEntries.length !== 1 ? 's' : ''}
                    </div>
                  </div>
                  {!selectedDid && (
                    <span style={{ marginLeft: 'auto', fontSize: '0.6rem', fontWeight: 700, color: '#4ade80', background: 'rgba(74,222,128,0.15)', border: '1px solid rgba(74,222,128,0.30)', borderRadius: 20, padding: '2px 8px', letterSpacing: '0.06em', textTransform: 'uppercase', flexShrink: 0 }}>
                      Active
                    </span>
                  )}
                </button>

                {/* Individual DID options */}
                <div style={{ maxHeight: 280, overflowY: 'auto' }}>
                  {rcfEntries.map((entry) => {
                    const isSelected = selectedDid === entry.did;
                    return (
                      <button
                        key={entry.did}
                        type="button"
                        onClick={() => { setSelectedDid(entry.did); setDidDropdownOpen(false); }}
                        style={{
                          width: '100%',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          padding: '10px 14px',
                          border: 'none',
                          borderBottom: '1px solid rgba(42,47,69,0.35)',
                          background: isSelected ? 'rgba(74,222,128,0.07)' : 'transparent',
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          textAlign: 'left',
                          transition: 'background 0.14s',
                        }}
                        onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                        onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                      >
                        {/* Status dot */}
                        <span
                          style={{
                            width: 7,
                            height: 7,
                            borderRadius: '50%',
                            background: entry.enabled ? '#4ade80' : '#ef4444',
                            flexShrink: 0,
                            boxShadow: entry.enabled ? '0 0 6px rgba(74,222,128,0.6)' : 'none',
                            display: 'inline-block',
                          }}
                        />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: '0.84rem', fontWeight: 700, color: isSelected ? '#4ade80' : '#e2e8f0', fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', letterSpacing: '0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {fmt(entry.did)}
                          </div>
                          {entry.name && (
                            <div style={{ fontSize: '0.65rem', color: isSelected ? 'rgba(74,222,128,0.7)' : '#64748b', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {entry.name}
                            </div>
                          )}
                        </div>
                        {isSelected && (
                          <svg viewBox="0 0 16 16" fill="none" stroke="#4ade80" strokeWidth={2.2} style={{ width: 13, height: 13, flexShrink: 0 }}>
                            <path d="M2 8l4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          {/* Right: count badge + clear button */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
            <span
              style={{
                fontSize: '0.65rem',
                fontWeight: 700,
                color: '#64748b',
                background: 'rgba(255,255,255,0.04)',
                border: '1px solid rgba(255,255,255,0.08)',
                borderRadius: 20,
                padding: '3px 9px',
                whiteSpace: 'nowrap',
                letterSpacing: '0.04em',
              }}
            >
              {rcfEntries.length} number{rcfEntries.length !== 1 ? 's' : ''}
            </span>
            {selectedDid && (
              <button
                type="button"
                onClick={() => setSelectedDid(null)}
                title="Back to All Numbers"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 26,
                  height: 26,
                  borderRadius: 7,
                  border: '1px solid rgba(74,222,128,0.30)',
                  background: 'rgba(74,222,128,0.08)',
                  color: '#4ade80',
                  cursor: 'pointer',
                  padding: 0,
                  transition: 'background 0.15s, border-color 0.15s',
                  flexShrink: 0,
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(74,222,128,0.16)';
                  e.currentTarget.style.borderColor = 'rgba(74,222,128,0.5)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'rgba(74,222,128,0.08)';
                  e.currentTarget.style.borderColor = 'rgba(74,222,128,0.30)';
                }}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 10, height: 10 }}>
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}

      {/* ── Quality stat cards ─────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>

        {/* Card 1: ASR (Answer Seizure Ratio) — informational, neutral blue */}
        <div style={{ background: 'rgba(19,21,29,0.72)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: `1px solid ${asrColor}22`, borderRadius: 16, padding: '18px 18px', position: 'relative', overflow: 'hidden', boxShadow: `0 8px 32px -8px rgba(0,0,0,0.5), 0 0 0 1px ${asrColor}0a` }}>
          <div style={{ position: 'absolute', top: -36, right: -36, width: 100, height: 100, borderRadius: '50%', background: `radial-gradient(circle, ${asrColor}18 0%, transparent 70%)`, pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', top: 0, left: 24, right: 24, height: 2, background: `linear-gradient(90deg, transparent, ${asrColor}55, transparent)` }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: 7, background: `${asrColor}18`, border: `1px solid ${asrColor}33`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg viewBox="0 0 16 16" fill="none" stroke={asrColor} strokeWidth={2} style={{ width: 13, height: 13 }}>
                <path d="M2 8l4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span style={{ fontSize: '0.55rem', fontWeight: 600, color: asrColor, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.85 }}>ASR</span>
          </div>
          <div style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', fontWeight: 900, color: asrColor, letterSpacing: '-0.04em', lineHeight: 1, marginBottom: 3, fontVariantNumeric: 'tabular-nums', textShadow: `0 0 28px ${asrColor}44` }}>
            {stats.asr != null ? `${stats.asr.toFixed(1)}%` : '—'}
          </div>
          <div style={{ fontSize: '0.68rem', color: '#64748b', lineHeight: 1.4 }}>answer seizure ratio</div>
        </div>

        {/* Card 2: Voice Clarity (MOS) — quality we measure, color-coded */}
        <div style={{ background: 'rgba(19,21,29,0.72)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: `1px solid ${avgMosColor}22`, borderRadius: 16, padding: '18px 18px', position: 'relative', overflow: 'hidden', boxShadow: `0 8px 32px -8px rgba(0,0,0,0.5), 0 0 0 1px ${avgMosColor}0a` }}>
          <div style={{ position: 'absolute', top: -36, right: -36, width: 100, height: 100, borderRadius: '50%', background: `radial-gradient(circle, ${avgMosColor}18 0%, transparent 70%)`, pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', top: 0, left: 24, right: 24, height: 2, background: `linear-gradient(90deg, transparent, ${avgMosColor}55, transparent)` }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: 7, background: `${avgMosColor}18`, border: `1px solid ${avgMosColor}33`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg viewBox="0 0 16 16" fill="none" stroke={avgMosColor} strokeWidth={1.8} style={{ width: 13, height: 13 }}>
                <path d="M2 10c0-3.3 2.7-6 6-6s6 2.7 6 6" strokeLinecap="round" />
                <circle cx="8" cy="10" r="1.5" fill={avgMosColor} stroke="none" />
              </svg>
            </div>
            <span style={{ fontSize: '0.55rem', fontWeight: 600, color: avgMosColor, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.85 }}>MOS</span>
          </div>
          <div style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', fontWeight: 900, color: avgMosColor, letterSpacing: '-0.04em', lineHeight: 1, marginBottom: 3, fontVariantNumeric: 'tabular-nums', textShadow: `0 0 28px ${avgMosColor}44` }}>
            {stats.avgMos != null ? stats.avgMos.toFixed(1) : '—'}
          </div>
          <div style={{ fontSize: '0.68rem', color: '#64748b', lineHeight: 1.4 }}>voice quality (1–5)</div>
        </div>

        {/* Card 3: Total Calls — informational blue */}
        <div style={{ background: 'rgba(19,21,29,0.72)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: '1px solid rgba(59,130,246,0.18)', borderRadius: 16, padding: '18px 18px', position: 'relative', overflow: 'hidden', boxShadow: '0 8px 32px -8px rgba(0,0,0,0.5), 0 0 0 1px rgba(59,130,246,0.05)' }}>
          <div style={{ position: 'absolute', top: -36, right: -36, width: 100, height: 100, borderRadius: '50%', background: 'radial-gradient(circle, rgba(59,130,246,0.14) 0%, transparent 70%)', pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', top: 0, left: 24, right: 24, height: 2, background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.5), transparent)' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: 7, background: 'rgba(59,130,246,0.14)', border: '1px solid rgba(59,130,246,0.28)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg viewBox="0 0 16 16" fill="none" stroke="#60a5fa" strokeWidth={1.8} style={{ width: 13, height: 13 }}>
                <path d="M3 5a2 2 0 0 1 2-2h1.28a.8.8 0 0 1 .758.547l.6 1.797a.8.8 0 0 1-.401.968l-.903.452a8.833 8.833 0 0 0 4.413 4.413l.452-.903a.8.8 0 0 1 .968-.401l1.797.6A.8.8 0 0 1 14 11.72V13a2 2 0 0 1-2 2h-.4C5.87 15 1 10.13 1 4.4V4a1 1 0 0 1 1-1h1z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span style={{ fontSize: '0.55rem', fontWeight: 600, color: '#60a5fa', textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.85 }}>Total Calls</span>
          </div>
          <div style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', fontWeight: 900, color: '#60a5fa', letterSpacing: '-0.04em', lineHeight: 1, marginBottom: 3, fontVariantNumeric: 'tabular-nums', textShadow: '0 0 28px rgba(96,165,250,0.4)' }}>
            {stats.total.toLocaleString()}
          </div>
          <div style={{ fontSize: '0.68rem', color: '#64748b', lineHeight: 1.4 }}>calls this period</div>
        </div>

        {/* Card 4: ACD (Average Call Duration) — informational amber */}
        <div style={{ background: 'rgba(19,21,29,0.72)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', border: `1px solid ${acdColor}22`, borderRadius: 16, padding: '18px 18px', position: 'relative', overflow: 'hidden', boxShadow: `0 8px 32px -8px rgba(0,0,0,0.5), 0 0 0 1px ${acdColor}0a` }}>
          <div style={{ position: 'absolute', top: -36, right: -36, width: 100, height: 100, borderRadius: '50%', background: `radial-gradient(circle, ${acdColor}18 0%, transparent 70%)`, pointerEvents: 'none' }} />
          <div style={{ position: 'absolute', top: 0, left: 24, right: 24, height: 2, background: `linear-gradient(90deg, transparent, ${acdColor}55, transparent)` }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: 7, background: `${acdColor}18`, border: `1px solid ${acdColor}33`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg viewBox="0 0 16 16" fill="none" stroke={acdColor} strokeWidth={1.8} style={{ width: 13, height: 13 }}>
                <circle cx="8" cy="8" r="6" />
                <path d="M8 5v3l2 2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <span style={{ fontSize: '0.55rem', fontWeight: 600, color: acdColor, textTransform: 'uppercase', letterSpacing: '0.05em', opacity: 0.85 }}>ACD</span>
          </div>
          <div style={{ fontSize: 'clamp(1.5rem, 3vw, 2rem)', fontWeight: 900, color: acdColor, letterSpacing: '-0.04em', lineHeight: 1, marginBottom: 3, fontVariantNumeric: 'tabular-nums', textShadow: `0 0 28px ${acdColor}44` }}>
            {stats.acd != null ? (stats.acd >= 60 ? `${Math.floor(stats.acd / 60)}m ${Math.round(stats.acd % 60)}s` : `${Math.round(stats.acd)}s`) : '—'}
          </div>
          <div style={{ fontSize: '0.68rem', color: '#64748b', lineHeight: 1.4 }}>avg call duration</div>
        </div>
      </div>

      {/* ── 7-day performance chart ────────────────────────────── */}
      <WeeklyChart days={dailyDots} />

      {/* ── Recent calls table ─────────────────────────────────── */}
      <div
        style={{
          background: 'rgba(19,21,29,0.68)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          border: '1px solid rgba(59,130,246,0.12)',
          borderRadius: 16,
          overflow: 'hidden',
          boxShadow: '0 8px 32px -8px rgba(0,0,0,0.45)',
        }}
      >
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid rgba(59,130,246,0.08)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Recent Calls
          </span>
          {selectedDid && selectedLabel && (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                fontSize: '0.65rem',
                fontWeight: 700,
                color: '#4ade80',
                background: 'rgba(74,222,128,0.10)',
                border: '1px solid rgba(74,222,128,0.25)',
                borderRadius: 20,
                padding: '2px 8px 2px 6px',
                whiteSpace: 'nowrap',
                letterSpacing: '0.02em',
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  width: 5,
                  height: 5,
                  borderRadius: '50%',
                  background: '#4ade80',
                  display: 'inline-block',
                  flexShrink: 0,
                  boxShadow: '0 0 5px rgba(74,222,128,0.7)',
                }}
              />
              {selectedLabel}
            </span>
          )}
          <div style={{ flex: 1, minWidth: 200, position: 'relative' }}>
            <svg viewBox="0 0 20 20" fill="currentColor" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', width: 14, height: 14, color: '#334155' }}>
              <path fillRule="evenodd" d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z" clipRule="evenodd" />
            </svg>
            <input
              type="text"
              value={activitySearch}
              onChange={(e) => setActivitySearch(e.target.value)}
              placeholder="Filter by number, date, cause..."
              style={{
                width: '100%',
                padding: '7px 12px 7px 30px',
                fontSize: '0.8rem',
                color: '#e2e8f0',
                background: 'rgba(15,17,23,0.5)',
                border: '1px solid rgba(59,130,246,0.12)',
                borderRadius: 10,
                outline: 'none',
                transition: 'border-color 0.2s, box-shadow 0.2s',
              }}
              onFocus={(e) => {
                e.currentTarget.style.borderColor = 'rgba(59,130,246,0.4)';
                e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.10)';
              }}
              onBlur={(e) => {
                e.currentTarget.style.borderColor = 'rgba(59,130,246,0.12)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            />
          </div>
          <span
            style={{
              fontSize: '0.68rem',
              fontWeight: 600,
              color: '#3b82f6',
              background: 'rgba(59,130,246,0.10)',
              border: '1px solid rgba(59,130,246,0.20)',
              borderRadius: 20,
              padding: '2px 9px',
              flexShrink: 0,
            }}
          >
            {calls.length}{(activitySearch.trim() || selectedDid) ? ` of ${allCalls.length}` : ''} shown
          </span>
        </div>

        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 580 }}>
            <thead>
              <tr style={{ background: 'rgba(59,130,246,0.04)', borderBottom: '1px solid rgba(59,130,246,0.10)' }}>
                {['Time', 'From', 'To (DID)', 'Carrier Trunk', 'Status', 'Quality'].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: '11px 14px',
                      textAlign: 'left',
                      fontSize: '0.6rem',
                      fontWeight: 600,
                      color: '#475569',
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {calls.map((cdr, idx) => {
                const status = callStatusInfo(cdr);
                const quality = mosLabel(cdr.mos);
                return (
                  <tr
                    key={cdr.uuid}
                    style={{
                      borderBottom: idx < calls.length - 1 ? '1px solid rgba(59,130,246,0.05)' : 'none',
                      animation: 'fadeInUp 0.3s ease both',
                      animationDelay: `${Math.min(idx * 30, 300)}ms`,
                    }}
                  >
                    {/* Time */}
                    <td style={{ padding: '12px 14px', whiteSpace: 'nowrap' }}>
                      <span style={{ fontSize: '0.78rem', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
                        {timeAgo(cdr.start_time)}
                      </span>
                    </td>

                    {/* From */}
                    <td style={{ padding: '12px 14px' }}>
                      <span style={{ fontSize: '0.82rem', color: '#94a3b8', fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', fontWeight: 500 }}>
                        {fmt(cdr.caller_id)}
                      </span>
                    </td>

                    {/* To (DID) */}
                    <td style={{ padding: '12px 14px' }}>
                      <span style={{ fontSize: '0.82rem', color: '#60a5fa', fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', fontWeight: 600 }}>
                        {fmt(cdr.destination)}
                      </span>
                    </td>

                    {/* Carrier Trunk */}
                    <td style={{ padding: '12px 14px' }}>
                      <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
                        {carrierDisplayName(cdr.carrier_used)}
                      </span>
                    </td>

                    {/* Status badge */}
                    <td style={{ padding: '12px 14px' }}>
                      <span
                        style={{
                          fontSize: '0.68rem',
                          fontWeight: 700,
                          color: status.color,
                          background: status.bg,
                          border: status.border,
                          borderRadius: 20,
                          padding: '3px 9px',
                          whiteSpace: 'nowrap',
                          letterSpacing: '0.02em',
                        }}
                      >
                        {status.label}
                      </span>
                    </td>

                    {/* Quality dot */}
                    <td style={{ padding: '12px 14px' }}>
                      {cdr.mos != null ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span
                            style={{
                              width: 8,
                              height: 8,
                              borderRadius: '50%',
                              background: quality.dot,
                              flexShrink: 0,
                              boxShadow: `0 0 6px ${quality.dot}`,
                              display: 'inline-block',
                            }}
                          />
                          <span style={{ fontSize: '0.72rem', color: quality.color, fontWeight: 600 }}>
                            {quality.text}
                          </span>
                        </div>
                      ) : (
                        <span style={{ fontSize: '0.72rem', color: '#334155' }}>—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── DIDManagementTab ─────────────────────────────────────────────────────────

// ── E.164 helpers ─────────────────────────────────────────────────────────────

/** Extract NPA (area code) from E.164 +1NPANXXXXXX */
function extractNpa(did: string): string {
  return did.replace(/^\+1/, '').substring(0, 3);
}

/** Extract NXX (exchange) from E.164 +1NPANXXXXXX */
function extractNxx(did: string): string {
  return did.replace(/^\+1/, '').substring(3, 6);
}

// ── Filter bar ────────────────────────────────────────────────────────────────

interface DidFilterState {
  npa: string;
  nxx: string;
  state: string;
  search: string;
}

interface DidFilterBarProps {
  filters: DidFilterState;
  onFiltersChange: (filters: DidFilterState) => void;
  availableStates: string[];
  resultCount: number;
  totalCount: number;
  compact?: boolean;
}

function DidFilterBar({
  filters,
  onFiltersChange,
  availableStates,
  resultCount,
  totalCount,
  compact = false,
}: DidFilterBarProps) {
  const hasActive = filters.npa || filters.nxx || filters.state || filters.search;

  const inputBase: React.CSSProperties = {
    fontSize: '0.78rem',
    background: 'rgba(15,17,23,0.65)',
    border: '1px solid rgba(59,130,246,0.16)',
    borderRadius: 8,
    color: '#e2e8f0',
    outline: 'none',
    fontFamily: 'inherit',
    transition: 'border-color 0.18s, box-shadow 0.18s',
  };

  return (
    <div
      style={{
        padding: compact ? '10px 16px' : '12px 20px',
        borderBottom: '1px solid rgba(59,130,246,0.08)',
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        background: 'rgba(59,130,246,0.018)',
      }}
    >
      {/* NPA input */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
        <label style={{ fontSize: '0.56rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Area Code (NPA)
        </label>
        <input
          type="text"
          value={filters.npa}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 3);
            onFiltersChange({ ...filters, npa: v });
          }}
          placeholder="617"
          maxLength={3}
          inputMode="numeric"
          onFocus={(e) => {
            e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)';
            e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.12)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'rgba(59,130,246,0.16)';
            e.currentTarget.style.boxShadow = 'none';
          }}
          style={{
            ...inputBase,
            width: 56,
            padding: '6px 8px',
            fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
            textAlign: 'center',
            letterSpacing: '0.08em',
          }}
        />
      </div>

      {/* NXX input */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
        <label style={{ fontSize: '0.56rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Exchange (NXX)
        </label>
        <input
          type="text"
          value={filters.nxx}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, '').slice(0, 3);
            onFiltersChange({ ...filters, nxx: v });
          }}
          placeholder="454"
          maxLength={3}
          inputMode="numeric"
          onFocus={(e) => {
            e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)';
            e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.12)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'rgba(59,130,246,0.16)';
            e.currentTarget.style.boxShadow = 'none';
          }}
          style={{
            ...inputBase,
            width: 56,
            padding: '6px 8px',
            fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
            textAlign: 'center',
            letterSpacing: '0.08em',
          }}
        />
      </div>

      {/* State dropdown */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
        <label style={{ fontSize: '0.56rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          State
        </label>
        <select
          value={filters.state}
          onChange={(e) => onFiltersChange({ ...filters, state: e.target.value })}
          onFocus={(e) => {
            e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)';
            e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.12)';
          }}
          onBlur={(e) => {
            e.currentTarget.style.borderColor = 'rgba(59,130,246,0.16)';
            e.currentTarget.style.boxShadow = 'none';
          }}
          style={{
            ...inputBase,
            padding: '6px 8px',
            cursor: 'pointer',
            minWidth: 88,
          }}
        >
          <option value="">All States</option>
          {availableStates.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>

      {/* Free text search */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 160px', minWidth: 140 }}>
        <label style={{ fontSize: '0.56rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Search
        </label>
        <div style={{ position: 'relative' }}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', width: 12, height: 12, color: '#475569', pointerEvents: 'none' }}>
            <path d="m19 19-4.35-4.35M15 9A6 6 0 1 1 3 9a6 6 0 0 1 12 0Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <input
            type="text"
            value={filters.search}
            onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })}
            placeholder="City, rate center, DID…"
            onFocus={(e) => {
              e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)';
              e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.12)';
            }}
            onBlur={(e) => {
              e.currentTarget.style.borderColor = 'rgba(59,130,246,0.16)';
              e.currentTarget.style.boxShadow = 'none';
            }}
            style={{
              ...inputBase,
              width: '100%',
              boxSizing: 'border-box',
              padding: '6px 8px 6px 26px',
            }}
          />
        </div>
      </div>

      {/* Result count pill */}
      <div style={{ marginLeft: 'auto', flexShrink: 0, alignSelf: 'flex-end', paddingBottom: 1 }}>
        <span
          style={{
            fontSize: '0.67rem',
            fontWeight: 600,
            color: hasActive ? '#60a5fa' : '#475569',
            background: hasActive ? 'rgba(59,130,246,0.12)' : 'rgba(59,130,246,0.05)',
            border: `1px solid ${hasActive ? 'rgba(59,130,246,0.28)' : 'rgba(59,130,246,0.10)'}`,
            borderRadius: 20,
            padding: '3px 10px',
            transition: 'all 0.2s',
          }}
        >
          {hasActive ? `${resultCount} of ${totalCount}` : `${totalCount} total`}
        </span>
      </div>

      {/* Clear all button */}
      {hasActive && (
        <button
          type="button"
          onClick={() => onFiltersChange({ npa: '', nxx: '', state: '', search: '' })}
          style={{
            alignSelf: 'flex-end',
            padding: '4px 10px',
            borderRadius: 6,
            border: 'none',
            background: 'transparent',
            color: '#475569',
            fontSize: '0.68rem',
            cursor: 'pointer',
            fontFamily: 'inherit',
            textDecoration: 'underline',
            marginBottom: 1,
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}

/** Apply DID filters (AND logic) to an array of inventory items */
function applyDidFilters(items: DidInventoryItem[], filters: DidFilterState): DidInventoryItem[] {
  return items.filter((item) => {
    if (filters.npa && extractNpa(item.did) !== filters.npa) return false;
    if (filters.nxx && extractNxx(item.did) !== filters.nxx) return false;
    if (filters.state && item.state !== filters.state) return false;
    if (filters.search) {
      const q = filters.search.toLowerCase();
      const matches =
        item.did.includes(q) ||
        (item.city ?? '').toLowerCase().includes(q) ||
        (item.rate_center ?? '').toLowerCase().includes(q) ||
        fmt(item.did).toLowerCase().includes(q);
      if (!matches) return false;
    }
    return true;
  });
}

/** Extract unique sorted states from an array of inventory items */
function extractStates(items: DidInventoryItem[]): string[] {
  const set = new Set<string>();
  for (const item of items) {
    if (item.state) set.add(item.state);
  }
  return [...set].sort();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function didStatusBadge(status: DidInventoryItem['status']): React.ReactNode {
  const styles: Record<
    DidInventoryItem['status'],
    { bg: string; color: string; border: string; label: string }
  > = {
    available:   { bg: 'rgba(59,130,246,0.12)',  color: '#60a5fa', border: 'rgba(59,130,246,0.30)',  label: 'Available' },
    assigned:    { bg: 'rgba(34,197,94,0.12)',   color: '#4ade80', border: 'rgba(34,197,94,0.30)',   label: 'Assigned' },
    reserved:    { bg: 'rgba(245,158,11,0.12)',  color: '#fbbf24', border: 'rgba(245,158,11,0.30)',  label: 'Pending Approval' },
    porting_in:  { bg: 'rgba(168,85,247,0.12)', color: '#c084fc', border: 'rgba(168,85,247,0.30)', label: 'Porting In' },
    porting_out: { bg: 'rgba(168,85,247,0.12)', color: '#c084fc', border: 'rgba(168,85,247,0.30)', label: 'Porting Out' },
    suspended:   { bg: 'rgba(239,68,68,0.12)',  color: '#f87171', border: 'rgba(239,68,68,0.30)',  label: 'Suspended' },
  };
  const s = styles[status] ?? styles.available;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: '0.67rem',
        fontWeight: 700,
        color: s.color,
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 20,
        padding: '3px 9px',
        whiteSpace: 'nowrap',
        letterSpacing: '0.03em',
      }}
    >
      <span
        style={{
          width: 5,
          height: 5,
          borderRadius: '50%',
          background: s.color,
          flexShrink: 0,
          boxShadow: `0 0 5px ${s.color}`,
          display: 'inline-block',
        }}
      />
      {s.label}
    </span>
  );
}

function fmtAssignedDate(iso: string | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// ── Glass card wrapper shared across sections ─────────────────────────────────

function DidCard({
  children,
  delay = 0,
}: {
  children: React.ReactNode;
  delay?: number;
}) {
  return (
    <div
      style={{
        background: 'rgba(19,21,29,0.70)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        border: '1px solid rgba(59,130,246,0.12)',
        borderRadius: 16,
        overflow: 'hidden',
        boxShadow: '0 8px 32px -8px rgba(0,0,0,0.45)',
        animation: 'fadeInUp 0.35s ease both',
        animationDelay: `${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

// ── Section header bar ────────────────────────────────────────────────────────

function DidSectionHeader({
  title,
  count,
  countLabel,
  right,
}: {
  title: string;
  count?: number;
  countLabel?: string;
  right?: React.ReactNode;
}) {
  return (
    <div
      style={{
        padding: '14px 20px',
        borderBottom: '1px solid rgba(59,130,246,0.08)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        background: 'rgba(59,130,246,0.025)',
      }}
    >
      <span
        style={{
          fontSize: '0.72rem',
          fontWeight: 600,
          color: '#475569',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          flexShrink: 0,
        }}
      >
        {title}
      </span>
      {count !== undefined && (
        <span
          style={{
            fontSize: '0.68rem',
            fontWeight: 600,
            color: '#3b82f6',
            background: 'rgba(59,130,246,0.10)',
            border: '1px solid rgba(59,130,246,0.20)',
            borderRadius: 20,
            padding: '2px 9px',
            flexShrink: 0,
          }}
        >
          {count} {countLabel ?? ''}
        </span>
      )}
      {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
    </div>
  );
}

// ── Th helper for DID tables ──────────────────────────────────────────────────

function DidTh({ children }: { children?: React.ReactNode }) {
  return (
    <th
      style={{
        padding: '11px 16px',
        textAlign: 'left',
        fontSize: '0.6rem',
        fontWeight: 600,
        color: '#475569',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        whiteSpace: 'nowrap',
        background: 'rgba(59,130,246,0.04)',
        borderBottom: '1px solid rgba(59,130,246,0.10)',
      }}
    >
      {children}
    </th>
  );
}

// ── Request confirmation modal ────────────────────────────────────────────────

interface RequestModalProps {
  did: DidInventoryItem | null;
  onConfirm: (did: DidInventoryItem) => void;
  onCancel: () => void;
  isPending: boolean;
}

function RequestModal({ did, onConfirm, onCancel, isPending }: RequestModalProps) {
  if (!did) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(0,0,0,0.65)',
        backdropFilter: 'blur(4px)',
        WebkitBackdropFilter: 'blur(4px)',
        animation: 'fadeIn 0.15s ease',
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !isPending) onCancel(); }}
    >
      <div
        style={{
          background: 'linear-gradient(145deg, rgba(26,29,39,0.98) 0%, rgba(19,21,29,0.99) 100%)',
          border: '1px solid rgba(59,130,246,0.22)',
          borderRadius: 18,
          padding: '32px 32px 28px',
          maxWidth: 420,
          width: '100%',
          position: 'relative',
          boxShadow: '0 24px 64px -8px rgba(0,0,0,0.75), 0 0 0 1px rgba(59,130,246,0.08)',
          animation: 'fadeInUp 0.2s ease',
        }}
      >
        {/* Top accent line */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 48,
            right: 48,
            height: 2,
            background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.65), transparent)',
            borderRadius: '0 0 2px 2px',
          }}
        />

        {/* Icon */}
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 13,
            background: 'linear-gradient(135deg, rgba(59,130,246,0.18) 0%, rgba(59,130,246,0.08) 100%)',
            border: '1px solid rgba(59,130,246,0.28)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 20,
            boxShadow: '0 0 20px rgba(59,130,246,0.18)',
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth={1.6} style={{ width: 26, height: 26 }}>
            <path d="M3 5a2 2 0 0 1 2-2h3.28a1 1 0 0 1 .948.684l1.498 4.493a1 1 0 0 1-.502 1.21l-2.257 1.13a11.042 11.042 0 0 0 5.516 5.516l1.13-2.257a1 1 0 0 1 1.21-.502l4.493 1.498a1 1 0 0 1 .684.949V19a2 2 0 0 1-2 2h-1C9.716 21 3 14.284 3 6V5z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <div style={{ fontSize: '1.05rem', fontWeight: 700, color: '#e2e8f0', marginBottom: 8, letterSpacing: '-0.02em' }}>
          Request this number?
        </div>
        <div style={{ fontSize: '0.84rem', color: '#64748b', marginBottom: 20, lineHeight: 1.6 }}>
          You are requesting{' '}
          <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', color: '#60a5fa', fontWeight: 600 }}>
            {fmt(did.did)}
          </span>
          {did.city || did.state ? (
            <>
              {' '}({[did.city, did.state].filter(Boolean).join(', ')})
            </>
          ) : null}
          {' '}for your account. An admin will review and approve the assignment.
        </div>

        <div
          style={{
            padding: '12px 16px',
            borderRadius: 10,
            background: 'rgba(245,158,11,0.07)',
            border: '1px solid rgba(245,158,11,0.18)',
            marginBottom: 24,
            fontSize: '0.78rem',
            color: '#92400e',
            lineHeight: 1.5,
          }}
        >
          <span style={{ color: '#fbbf24', fontWeight: 600 }}>Note: </span>
          <span style={{ color: '#78716c' }}>
            This number will be marked as pending until an administrator approves the request. You will be notified once it is assigned.
          </span>
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending}
            style={{
              padding: '9px 20px',
              borderRadius: 9,
              border: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.04)',
              color: '#64748b',
              fontSize: '0.83rem',
              fontWeight: 500,
              cursor: isPending ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              transition: 'background 0.15s, color 0.15s',
              opacity: isPending ? 0.5 : 1,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(did)}
            disabled={isPending}
            style={{
              padding: '9px 22px',
              borderRadius: 9,
              border: 'none',
              background: isPending
                ? 'rgba(59,130,246,0.35)'
                : 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
              color: '#fff',
              fontSize: '0.83rem',
              fontWeight: 700,
              cursor: isPending ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 7,
              boxShadow: isPending ? 'none' : '0 4px 16px rgba(59,130,246,0.35)',
              transition: 'background 0.15s, box-shadow 0.15s',
              letterSpacing: '-0.01em',
            }}
          >
            {isPending && (
              <svg viewBox="0 0 16 16" style={{ width: 13, height: 13, animation: 'spin 0.7s linear infinite' }}>
                <circle cx="8" cy="8" r="6" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={2} />
                <path d="M8 2a6 6 0 0 1 6 6" stroke="#fff" strokeWidth={2} fill="none" strokeLinecap="round" />
              </svg>
            )}
            {isPending ? 'Requesting…' : 'Confirm Request'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Release confirmation modal ────────────────────────────────────────────────

interface ReleaseModalProps {
  did: DidInventoryItem | null;
  onConfirm: (did: DidInventoryItem) => void;
  onCancel: () => void;
  isPending: boolean;
}

function ReleaseModal({ did, onConfirm, onCancel, isPending }: ReleaseModalProps) {
  // ALL hooks unconditionally at top — early return is below (rules-of-hooks)
  const [holdProgress, setHoldProgress] = useState(0); // 0–100
  const [holdPhase, setHoldPhase] = useState<'idle' | 'holding' | 'done'>('idle');
  const rafRef = useRef<number | null>(null);
  const holdStartRef = useRef<number>(0);
  const didFireRef = useRef(false);

  // Cancel any in-flight animation and smoothly reset
  const cancelHold = useCallback(() => {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    setHoldPhase('idle');
    setHoldProgress(0);
    didFireRef.current = false;
  }, []);

  // Clean up on unmount
  useEffect(() => () => {
    if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
  }, []);

  const startHold = useCallback(() => {
    if (isPending || didFireRef.current) return;
    holdStartRef.current = performance.now();
    setHoldPhase('holding');

    const HOLD_MS = 5000;

    const tick = (now: number) => {
      const elapsed = now - holdStartRef.current;
      const pct = Math.min((elapsed / HOLD_MS) * 100, 100);
      setHoldProgress(pct);

      if (pct >= 100 && !didFireRef.current) {
        didFireRef.current = true;
        setHoldPhase('done');
        rafRef.current = null;
        // Small delay so "Releasing!" text is visible before action fires
        setTimeout(() => {
          if (did) onConfirm(did);
        }, 120);
        return;
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [isPending, did, onConfirm]);

  // Derive label from progress
  const holdLabel = (() => {
    if (holdPhase === 'done' || isPending) return 'Releasing…';
    if (holdPhase === 'idle') return 'Hold to Release';
    if (holdProgress < 20) return 'Hold to Release…';
    if (holdProgress < 60) return 'Read the warning above…';
    return 'Releasing…';
  })();

  if (!did) return null;
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(0,0,0,0.70)',
        backdropFilter: 'blur(5px)',
        WebkitBackdropFilter: 'blur(5px)',
        animation: 'fadeIn 0.15s ease',
      }}
      onClick={(e) => { if (e.target === e.currentTarget && !isPending) onCancel(); }}
    >
      <div
        style={{
          background: 'linear-gradient(145deg, rgba(26,29,39,0.99) 0%, rgba(19,21,29,1) 100%)',
          border: '1px solid rgba(239,68,68,0.22)',
          borderRadius: 18,
          padding: '32px 32px 28px',
          maxWidth: 440,
          width: '100%',
          position: 'relative',
          boxShadow: '0 24px 64px -8px rgba(0,0,0,0.80), 0 0 0 1px rgba(239,68,68,0.06)',
          animation: 'fadeInUp 0.2s ease',
        }}
      >
        {/* Top amber/red accent line */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 48,
            right: 48,
            height: 2,
            background: 'linear-gradient(90deg, transparent, rgba(245,158,11,0.65), transparent)',
            borderRadius: '0 0 2px 2px',
          }}
        />

        {/* Warning icon */}
        <div
          style={{
            width: 52,
            height: 52,
            borderRadius: 13,
            background: 'linear-gradient(135deg, rgba(245,158,11,0.16) 0%, rgba(245,158,11,0.07) 100%)',
            border: '1px solid rgba(245,158,11,0.28)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 20,
            boxShadow: '0 0 20px rgba(245,158,11,0.14)',
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="#fbbf24" strokeWidth={1.7} style={{ width: 26, height: 26 }}>
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" strokeLinecap="round" strokeLinejoin="round" />
            <line x1="12" y1="9" x2="12" y2="13" strokeLinecap="round" />
            <line x1="12" y1="17" x2="12.01" y2="17" strokeLinecap="round" />
          </svg>
        </div>

        <div style={{ fontSize: '1.08rem', fontWeight: 700, color: '#e2e8f0', marginBottom: 6, letterSpacing: '-0.02em' }}>
          Release Number
        </div>

        {/* DID displayed prominently */}
        <div
          style={{
            fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
            fontSize: '1.25rem',
            fontWeight: 800,
            color: '#60a5fa',
            letterSpacing: '0.04em',
            marginBottom: 16,
          }}
        >
          {fmt(did.did)}
        </div>

        {/* Warning text */}
        <div
          style={{
            padding: '13px 16px',
            borderRadius: 10,
            background: 'rgba(245,158,11,0.06)',
            border: '1px solid rgba(245,158,11,0.18)',
            marginBottom: 18,
            fontSize: '0.81rem',
            color: '#92400e',
            lineHeight: 1.6,
          }}
        >
          <span style={{ color: '#fbbf24', fontWeight: 600 }}>Warning: </span>
          <span style={{ color: '#a3a090' }}>
            Releasing this number will immediately stop call forwarding. The number will return to the available pool and may be claimed by another customer.
          </span>
        </div>

        <div style={{ fontSize: '0.83rem', color: '#64748b', marginBottom: 24, lineHeight: 1.55 }}>
          Are you sure you want to release{' '}
          <span style={{ fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', color: '#94a3b8', fontWeight: 600 }}>{fmt(did.did)}</span>?
        </div>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={isPending || holdPhase === 'done'}
            style={{
              padding: '9px 20px',
              borderRadius: 9,
              border: '1px solid rgba(255,255,255,0.08)',
              background: 'rgba(255,255,255,0.04)',
              color: '#64748b',
              fontSize: '0.83rem',
              fontWeight: 500,
              cursor: (isPending || holdPhase === 'done') ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              transition: 'background 0.15s, color 0.15s',
              opacity: (isPending || holdPhase === 'done') ? 0.5 : 1,
            }}
          >
            Cancel
          </button>

          {/* ── Hold-to-Release button ─────────────────────────── */}
          <button
            type="button"
            disabled={isPending || holdPhase === 'done'}
            onMouseDown={startHold}
            onMouseUp={cancelHold}
            onMouseLeave={cancelHold}
            onTouchStart={(e) => { e.preventDefault(); startHold(); }}
            onTouchEnd={(e) => { e.preventDefault(); cancelHold(); }}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
                e.preventDefault();
                startHold();
              }
            }}
            onKeyUp={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                cancelHold();
              }
            }}
            style={{
              position: 'relative',
              overflow: 'hidden',
              padding: '9px 22px',
              borderRadius: 9,
              border: holdPhase === 'holding'
                ? '1px solid rgba(239,68,68,0.55)'
                : '1px solid rgba(239,68,68,0.28)',
              background: holdPhase === 'done'
                ? 'rgba(239,68,68,0.30)'
                : 'rgba(239,68,68,0.10)',
              color: holdPhase === 'holding' ? '#fca5a5' : '#f87171',
              fontSize: '0.83rem',
              fontWeight: 700,
              cursor: (isPending || holdPhase === 'done') ? 'not-allowed' : 'pointer',
              fontFamily: 'inherit',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 7,
              minWidth: 162,
              letterSpacing: '-0.01em',
              userSelect: 'none',
              WebkitUserSelect: 'none',
              // Pulse on the border when actively holding
              animation: holdPhase === 'holding' ? 'releaseButtonPulse 0.9s ease-in-out infinite' : 'none',
              transition: 'border-color 0.2s, color 0.2s, background 0.2s',
              boxShadow: holdPhase === 'holding'
                ? '0 0 12px rgba(239,68,68,0.18), inset 0 0 0 1px rgba(239,68,68,0.06)'
                : '0 0 0 rgba(239,68,68,0)',
            }}
          >
            {/* Progress fill — solid bar that sweeps left to right */}
            <div
              aria-hidden="true"
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                bottom: 0,
                borderRadius: 9,
                background: `linear-gradient(90deg, rgba(245,158,11,0.55) 0%, rgba(239,68,68,0.7) 100%)`,
                width: `${holdProgress}%`,
                transition: holdPhase === 'idle' ? 'width 0.35s cubic-bezier(0.4,0,0.2,1)' : 'none',
                boxShadow: holdProgress > 2 && holdProgress < 100
                  ? '2px 0 16px 3px rgba(239,68,68,0.6), 0 0 24px rgba(245,158,11,0.3)'
                  : 'none',
              }}
            />

            {/* Label — rendered above the fill */}
            <span style={{ position: 'relative', zIndex: 1, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
              {(isPending || holdPhase === 'done') && (
                <svg viewBox="0 0 16 16" style={{ width: 12, height: 12, animation: 'spin 0.7s linear infinite', flexShrink: 0 }}>
                  <circle cx="8" cy="8" r="6" fill="none" stroke="rgba(239,68,68,0.35)" strokeWidth={2} />
                  <path d="M8 2a6 6 0 0 1 6 6" stroke="#ef4444" strokeWidth={2} fill="none" strokeLinecap="round" />
                </svg>
              )}
              {holdLabel}
            </span>
          </button>
        </div>

        {/* Keyframe animations injected once via a style tag */}
        <style>{`
          @keyframes releaseButtonPulse {
            0%   { box-shadow: 0 0 0 0 rgba(239,68,68,0.30), inset 0 0 0 1px rgba(239,68,68,0.06); }
            50%  { box-shadow: 0 0 0 4px rgba(239,68,68,0.08), inset 0 0 0 1px rgba(239,68,68,0.10); }
            100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.00), inset 0 0 0 1px rgba(239,68,68,0.06); }
          }
        `}</style>
      </div>
    </div>
  );
}

// ── My Numbers section ────────────────────────────────────────────────────────

interface MyNumbersSectionProps {
  items: DidInventoryItem[];
  isLoading: boolean;
  isError: boolean;
  onRelease: (item: DidInventoryItem) => void;
  onSwitchToNumbers: () => void;
}

function MyNumbersSection({ items, isLoading, isError, onRelease, onSwitchToNumbers }: MyNumbersSectionProps) {
  // ALL hooks unconditionally at top
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [filters, setFilters] = useState<DidFilterState>({ npa: '', nxx: '', state: '', search: '' });

  const availableStates = useMemo(() => extractStates(items), [items]);

  const filtered = useMemo(() => applyDidFilters(items, filters), [items, filters]);

  if (isLoading) {
    return (
      <DidCard>
        <DidSectionHeader title="My Numbers" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', padding: '48px 0', color: '#64748b' }}>
          <Spinner size="sm" />
          <span style={{ fontSize: '0.875rem' }}>Loading your numbers…</span>
        </div>
      </DidCard>
    );
  }

  if (isError) {
    return (
      <DidCard>
        <DidSectionHeader title="My Numbers" />
        <div style={{ padding: '16px 20px', margin: 16, borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171', fontSize: '0.85rem' }}>
          Unable to load your numbers. Please try refreshing.
        </div>
      </DidCard>
    );
  }

  return (
    <DidCard delay={0}>
      <DidSectionHeader
        title="My Numbers"
        count={items.length}
        countLabel={items.length === 1 ? 'number' : 'numbers'}
      />

      {items.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '56px 24px',
            gap: 14,
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: 'linear-gradient(135deg, rgba(59,130,246,0.12) 0%, rgba(59,130,246,0.06) 100%)',
              border: '1px solid rgba(59,130,246,0.20)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 0 20px rgba(59,130,246,0.10)',
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth={1.5} style={{ width: 28, height: 28, opacity: 0.65 }}>
              <path d="M3 5a2 2 0 0 1 2-2h3.28a1 1 0 0 1 .948.684l1.498 4.493a1 1 0 0 1-.502 1.21l-2.257 1.13a11.042 11.042 0 0 0 5.516 5.516l1.13-2.257a1 1 0 0 1 1.21-.502l4.493 1.498a1 1 0 0 1 .684.949V19a2 2 0 0 1-2 2h-1C9.716 21 3 14.284 3 6V5z" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <div>
            <p style={{ color: '#94a3b8', fontSize: '0.95rem', fontWeight: 600, margin: '0 0 6px' }}>
              No numbers assigned yet
            </p>
            <p style={{ color: '#475569', fontSize: '0.82rem', margin: 0, lineHeight: 1.6, maxWidth: 360 }}>
              Browse the available numbers below and request one for your account. Assignments are approved by our team — usually within one business day.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Filter bar */}
          <DidFilterBar
            filters={filters}
            onFiltersChange={setFilters}
            availableStates={availableStates}
            resultCount={filtered.length}
            totalCount={items.length}
          />

          {filtered.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '40px 24px',
                gap: 10,
                textAlign: 'center',
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth={1.5} style={{ width: 28, height: 28 }}>
                <path d="m21 21-5.197-5.197M15.803 15.803A7.5 7.5 0 1 0 4.197 4.197a7.5 7.5 0 0 0 11.606 11.606Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p style={{ color: '#64748b', fontSize: '0.85rem', fontWeight: 500, margin: 0 }}>
                No numbers match these filters
              </p>
              <button
                type="button"
                onClick={() => setFilters({ npa: '', nxx: '', state: '', search: '' })}
                style={{ background: 'transparent', border: 'none', color: '#3b82f6', fontSize: '0.78rem', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit', padding: 0 }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead>
                  <tr>
                    <DidTh></DidTh>
                    <DidTh>DID</DidTh>
                    <DidTh>NPA</DidTh>
                    <DidTh>City</DidTh>
                    <DidTh>State</DidTh>
                    <DidTh>Product</DidTh>
                    <DidTh>Status</DidTh>
                    <DidTh>Assigned</DidTh>
                    <DidTh></DidTh>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item, idx) => {
                    const isExpanded = expandedId === item.id;
                    return (
                      <>
                        <tr
                          key={item.id}
                          style={{
                            borderBottom: isExpanded ? 'none' : (idx < filtered.length - 1 ? '1px solid rgba(59,130,246,0.06)' : 'none'),
                            animation: 'fadeInUp 0.3s ease both',
                            animationDelay: `${idx * 40}ms`,
                            cursor: 'pointer',
                            background: isExpanded ? 'rgba(59,130,246,0.05)' : 'transparent',
                            transition: 'background 0.15s',
                          }}
                          onClick={() => setExpandedId(isExpanded ? null : item.id)}
                          onMouseEnter={(e) => {
                            if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(59,130,246,0.03)';
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLTableRowElement).style.background = isExpanded ? 'rgba(59,130,246,0.05)' : 'transparent';
                          }}
                        >
                          {/* Expand chevron */}
                          <td style={{ padding: '13px 8px 13px 16px', width: 28 }}>
                            <svg
                              viewBox="0 0 16 16"
                              fill="none"
                              stroke="#475569"
                              strokeWidth={2}
                              strokeLinecap="round"
                              style={{
                                width: 12,
                                height: 12,
                                transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
                                transition: 'transform 0.2s',
                                display: 'block',
                              }}
                            >
                              <path d="M3 6l5 5 5-5" />
                            </svg>
                          </td>

                          <td style={{ padding: '13px 16px' }}>
                            <div>
                              <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#e2e8f0', fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', letterSpacing: '0.02em' }}>
                                {fmt(item.did)}
                              </div>
                              <div style={{ fontSize: '0.63rem', color: '#334155', fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', marginTop: 2, letterSpacing: '0.01em' }}>
                                {item.did}
                              </div>
                            </div>
                          </td>

                          {/* NPA */}
                          <td style={{ padding: '13px 16px' }}>
                            <span style={{ fontSize: '0.80rem', color: '#60a5fa', fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', fontWeight: 600, letterSpacing: '0.04em' }}>
                              {extractNpa(item.did)}
                            </span>
                          </td>

                          <td style={{ padding: '13px 16px' }}>
                            <span style={{ fontSize: '0.82rem', color: item.city ? '#94a3b8' : '#2d3748', fontStyle: item.city ? 'normal' : 'italic' }}>
                              {item.city ?? '—'}
                            </span>
                          </td>
                          <td style={{ padding: '13px 16px' }}>
                            <span style={{ fontSize: '0.82rem', color: item.state ? '#94a3b8' : '#2d3748', fontWeight: item.state ? 600 : 400 }}>
                              {item.state ?? '—'}
                            </span>
                          </td>
                          <td style={{ padding: '13px 16px' }}>
                            <span
                              style={{
                                fontSize: '0.67rem',
                                fontWeight: 600,
                                color: '#60a5fa',
                                background: 'rgba(59,130,246,0.10)',
                                border: '1px solid rgba(59,130,246,0.22)',
                                borderRadius: 5,
                                padding: '3px 8px',
                                textTransform: 'uppercase',
                                letterSpacing: '0.05em',
                              }}
                            >
                              {item.product_type ?? 'RCF'}
                            </span>
                          </td>
                          <td style={{ padding: '13px 16px' }}>
                            {didStatusBadge(item.status)}
                          </td>
                          <td style={{ padding: '13px 16px' }}>
                            <span style={{ fontSize: '0.78rem', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
                              {fmtAssignedDate(item.assigned_at)}
                            </span>
                          </td>

                          {/* Release button */}
                          <td style={{ padding: '10px 16px' }} onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => onRelease(item)}
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: 5,
                                padding: '6px 13px',
                                borderRadius: 7,
                                border: '1px solid rgba(239,68,68,0.22)',
                                background: 'rgba(239,68,68,0.10)',
                                color: '#ef4444',
                                fontSize: '0.72rem',
                                fontWeight: 600,
                                cursor: 'pointer',
                                fontFamily: 'inherit',
                                letterSpacing: '0.01em',
                                transition: 'background 0.15s, color 0.15s, border-color 0.15s',
                                whiteSpace: 'nowrap',
                              }}
                              onMouseEnter={(e) => {
                                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.20)';
                                (e.currentTarget as HTMLButtonElement).style.color = '#fca5a5';
                                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(239,68,68,0.38)';
                              }}
                              onMouseLeave={(e) => {
                                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.10)';
                                (e.currentTarget as HTMLButtonElement).style.color = '#ef4444';
                                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(239,68,68,0.22)';
                              }}
                              title="Release this number back to the pool"
                            >
                              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 10, height: 10 }}>
                                <path d="M13 4L4 13M4 4l9 9" strokeLinecap="round" />
                              </svg>
                              Release
                            </button>
                          </td>
                        </tr>

                        {/* Expanded detail panel */}
                        {isExpanded && (
                          <tr key={`${item.id}-detail`}>
                            <td
                              colSpan={9}
                              style={{
                                padding: '0 20px 20px 20px',
                                background: 'rgba(59,130,246,0.03)',
                                borderBottom: idx < filtered.length - 1 ? '1px solid rgba(59,130,246,0.08)' : 'none',
                              }}
                            >
                              {/* Detail panel */}
                              <div
                                style={{
                                  background: 'rgba(15,17,23,0.65)',
                                  backdropFilter: 'blur(10px)',
                                  WebkitBackdropFilter: 'blur(10px)',
                                  border: '1px solid rgba(59,130,246,0.14)',
                                  borderRadius: 12,
                                  padding: '20px 22px',
                                  display: 'grid',
                                  gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
                                  gap: 16,
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
                                    background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.45), transparent)',
                                  }}
                                />

                                {/* DID large */}
                                <div>
                                  <div style={{ fontSize: '0.58rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                                    Number
                                  </div>
                                  <div style={{ fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', fontSize: '1.15rem', fontWeight: 800, color: '#60a5fa', letterSpacing: '0.04em' }}>
                                    {fmt(item.did)}
                                  </div>
                                  <div style={{ fontSize: '0.67rem', color: '#334155', fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', marginTop: 3 }}>
                                    {item.did}
                                  </div>
                                </div>

                                {/* Location */}
                                <div>
                                  <div style={{ fontSize: '0.58rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                                    Location
                                  </div>
                                  <div style={{ fontSize: '0.88rem', color: '#e2e8f0', fontWeight: 600, lineHeight: 1.4 }}>
                                    {item.city ?? '—'}
                                    {item.state ? `, ${item.state}` : ''}
                                  </div>
                                  {item.rate_center && (
                                    <div style={{ fontSize: '0.73rem', color: '#64748b', marginTop: 3 }}>
                                      Rate Center: {item.rate_center}
                                    </div>
                                  )}
                                  {item.lata && (
                                    <div style={{ fontSize: '0.70rem', color: '#475569', marginTop: 1 }}>
                                      LATA: {item.lata}
                                    </div>
                                  )}
                                </div>

                                {/* Product & Status */}
                                <div>
                                  <div style={{ fontSize: '0.58rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                                    Product
                                  </div>
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                    <span
                                      style={{
                                        display: 'inline-flex',
                                        alignSelf: 'flex-start',
                                        fontSize: '0.68rem',
                                        fontWeight: 600,
                                        color: '#60a5fa',
                                        background: 'rgba(59,130,246,0.12)',
                                        border: '1px solid rgba(59,130,246,0.24)',
                                        borderRadius: 5,
                                        padding: '3px 9px',
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.05em',
                                      }}
                                    >
                                      {item.product_type ?? 'RCF'}
                                    </span>
                                    {didStatusBadge(item.status)}
                                  </div>
                                </div>

                                {/* Assigned date */}
                                <div>
                                  <div style={{ fontSize: '0.58rem', fontWeight: 600, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 6 }}>
                                    Assigned Date
                                  </div>
                                  <div style={{ fontSize: '0.88rem', color: '#e2e8f0', fontWeight: 500 }}>
                                    {fmtAssignedDate(item.assigned_at)}
                                  </div>
                                </div>

                                {/* Configure Forwarding link */}
                                <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); onSwitchToNumbers(); }}
                                    style={{
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: 7,
                                      padding: '8px 16px',
                                      borderRadius: 8,
                                      border: 'none',
                                      background: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                                      color: '#fff',
                                      fontSize: '0.78rem',
                                      fontWeight: 700,
                                      cursor: 'pointer',
                                      fontFamily: 'inherit',
                                      letterSpacing: '-0.01em',
                                      boxShadow: '0 3px 12px rgba(59,130,246,0.30)',
                                      transition: 'filter 0.15s, box-shadow 0.15s',
                                      whiteSpace: 'nowrap',
                                    }}
                                    onMouseEnter={(e) => {
                                      (e.currentTarget as HTMLButtonElement).style.filter = 'brightness(1.1)';
                                      (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 4px 18px rgba(59,130,246,0.45)';
                                    }}
                                    onMouseLeave={(e) => {
                                      (e.currentTarget as HTMLButtonElement).style.filter = 'none';
                                      (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 3px 12px rgba(59,130,246,0.30)';
                                    }}
                                  >
                                    Configure Forwarding
                                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 12, height: 12 }}>
                                      <path d="M3 8h10M9 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                  </button>
                                </div>
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </DidCard>
  );
}

// ── Pending Requests section ──────────────────────────────────────────────────

function PendingRequestsSection({ items }: { items: DidInventoryItem[] }) {
  if (items.length === 0) return null;

  return (
    <DidCard delay={80}>
      <DidSectionHeader
        title="Pending Requests"
        count={items.length}
        countLabel={items.length === 1 ? 'pending' : 'pending'}
      />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 440 }}>
          <thead>
            <tr>
              <DidTh>DID</DidTh>
              <DidTh>City</DidTh>
              <DidTh>State</DidTh>
              <DidTh>Requested</DidTh>
              <DidTh>Status</DidTh>
            </tr>
          </thead>
          <tbody>
            {items.map((item, idx) => (
              <tr
                key={item.id}
                style={{
                  borderBottom: idx < items.length - 1 ? '1px solid rgba(59,130,246,0.06)' : 'none',
                  animation: 'fadeInUp 0.3s ease both',
                  animationDelay: `${idx * 40}ms`,
                }}
              >
                <td style={{ padding: '12px 16px' }}>
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#e2e8f0', fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', letterSpacing: '0.02em' }}>
                    {fmt(item.did)}
                  </div>
                </td>
                <td style={{ padding: '12px 16px' }}>
                  <span style={{ fontSize: '0.82rem', color: '#94a3b8' }}>{item.city ?? '—'}</span>
                </td>
                <td style={{ padding: '12px 16px' }}>
                  <span style={{ fontSize: '0.82rem', color: '#94a3b8', fontWeight: 600 }}>{item.state ?? '—'}</span>
                </td>
                <td style={{ padding: '12px 16px' }}>
                  <span style={{ fontSize: '0.78rem', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtAssignedDate(item.assigned_at)}
                  </span>
                </td>
                <td style={{ padding: '12px 16px' }}>
                  {didStatusBadge(item.status)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DidCard>
  );
}

// ── Available Numbers section ─────────────────────────────────────────────────

function AvailableNumbersSection({
  items,
  isLoading,
  isError,
  onRequest,
  requestingDid,
}: {
  items: DidInventoryItem[];
  isLoading: boolean;
  isError: boolean;
  onRequest: (item: DidInventoryItem) => void;
  requestingDid: string | null;
}) {
  // ALL hooks unconditionally at top
  const [filters, setFilters] = useState<DidFilterState>({ npa: '', nxx: '', state: '', search: '' });

  const availableStates = useMemo(() => extractStates(items), [items]);

  // Sort by state by default so customers can scan regionally
  const sortedItems = useMemo(
    () =>
      [...items].sort((a, b) => {
        const stateA = a.state ?? '';
        const stateB = b.state ?? '';
        if (stateA !== stateB) return stateA.localeCompare(stateB);
        const cityA = a.city ?? '';
        const cityB = b.city ?? '';
        return cityA.localeCompare(cityB);
      }),
    [items],
  );

  const filtered = useMemo(() => applyDidFilters(sortedItems, filters), [sortedItems, filters]);

  if (isLoading) {
    return (
      <DidCard delay={160}>
        <DidSectionHeader title="Available Numbers" />
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', padding: '48px 0', color: '#64748b' }}>
          <Spinner size="sm" />
          <span style={{ fontSize: '0.875rem' }}>Loading available numbers…</span>
        </div>
      </DidCard>
    );
  }

  if (isError) {
    return (
      <DidCard delay={160}>
        <DidSectionHeader title="Available Numbers" />
        <div style={{ padding: '16px 20px', margin: 16, borderRadius: 10, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', color: '#f87171', fontSize: '0.85rem' }}>
          Unable to load available numbers. Please try refreshing.
        </div>
      </DidCard>
    );
  }

  return (
    <DidCard delay={160}>
      <DidSectionHeader
        title="Available Numbers"
        count={filtered.length}
        countLabel={filtered.length === 1 ? 'number available' : 'numbers available'}
      />

      {items.length === 0 ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '56px 24px',
            gap: 14,
            textAlign: 'center',
          }}
        >
          <div
            style={{
              width: 56,
              height: 56,
              borderRadius: 14,
              background: 'linear-gradient(135deg, rgba(59,130,246,0.10) 0%, rgba(59,130,246,0.05) 100%)',
              border: '1px solid rgba(59,130,246,0.16)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth={1.5} style={{ width: 26, height: 26, opacity: 0.5 }}>
              <rect x="3" y="3" width="18" height="18" rx="3" />
              <path d="M9 12h6M12 9v6" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <p style={{ color: '#94a3b8', fontSize: '0.95rem', fontWeight: 600, margin: '0 0 6px' }}>
              No numbers available right now
            </p>
            <p style={{ color: '#475569', fontSize: '0.82rem', margin: 0, lineHeight: 1.6, maxWidth: 360 }}>
              Our team is provisioning additional numbers. Check back soon or contact support to request a specific area code.
            </p>
          </div>
        </div>
      ) : (
        <>
          {/* Filter bar */}
          <DidFilterBar
            filters={filters}
            onFiltersChange={setFilters}
            availableStates={availableStates}
            resultCount={filtered.length}
            totalCount={items.length}
          />

          {filtered.length === 0 ? (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '48px 24px',
                gap: 10,
                textAlign: 'center',
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="#334155" strokeWidth={1.5} style={{ width: 32, height: 32 }}>
                <path d="m21 21-5.197-5.197M15.803 15.803A7.5 7.5 0 1 0 4.197 4.197a7.5 7.5 0 0 0 11.606 11.606Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p style={{ color: '#64748b', fontSize: '0.88rem', fontWeight: 500, margin: 0 }}>
                No numbers match these filters
              </p>
              <button
                type="button"
                onClick={() => setFilters({ npa: '', nxx: '', state: '', search: '' })}
                style={{ background: 'transparent', border: 'none', color: '#3b82f6', fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit', padding: 0 }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead>
                  <tr>
                    <DidTh>DID</DidTh>
                    <DidTh>NPA</DidTh>
                    <DidTh>State</DidTh>
                    <DidTh>City</DidTh>
                    <DidTh>Rate Center</DidTh>
                    <DidTh>Action</DidTh>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((item, idx) => {
                    const isRequesting = requestingDid === item.did;
                    return (
                      <tr
                        key={item.id}
                        style={{
                          borderBottom: idx < filtered.length - 1 ? '1px solid rgba(59,130,246,0.06)' : 'none',
                          animation: 'fadeInUp 0.3s ease both',
                          animationDelay: `${Math.min(idx * 30, 400)}ms`,
                          transition: 'background 0.15s',
                        }}
                        onMouseEnter={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(59,130,246,0.04)'; }}
                        onMouseLeave={(e) => { (e.currentTarget as HTMLTableRowElement).style.background = 'transparent'; }}
                      >
                        <td style={{ padding: '13px 16px' }}>
                          <div>
                            <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#e2e8f0', fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', letterSpacing: '0.02em' }}>
                              {fmt(item.did)}
                            </div>
                            <div style={{ fontSize: '0.63rem', color: '#334155', fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace', marginTop: 2 }}>
                              {item.did}
                            </div>
                          </div>
                        </td>

                        {/* NPA column */}
                        <td style={{ padding: '13px 16px' }}>
                          <span
                            style={{
                              fontSize: '0.80rem',
                              fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
                              fontWeight: 600,
                              color: '#60a5fa',
                              background: 'rgba(59,130,246,0.08)',
                              border: '1px solid rgba(59,130,246,0.16)',
                              borderRadius: 5,
                              padding: '2px 7px',
                              letterSpacing: '0.06em',
                              display: 'inline-block',
                            }}
                          >
                            {extractNpa(item.did)}
                          </span>
                        </td>

                        {/* State — prominent */}
                        <td style={{ padding: '13px 16px' }}>
                          <span style={{ fontSize: '0.82rem', color: item.state ? '#94a3b8' : '#2d3748', fontWeight: item.state ? 700 : 400 }}>
                            {item.state ?? '—'}
                          </span>
                        </td>

                        <td style={{ padding: '13px 16px' }}>
                          <span style={{ fontSize: '0.82rem', color: item.city ? '#94a3b8' : '#2d3748', fontStyle: item.city ? 'normal' : 'italic' }}>
                            {item.city ?? '—'}
                          </span>
                        </td>
                        <td style={{ padding: '13px 16px' }}>
                          <span style={{ fontSize: '0.78rem', color: '#64748b' }}>
                            {item.rate_center ?? '—'}
                          </span>
                        </td>
                        <td style={{ padding: '10px 16px' }}>
                          <button
                            type="button"
                            onClick={() => onRequest(item)}
                            disabled={isRequesting}
                            style={{
                              display: 'inline-flex',
                              alignItems: 'center',
                              gap: 6,
                              padding: '7px 16px',
                              borderRadius: 8,
                              border: 'none',
                              background: isRequesting
                                ? 'rgba(59,130,246,0.25)'
                                : 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)',
                              color: '#fff',
                              fontSize: '0.75rem',
                              fontWeight: 700,
                              cursor: isRequesting ? 'not-allowed' : 'pointer',
                              fontFamily: 'inherit',
                              letterSpacing: '0.02em',
                              boxShadow: isRequesting ? 'none' : '0 3px 12px rgba(59,130,246,0.30)',
                              transition: 'background 0.15s, box-shadow 0.15s, filter 0.15s',
                              whiteSpace: 'nowrap',
                            }}
                            onMouseEnter={(e) => {
                              if (!isRequesting) {
                                (e.currentTarget as HTMLButtonElement).style.filter = 'brightness(1.12)';
                                (e.currentTarget as HTMLButtonElement).style.boxShadow = '0 4px 18px rgba(59,130,246,0.45)';
                              }
                            }}
                            onMouseLeave={(e) => {
                              (e.currentTarget as HTMLButtonElement).style.filter = 'none';
                              (e.currentTarget as HTMLButtonElement).style.boxShadow = isRequesting ? 'none' : '0 3px 12px rgba(59,130,246,0.30)';
                            }}
                          >
                            {isRequesting ? (
                              <svg viewBox="0 0 16 16" style={{ width: 11, height: 11, animation: 'spin 0.7s linear infinite' }}>
                                <circle cx="8" cy="8" r="6" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={2} />
                                <path d="M8 2a6 6 0 0 1 6 6" stroke="#fff" strokeWidth={2} fill="none" strokeLinecap="round" />
                              </svg>
                            ) : (
                              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 11, height: 11 }}>
                                <circle cx="8" cy="8" r="6" />
                                <path d="M8 5v6M5 8h6" strokeLinecap="round" />
                              </svg>
                            )}
                            {isRequesting ? 'Requesting…' : 'Request'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </DidCard>
  );
}

// ── DIDManagementTab (root) ───────────────────────────────────────────────────

interface DIDManagementTabProps {
  customerId: number | undefined;
  onSwitchTab: (tab: DashboardTab) => void;
}

function DIDManagementTab({ customerId, onSwitchTab }: DIDManagementTabProps) {
  // ALL hooks unconditionally at top — React rules-of-hooks
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();

  // Request modal state
  const [requestTarget, setRequestTarget] = useState<DidInventoryItem | null>(null);
  // Release modal state
  const [releaseTarget, setReleaseTarget] = useState<DidInventoryItem | null>(null);

  const {
    data: myDids,
    isLoading: myLoading,
    isError: myError,
  } = useQuery({
    queryKey: ['my-dids', customerId],
    queryFn: () => listMyDids(),
    staleTime: 30_000,
  });

  const {
    data: availableDids,
    isLoading: availLoading,
    isError: availError,
  } = useQuery({
    queryKey: ['available-dids'],
    queryFn: () => listAvailableDids({ limit: 200 }),
    staleTime: 30_000,
  });

  const requestMutation = useMutation({
    mutationFn: (did: string) => requestDid(did),
    onSuccess: (_data, did) => {
      void queryClient.invalidateQueries({ queryKey: ['my-dids'] });
      void queryClient.invalidateQueries({ queryKey: ['available-dids'] });
      setRequestTarget(null);
      toastOk(`Number requested — ${fmt(did)} is pending admin approval`);
    },
    onError: (err: Error) => {
      setRequestTarget(null);
      toastErr(err.message ?? 'Failed to request number');
    },
  });

  const releaseMutation = useMutation({
    mutationFn: (did: string) => releaseDid(did),
    onSuccess: (_data, did) => {
      void queryClient.invalidateQueries({ queryKey: ['my-dids'] });
      void queryClient.invalidateQueries({ queryKey: ['available-dids'] });
      setReleaseTarget(null);
      toastOk(`Number released — ${fmt(did)} has returned to the pool`);
    },
    onError: (err: Error) => {
      setReleaseTarget(null);
      toastErr(err.message ?? 'Failed to release number');
    },
  });

  const myItems = myDids ?? [];
  const availItems = availableDids ?? [];

  // Split my numbers into assigned vs reserved/pending
  const assignedItems = useMemo(
    () => myItems.filter((d) => d.status === 'assigned'),
    [myItems],
  );
  const pendingItems = useMemo(
    () => myItems.filter((d) => d.status === 'reserved'),
    [myItems],
  );

  function handleRequestClick(item: DidInventoryItem) {
    setRequestTarget(item);
  }

  function handleConfirmRequest(item: DidInventoryItem) {
    requestMutation.mutate(item.did);
  }

  function handleReleaseClick(item: DidInventoryItem) {
    setReleaseTarget(item);
  }

  function handleConfirmRelease(item: DidInventoryItem) {
    releaseMutation.mutate(item.did);
  }

  return (
    <>
      {/* Request confirmation modal */}
      {requestTarget && (
        <RequestModal
          did={requestTarget}
          onConfirm={handleConfirmRequest}
          onCancel={() => setRequestTarget(null)}
          isPending={requestMutation.isPending}
        />
      )}

      {/* Release confirmation modal */}
      {releaseTarget && (
        <ReleaseModal
          did={releaseTarget}
          onConfirm={handleConfirmRelease}
          onCancel={() => setReleaseTarget(null)}
          isPending={releaseMutation.isPending}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Section 1: My Numbers (assigned) */}
        <MyNumbersSection
          items={assignedItems}
          isLoading={myLoading}
          isError={myError}
          onRelease={handleReleaseClick}
          onSwitchToNumbers={() => onSwitchTab('numbers')}
        />

        {/* Section 2: Pending Requests */}
        <PendingRequestsSection items={pendingItems} />

        {/* Section 3: Available Numbers */}
        <AvailableNumbersSection
          items={availItems}
          isLoading={availLoading}
          isError={availError}
          onRequest={handleRequestClick}
          requestingDid={requestMutation.isPending ? (requestMutation.variables ?? null) : null}
        />
      </div>
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function RcfPage() {
  // ── All hooks unconditionally at top (React rules-of-hooks) ──────────────────
  const { user, isAdmin } = useAuth();

  // Tab state
  const [activeTab, setActiveTab] = useState<DashboardTab>('numbers');

  // Admin customer selector
  const [adminSelectedCustomer, setAdminSelectedCustomer] = useState<number | undefined>(undefined);
  const customerId = isAdmin ? adminSelectedCustomer : (user?.customer_id ?? undefined);

  // Numbers tab state
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sortField, setSortField] = useState<SortField>('did');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [searchFocused, setSearchFocused] = useState(false);
  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({});
  const [npaFilter, setNpaFilter] = useState('');

  // Numbers query — always run (enabled unconditionally)
  const { data, isLoading, isError } = useQuery({
    queryKey: ['rcf', customerId, page, pageSize],
    queryFn: () => listRcf({ limit: pageSize, offset: (page - 1) * pageSize, customer_id: customerId }),
  });

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  // Derived Numbers tab values
  const rawEntries: RcfEntry[] = useMemo(() => data?.items ?? [], [data]);
  const serverTotal: number = data?.total ?? 0;

  const filteredEntries = useMemo(() => {
    let result = rawEntries;
    if (npaFilter.length === 3) {
      result = result.filter((e) => extractNpa(e.did) === npaFilter);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (e) =>
          e.did.includes(q) ||
          e.forward_to.toLowerCase().includes(q) ||
          (e.name ?? '').toLowerCase().includes(q) ||
          (e.customer_name ?? '').toLowerCase().includes(q),
      );
    }
    return result;
  }, [rawEntries, searchQuery, npaFilter]);

  const sortedEntries = useMemo(
    () => sortEntries(filteredEntries, sortField, sortDir),
    [filteredEntries, sortField, sortDir],
  );

  const role = user?.role ?? 'user';
  const canEdit = role !== 'readonly';
  const totalPages = Math.max(1, Math.ceil(serverTotal / pageSize));
  const activeCount = useMemo(() => rawEntries.filter((e) => e.enabled).length, [rawEntries]);
  const disabledCount = useMemo(() => rawEntries.filter((e) => !e.enabled).length, [rawEntries]);
  const useCardView = !isAdmin && role !== 'readonly' && serverTotal <= 10;

  // ── Handlers ──────────────────────────────────────────────────────────────────

  function handleSearchInput(value: string) {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearchQuery(value.trim());
      setPage(1);
    }, 250);
  }

  function handleCustomerSelect(id: number | undefined) {
    setAdminSelectedCustomer(id);
    setPage(1);
    setSearchInput('');
    setSearchQuery('');
    setNpaFilter('');
  }

  function handlePendingChange(did: string, value: string) {
    setPendingEdits((prev) => ({ ...prev, [did]: value }));
  }

  function resolveValue(entry: RcfEntry): string {
    return pendingEdits[entry.did] !== undefined ? pendingEdits[entry.did] : entry.forward_to;
  }

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  }

  const pageTitle = user?.customer_name
    ? `${user.customer_name}'s Numbers`
    : 'Remote Call Forwarding';

  // ── Render ────────────────────────────────────────────────────────────────────

  return (
    <div style={{ paddingTop: 20 }}>
      {/* Premium glass-morphism header */}
      <RcfPageHeader
        title={pageTitle}
        subtitle="Manage your Remote Call Forwarding numbers and monitor call health — all in one place."
        totalNumbers={isLoading ? 0 : serverTotal}
        activeCount={isLoading ? 0 : activeCount}
        disabledCount={isLoading ? 0 : disabledCount}
      />

      {/* Admin customer selector */}
      <AdminCustomerSelector
        selectedCustomerId={adminSelectedCustomer}
        onSelect={handleCustomerSelect}
        accent="#3b82f6"
        accountTypes={['rcf', 'hybrid']}
      />

      {/* ── Tab navigation ──────────────────────────────────── */}
      <TabBar active={activeTab} onChange={setActiveTab} />

      {/* ── Numbers Tab ─────────────────────────────────────── */}
      {activeTab === 'numbers' && (
        <>
          {/* Toolbar: Search + count */}
          {!isLoading && !isError && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
              {/* Glass-morphism search bar */}
              <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
                <span
                  aria-hidden="true"
                  style={{
                    position: 'absolute',
                    left: 13,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: searchFocused ? '#3b82f6' : '#475569',
                    display: 'flex',
                    alignItems: 'center',
                    pointerEvents: 'none',
                    transition: 'color 0.2s',
                  }}
                >
                  <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 14, height: 14 }}>
                    <path d="m19 19-4.35-4.35M15 9A6 6 0 1 1 3 9a6 6 0 0 1 12 0Z" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </span>
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => handleSearchInput(e.target.value)}
                  placeholder="Filter by DID, name, or destination…"
                  onFocus={() => setSearchFocused(true)}
                  onBlur={() => setSearchFocused(false)}
                  style={{
                    width: '100%',
                    boxSizing: 'border-box',
                    padding: '9px 36px 9px 36px',
                    fontSize: '0.83rem',
                    background: searchFocused ? 'rgba(19,21,29,0.85)' : 'rgba(19,21,29,0.65)',
                    backdropFilter: 'blur(8px)',
                    WebkitBackdropFilter: 'blur(8px)',
                    border: `1px solid ${searchFocused ? 'rgba(59,130,246,0.45)' : 'rgba(59,130,246,0.12)'}`,
                    borderRadius: 11,
                    color: '#e2e8f0',
                    outline: 'none',
                    fontFamily: 'inherit',
                    transition: 'border-color 0.2s, box-shadow 0.2s, background 0.2s',
                    boxShadow: searchFocused
                      ? '0 0 0 3px rgba(59,130,246,0.14), 0 4px 16px rgba(0,0,0,0.3)'
                      : '0 2px 8px rgba(0,0,0,0.2)',
                  }}
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={() => { setSearchInput(''); setSearchQuery(''); }}
                    style={{
                      position: 'absolute',
                      right: 10,
                      top: '50%',
                      transform: 'translateY(-50%)',
                      background: 'rgba(59,130,246,0.12)',
                      border: '1px solid rgba(59,130,246,0.20)',
                      borderRadius: 5,
                      color: '#60a5fa',
                      cursor: 'pointer',
                      padding: '2px 5px',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 10, height: 10 }}>
                      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>

              {/* NPA (area code) filter */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <label style={{ fontSize: '0.68rem', fontWeight: 600, color: '#475569', whiteSpace: 'nowrap' }}>
                  NPA
                </label>
                <input
                  type="text"
                  value={npaFilter}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, '').slice(0, 3);
                    setNpaFilter(v);
                    setPage(1);
                  }}
                  placeholder="617"
                  maxLength={3}
                  inputMode="numeric"
                  title="Filter by area code (NPA)"
                  style={{
                    width: 56,
                    padding: '8px 8px',
                    fontSize: '0.83rem',
                    fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
                    textAlign: 'center',
                    letterSpacing: '0.08em',
                    background: npaFilter.length === 3 ? 'rgba(19,21,29,0.85)' : 'rgba(19,21,29,0.65)',
                    backdropFilter: 'blur(8px)',
                    WebkitBackdropFilter: 'blur(8px)',
                    border: `1px solid ${npaFilter.length === 3 ? 'rgba(59,130,246,0.55)' : 'rgba(59,130,246,0.12)'}`,
                    borderRadius: 9,
                    color: npaFilter.length === 3 ? '#60a5fa' : '#e2e8f0',
                    outline: 'none',
                    boxShadow: npaFilter.length === 3 ? '0 0 0 3px rgba(59,130,246,0.14)' : '0 2px 8px rgba(0,0,0,0.2)',
                    transition: 'border-color 0.2s, box-shadow 0.2s, color 0.2s',
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = 'rgba(59,130,246,0.45)';
                    e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.14), 0 4px 16px rgba(0,0,0,0.3)';
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = npaFilter.length === 3 ? 'rgba(59,130,246,0.55)' : 'rgba(59,130,246,0.12)';
                    e.currentTarget.style.boxShadow = npaFilter.length === 3 ? '0 0 0 3px rgba(59,130,246,0.14)' : '0 2px 8px rgba(0,0,0,0.2)';
                  }}
                />
                {npaFilter && (
                  <button
                    type="button"
                    onClick={() => { setNpaFilter(''); setPage(1); }}
                    style={{
                      background: 'rgba(59,130,246,0.10)',
                      border: '1px solid rgba(59,130,246,0.18)',
                      borderRadius: 5,
                      color: '#60a5fa',
                      cursor: 'pointer',
                      padding: '3px 5px',
                      display: 'flex',
                      alignItems: 'center',
                    }}
                    title="Clear NPA filter"
                  >
                    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 9, height: 9 }}>
                      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                    </svg>
                  </button>
                )}
              </div>

              {/* Count pill */}
              {serverTotal > 0 && (
                <div
                  style={{
                    fontSize: '0.72rem',
                    fontWeight: 600,
                    color: '#3b82f6',
                    background: 'rgba(59,130,246,0.10)',
                    border: '1px solid rgba(59,130,246,0.20)',
                    borderRadius: 20,
                    padding: '5px 13px',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                    letterSpacing: '0.02em',
                  }}
                >
                  {(searchQuery || npaFilter.length === 3) && filteredEntries.length !== rawEntries.length
                    ? `${filteredEntries.length} of ${serverTotal}`
                    : `${serverTotal} ${serverTotal === 1 ? 'number' : 'numbers'}`}
                </div>
              )}
            </div>
          )}

          {/* Loading */}
          {isLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: '#718096', fontSize: '0.875rem', padding: '48px 0', justifyContent: 'center' }}>
              <Spinner size="sm" />
              <span>Loading your numbers…</span>
            </div>
          )}

          {/* Error */}
          {isError && (
            <div style={{ padding: '16px 20px', borderRadius: 12, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.22)', color: '#f87171', fontSize: '0.875rem', display: 'flex', alignItems: 'center', gap: 10 }}>
              <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16, flexShrink: 0 }}>
                <circle cx="8" cy="8" r="7" />
                <path d="M8 5v3.5M8 10.5v.5" strokeLinecap="round" />
              </svg>
              Unable to load RCF numbers. Please try refreshing the page.
            </div>
          )}

          {/* Empty (no numbers at all) */}
          {!isLoading && !isError && rawEntries.length === 0 && <EmptyState />}

          {/* Search empty state */}
          {!isLoading && !isError && rawEntries.length > 0 && sortedEntries.length === 0 && searchQuery && (
            <SearchEmptyState query={searchQuery} onClear={() => { setSearchInput(''); setSearchQuery(''); }} />
          )}

          {/* Card View (small customer accounts) */}
          {!isLoading && !isError && sortedEntries.length > 0 && useCardView && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-5">
                {sortedEntries.map((entry) => (
                  <RcfCard
                    key={entry.id}
                    entry={entry}
                    pendingValue={resolveValue(entry)}
                    onPendingChange={handlePendingChange}
                  />
                ))}
              </div>
              {serverTotal > pageSize && (
                <div style={{ marginTop: 20, background: 'rgba(19,21,29,0.65)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', border: '1px solid rgba(59,130,246,0.10)', borderRadius: 14, overflow: 'hidden' }}>
                  <PaginationControls
                    currentPage={page}
                    totalPages={totalPages}
                    pageSize={pageSize}
                    totalItems={serverTotal}
                    onPageChange={setPage}
                    onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
                  />
                </div>
              )}
            </>
          )}

          {/* Table View */}
          {!isLoading && !isError && sortedEntries.length > 0 && !useCardView && (
            <div style={{ background: 'rgba(19,21,29,0.68)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)', border: '1px solid rgba(59,130,246,0.12)', borderRadius: 16, overflow: 'hidden', boxShadow: '0 8px 32px -8px rgba(0,0,0,0.45)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    <SortHeader label="DID"        field="did"        currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                    <SortHeader label="Name"       field="name"       currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                    <SortHeader label="Forward To" field="forward_to" currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                    <SortHeader label="Status"     field="status"     currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                    <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: '0.6rem', fontWeight: 600, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.05em', whiteSpace: 'nowrap', background: 'rgba(59,130,246,0.04)' }}>Caller ID</th>
                    {isAdmin && (
                      <SortHeader label="Customer" field="customer" currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                    )}
                  </tr>
                </thead>
                <tbody>
                  {sortedEntries.map((entry) => (
                    <TableRow
                      key={entry.id}
                      entry={entry}
                      isAdmin={isAdmin}
                      canEdit={canEdit}
                      pendingValue={resolveValue(entry)}
                      onPendingChange={handlePendingChange}
                    />
                  ))}
                </tbody>
              </table>
              {serverTotal > pageSize && (
                <PaginationControls
                  currentPage={page}
                  totalPages={totalPages}
                  pageSize={pageSize}
                  totalItems={serverTotal}
                  onPageChange={setPage}
                  onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
                />
              )}
            </div>
          )}
        </>
      )}

      {/* ── Call Activity Tab ────────────────────────────────── */}
      {activeTab === 'activity' && (
        <CallActivityTab customerId={customerId} />
      )}

      {/* ── DID Management Tab ───────────────────────────────── */}
      {activeTab === 'dids' && (
        <DIDManagementTab customerId={customerId} onSwitchTab={setActiveTab} />
      )}
    </div>
  );
}

// ─── PortalHeader (kept for other pages that import it) ──────────────────────

interface PortalHeaderProps {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  badgeVariant?: 'rcf' | 'api' | 'trunk';
  userEmail?: string | null;
}

const ACCENT_BY_VARIANT: Record<string, string> = {
  rcf: '#3b82f6',
  api: '#a855f7',
  trunk: '#f59e0b',
};

export function PortalHeader({ icon, title, subtitle, badgeVariant = 'rcf', userEmail }: PortalHeaderProps) {
  const accent = ACCENT_BY_VARIANT[badgeVariant] ?? '#3b82f6';

  return (
    <div
      style={{
        marginBottom: 36,
        paddingTop: 8,
        paddingBottom: 28,
        borderBottom: '1px solid rgba(42,47,69,0.6)',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 14,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: `linear-gradient(135deg, ${accent}20 0%, ${accent}10 100%)`,
          border: `1px solid ${accent}30`,
          color: accent,
          marginBottom: 14,
        }}
        aria-hidden="true"
      >
        {icon}
      </div>

      <h1
        style={{
          fontSize: '1.5rem',
          fontWeight: 800,
          letterSpacing: '-0.02em',
          color: '#e2e8f0',
          lineHeight: 1.15,
          margin: '0 0 6px',
        }}
      >
        {title}
      </h1>

      {userEmail && (
        <div
          style={{
            fontSize: '0.78rem',
            color: accent,
            fontWeight: 600,
            letterSpacing: '0.01em',
            marginBottom: 6,
          }}
        >
          {userEmail}
        </div>
      )}

      <p
        style={{
          fontSize: '0.85rem',
          color: '#718096',
          marginTop: 2,
          lineHeight: 1.6,
          maxWidth: 480,
          marginLeft: 'auto',
          marginRight: 'auto',
        }}
      >
        {subtitle}
      </p>
    </div>
  );
}
