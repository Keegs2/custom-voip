import { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Spinner } from '../components/ui/Spinner';
import { listRcf } from '../api/rcf';
import type { RcfEntry } from '../types/rcf';
import { RcfCard } from './RcfCard';
import { useAuth } from '../contexts/AuthContext';
import { AdminCustomerSelector } from '../components/AdminCustomerSelector';
import { fmt, fmtDuration } from '../utils/format';
import { apiRequest } from '../api/client';
import { useToast } from '../components/ui/Toast';
import { searchCdrs, getCdrSummary } from '../api/cdrs';
import type { Cdr } from '../types/cdr';
import { listAvailableDids, listMyDids, requestDid } from '../api/didInventory';
import type { DidInventoryItem } from '../types/didInventory';

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
        letterSpacing: '0.12em',
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
            fontFamily: 'monospace',
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
          fontFamily: 'monospace',
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
              fontFamily: 'monospace',
              letterSpacing: '0.02em',
              lineHeight: 1.2,
            }}
          >
            {fmt(entry.did)}
          </div>
          <div style={{ fontSize: '0.63rem', color: '#334155', fontFamily: 'monospace', marginTop: 3, letterSpacing: '0.01em' }}>
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
        {/* Keystone logo with glow */}
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
              src="/keystone_logo.png"
              alt="Keystone"
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
              fontWeight: 700,
              letterSpacing: '0.14em',
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
                    letterSpacing: '0.09em',
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
          src="/keystone_logo.png"
          alt="Keystone"
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

type DashboardTab = 'numbers' | 'activity' | 'quality' | 'dids';

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

function callStatusInfo(cdr: Cdr): { label: string; bg: string; color: string } {
  if (cdr.answer_time != null && cdr.duration_seconds > 0) {
    return { label: 'Answered', bg: 'rgba(59,130,246,0.12)', color: '#60a5fa' };
  }
  const cause = (cdr.hangup_cause ?? '').toLowerCase();
  if (cause.includes('no_answer') || cause.includes('no answer') || cause === 'originator_cancel') {
    return { label: 'No Answer', bg: 'rgba(245,158,11,0.12)', color: '#f59e0b' };
  }
  if (cdr.sip_code != null && cdr.sip_code >= 400) {
    return { label: 'Failed', bg: 'rgba(239,68,68,0.12)', color: '#ef4444' };
  }
  if (cdr.duration_seconds === 0 && cdr.answer_time == null) {
    return { label: 'No Answer', bg: 'rgba(245,158,11,0.12)', color: '#f59e0b' };
  }
  return { label: 'Answered', bg: 'rgba(59,130,246,0.12)', color: '#60a5fa' };
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
      id: 'quality',
      label: 'Quality',
      icon: (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 13, height: 13 }}>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 5v3l2 2" strokeLinecap="round" strokeLinejoin="round" />
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

function CallActivityTab({ customerId }: CallActivityTabProps) {
  const [activitySearch, setActivitySearch] = useState('');

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

  const allCalls = data?.items ?? [];
  const calls = useMemo(() => {
    if (!activitySearch.trim()) return allCalls;
    const q = activitySearch.trim().toLowerCase();
    return allCalls.filter((c) => {
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
  }, [allCalls, activitySearch]);

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

  if (calls.length === 0) {
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
        <span style={{ fontSize: '0.72rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          Recent Calls
        </span>
        <div
          style={{
            flex: 1,
            minWidth: 200,
            position: 'relative',
          }}
        >
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
          {calls.length}{activitySearch.trim() ? ` of ${allCalls.length}` : ''} shown
        </span>
      </div>

      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 680 }}>
          <thead>
            <tr style={{ background: 'rgba(59,130,246,0.04)', borderBottom: '1px solid rgba(59,130,246,0.10)' }}>
              {['Time', 'From', 'To (DID)', 'Forwarded To', 'Duration', 'Status', 'Quality'].map((h) => (
                <th
                  key={h}
                  style={{
                    padding: '11px 14px',
                    textAlign: 'left',
                    fontSize: '0.6rem',
                    fontWeight: 700,
                    color: '#475569',
                    textTransform: 'uppercase',
                    letterSpacing: '0.11em',
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
                    animation: `fadeInUp 0.3s ease both`,
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
                    <span style={{ fontSize: '0.82rem', color: '#94a3b8', fontFamily: 'monospace', fontWeight: 500 }}>
                      {fmt(cdr.caller_id)}
                    </span>
                  </td>

                  {/* To (DID) */}
                  <td style={{ padding: '12px 14px' }}>
                    <span style={{ fontSize: '0.82rem', color: '#60a5fa', fontFamily: 'monospace', fontWeight: 600 }}>
                      {fmt(cdr.destination)}
                    </span>
                  </td>

                  {/* Forwarded To */}
                  <td style={{ padding: '12px 14px' }}>
                    <span style={{ fontSize: '0.78rem', color: '#64748b', fontFamily: 'monospace' }}>
                      {cdr.carrier_used ? fmt(cdr.carrier_used) : '—'}
                    </span>
                  </td>

                  {/* Duration */}
                  <td style={{ padding: '12px 14px', whiteSpace: 'nowrap' }}>
                    <span style={{ fontSize: '0.82rem', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                      {cdr.duration_seconds > 0 ? fmtDuration(cdr.duration_seconds) : '—'}
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
  );
}

// ─── Quality helpers ──────────────────────────────────────────────────────────

/** Format raw bytes into a human-readable KB / MB string. */
function fmtBytes(bytes: number): string {
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/** Format seconds as mm:ss (e.g. 90 → "1:30"). */
function fmtMmSs(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Relative timestamp — how long ago a call started. */
function relativeTime(isoString: string): string {
  const diffMs = Date.now() - new Date(isoString).getTime();
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

/** Return green/amber/red for MOS thresholds. */
function mosColor(mos: number | null | undefined): string {
  if (mos == null) return '#475569';
  if (mos >= 4) return '#22c55e';
  if (mos >= 3) return '#f59e0b';
  return '#ef4444';
}

/** Return green/amber/red for quality_pct thresholds. */
function qualityPctColor(pct: number | null | undefined): string {
  if (pct == null) return '#475569';
  if (pct >= 90) return '#22c55e';
  if (pct >= 70) return '#f59e0b';
  return '#ef4444';
}

/** Return green/amber/red for packet loss percentage (lower = better). */
function packetLossColor(pct: number | null | undefined): string {
  if (pct == null) return '#475569';
  if (pct < 1) return '#22c55e';
  if (pct <= 3) return '#f59e0b';
  return '#ef4444';
}

/** Return green/amber/red for jitter avg in ms (lower = better). */
function jitterColor(ms: number | null | undefined): string {
  if (ms == null) return '#475569';
  if (ms < 20) return '#22c55e';
  if (ms <= 50) return '#f59e0b';
  return '#ef4444';
}

/** Return green/amber/red for R-Factor (higher = better). */
function rFactorColor(r: number | null | undefined): string {
  if (r == null) return '#475569';
  if (r >= 80) return '#22c55e';
  if (r >= 70) return '#f59e0b';
  return '#ef4444';
}

/** Render a single metric row inside an expanded detail group. */
function MetricRow({
  label,
  value,
  color,
  sub,
}: {
  label: string;
  value: string;
  color?: string;
  sub?: string;
}) {
  const na = value === '—' || value === 'N/A';
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '9px 0',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <span style={{ fontSize: '0.73rem', color: '#64748b', flexShrink: 0 }}>{label}</span>
        <span
          style={{
            fontSize: '0.82rem',
            fontWeight: 600,
            color: na ? '#334155' : (color ?? '#e2e8f0'),
            fontVariantNumeric: 'tabular-nums',
            textAlign: 'right',
          }}
        >
          {value}
        </span>
      </div>
      {sub && (
        <span style={{ fontSize: '0.68rem', color: '#475569', lineHeight: 1.4 }}>{sub}</span>
      )}
    </div>
  );
}

/** A glass-morphism group card inside the expanded detail panel. */
function DetailGroup({
  title,
  accent,
  children,
}: {
  title: string;
  accent: string;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: 'rgba(19,21,29,0.70)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        border: `1px solid ${accent}22`,
        borderRadius: 12,
        padding: '14px 16px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Top accent line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 20,
          right: 20,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accent}55, transparent)`,
        }}
      />
      <div
        style={{
          fontSize: '0.60rem',
          fontWeight: 700,
          color: accent,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          marginBottom: 6,
          opacity: 0.85,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

/** Full expanded detail panel for a single CDR row. */
function CdrDetailPanel({ cdr }: { cdr: Cdr }) {
  const na = '—';
  const fmtNum = (v: number | null | undefined, decimals = 1) =>
    v != null ? v.toFixed(decimals) : na;
  const fmtPct = (v: number | null | undefined) =>
    v != null ? `${v.toFixed(2)}%` : na;
  const fmtMs = (v: number | null | undefined) =>
    v != null ? `${v.toFixed(1)} ms` : na;
  const fmtBytesOrNa = (v: number | null | undefined) =>
    v != null ? fmtBytes(v) : na;
  const fmtCount = (v: number | null | undefined) =>
    v != null ? v.toLocaleString() : na;
  const fmtStr = (v: string | null | undefined) =>
    v != null && v !== '' ? v : na;

  return (
    <div
      style={{
        padding: '16px 4px 8px',
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
        gap: 12,
      }}
    >
      {/* Group 1: Voice Quality Scores */}
      <DetailGroup title="Voice Quality Scores" accent="#22c55e">
        <MetricRow
          label="MOS (Mean Opinion Score)"
          value={cdr.mos != null ? cdr.mos.toFixed(2) : na}
          color={mosColor(cdr.mos)}
          sub="1–5 scale. 4+ = excellent HD clarity. Below 3 = degraded."
        />
        <MetricRow
          label="Quality Score"
          value={fmtPct(cdr.quality_pct)}
          color={qualityPctColor(cdr.quality_pct)}
          sub="Overall call quality percentage. 90%+ is excellent."
        />
        <MetricRow
          label="R-Factor"
          value={fmtNum(cdr.r_factor, 1)}
          color={rFactorColor(cdr.r_factor)}
          sub="ITU-T G.107. 80+ = high quality. 70–80 = acceptable. Below 70 = poor."
        />
        <MetricRow
          label="Flaw Count"
          value={fmtCount(cdr.flaw_total)}
          sub="Detected audio impairments. 0 = perfect."
        />
      </DetailGroup>

      {/* Group 2: Packet Performance */}
      <DetailGroup title="Packet Performance" accent="#3b82f6">
        <MetricRow
          label="Packet Loss"
          value={fmtPct(cdr.packet_loss_pct)}
          color={packetLossColor(cdr.packet_loss_pct)}
          sub="<1% = excellent. 1–3% = acceptable. >3% = degraded."
        />
        <MetricRow label="Packets Lost" value={fmtCount(cdr.packet_loss_count)} />
        <MetricRow label="Total Packets" value={fmtCount(cdr.packet_total_count)} />
        <MetricRow
          label="Packets Sent"
          value={fmtCount(cdr.rtp_audio_out_packet_count)}
          sub="Total RTP packets transmitted to carrier."
        />
        <MetricRow
          label="Packets Received"
          value={fmtCount(cdr.rtp_audio_in_packet_count)}
          sub="Total RTP packets received from carrier."
        />
      </DetailGroup>

      {/* Group 3: Jitter Analysis */}
      <DetailGroup title="Jitter Analysis" accent="#f59e0b">
        <MetricRow
          label="Average Jitter"
          value={fmtMs(cdr.jitter_avg_ms)}
          color={jitterColor(cdr.jitter_avg_ms)}
          sub="<20 ms = excellent. 20–50 ms = acceptable. >50 ms = poor."
        />
        <MetricRow label="Min Jitter" value={fmtMs(cdr.jitter_min_ms)} />
        <MetricRow
          label="Max Jitter"
          value={fmtMs(cdr.jitter_max_ms)}
          sub="Peak jitter — indicates worst-case moments in the call."
        />
        <MetricRow
          label="Burst Rate"
          value={fmtNum(cdr.rtp_audio_in_jitter_burst_rate, 4)}
          sub="Frequency of jitter spikes. Lower is better."
        />
        <MetricRow
          label="Loss Rate"
          value={fmtNum(cdr.rtp_audio_in_jitter_loss_rate, 4)}
          sub="Rate of jitter-induced packet loss."
        />
      </DetailGroup>

      {/* Group 4: Media Stream Details */}
      <DetailGroup title="Media Stream" accent="#a78bfa">
        <MetricRow
          label="Inbound Audio (raw)"
          value={fmtBytesOrNa(cdr.rtp_audio_in_raw_bytes)}
          sub="Total bytes received from carrier."
        />
        <MetricRow label="Inbound Media" value={fmtBytesOrNa(cdr.rtp_audio_in_media_bytes)} />
        <MetricRow
          label="Outbound Audio (raw)"
          value={fmtBytesOrNa(cdr.rtp_audio_out_raw_bytes)}
          sub="Total bytes sent to carrier."
        />
        <MetricRow label="Outbound Media" value={fmtBytesOrNa(cdr.rtp_audio_out_media_bytes)} />
        <MetricRow
          label="Mean Packet Interval"
          value={fmtMs(cdr.rtp_audio_in_mean_interval)}
          sub="Avg time between packets. ~20 ms is ideal for G.711."
        />
        <MetricRow label="Read Codec" value={fmtStr(cdr.read_codec)} sub="Incoming audio codec (e.g., PCMU, PCMA)." />
        <MetricRow label="Write Codec" value={fmtStr(cdr.write_codec)} sub="Outgoing audio codec." />
      </DetailGroup>

      {/* Group 5: Call Details */}
      <DetailGroup title="Call Details" accent="#64748b">
        <MetricRow
          label="Hangup Cause"
          value={fmtStr(cdr.hangup_cause)}
          sub="NORMAL_CLEARING = clean hangup by either party."
        />
        <MetricRow
          label="SIP Response Code"
          value={cdr.sip_code != null ? String(cdr.sip_code) : na}
          sub="200 = success. 486 = busy. 404 = not found."
        />
        <MetricRow
          label="Carrier Used"
          value={fmtStr(cdr.carrier_used)}
          sub="Termination trunk that handled this call."
        />
      </DetailGroup>
    </div>
  );
}

/** A single row in the per-call quality table. */
function CallQualityTableRow({
  cdr,
  isExpanded,
  onToggle,
}: {
  cdr: Cdr;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const mc = mosColor(cdr.mos);
  const qc = qualityPctColor(cdr.quality_pct);

  return (
    <>
      {/* Main row */}
      <tr
        onClick={onToggle}
        style={{
          cursor: 'pointer',
          background: isExpanded ? 'rgba(59,130,246,0.07)' : 'transparent',
          transition: 'background 0.15s',
          borderBottom: isExpanded ? 'none' : '1px solid rgba(255,255,255,0.04)',
        }}
        onMouseEnter={(e) => {
          if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.03)';
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLTableRowElement).style.background = isExpanded ? 'rgba(59,130,246,0.07)' : 'transparent';
        }}
      >
        {/* Time */}
        <td style={{ padding: '10px 12px', fontSize: '0.78rem', color: '#64748b', whiteSpace: 'nowrap' }}>
          {relativeTime(cdr.start_time)}
        </td>
        {/* DID */}
        <td style={{ padding: '10px 12px', fontSize: '0.80rem', color: '#94a3b8', whiteSpace: 'nowrap' }}>
          {fmt(cdr.destination)}
        </td>
        {/* Duration */}
        <td style={{ padding: '10px 12px', fontSize: '0.80rem', color: '#94a3b8', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {fmtMmSs(cdr.duration_seconds)}
        </td>
        {/* MOS */}
        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
          {cdr.mos != null ? (
            <span
              style={{
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: 6,
                fontSize: '0.78rem',
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                background: `${mc}18`,
                color: mc,
                border: `1px solid ${mc}33`,
              }}
            >
              {cdr.mos.toFixed(2)}
            </span>
          ) : (
            <span style={{ fontSize: '0.78rem', color: '#334155' }}>—</span>
          )}
        </td>
        {/* Quality % */}
        <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
          {cdr.quality_pct != null ? (
            <span
              style={{
                display: 'inline-block',
                padding: '2px 8px',
                borderRadius: 6,
                fontSize: '0.78rem',
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                background: `${qc}18`,
                color: qc,
                border: `1px solid ${qc}33`,
              }}
            >
              {cdr.quality_pct.toFixed(2)}%
            </span>
          ) : (
            <span style={{ fontSize: '0.78rem', color: '#334155' }}>—</span>
          )}
        </td>
        {/* Expand arrow */}
        <td style={{ padding: '10px 12px', textAlign: 'right', width: 36 }}>
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="#475569"
            strokeWidth={2}
            strokeLinecap="round"
            style={{
              width: 14,
              height: 14,
              transform: isExpanded ? 'rotate(180deg)' : 'rotate(0deg)',
              transition: 'transform 0.2s',
              display: 'inline-block',
            }}
          >
            <path d="M3 6l5 5 5-5" />
          </svg>
        </td>
      </tr>

      {/* Expanded detail row */}
      {isExpanded && (
        <tr>
          <td
            colSpan={6}
            style={{
              padding: '0 12px 16px',
              background: 'rgba(59,130,246,0.04)',
              borderBottom: '1px solid rgba(59,130,246,0.12)',
            }}
          >
            <CdrDetailPanel cdr={cdr} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── QualityTab ───────────────────────────────────────────────────────────────

interface QualityTabProps {
  customerId: number | undefined;
}

/** Compute aggregate quality stats from a list of CDRs. */
function computeQualityStats(cdrs: Cdr[]) {
  let answered = 0;
  let mosSum = 0;
  let mosCount = 0;
  let durSum = 0;
  let durCount = 0;

  for (const cdr of cdrs) {
    if (cdr.answer_time != null && cdr.duration_seconds > 0) {
      answered++;
      durSum += cdr.duration_seconds;
      durCount++;
    }
    if (cdr.mos != null) {
      mosSum += cdr.mos;
      mosCount++;
    }
  }

  const total = cdrs.length;
  const successRate = total > 0 ? (answered / total) * 100 : null;
  const avgMos = mosCount > 0 ? mosSum / mosCount : null;
  const avgDurSec = durCount > 0 ? durSum / durCount : null;

  return { total, answered, successRate, avgMos, avgDurSec };
}

/** Build daily quality summary for the last 7 days. */
function buildDailyDots(cdrs: Cdr[]): { date: string; label: string; color: string; tooltip: string }[] {
  const byDate = new Map<string, { mosSum: number; mosCount: number; total: number; answered: number }>();

  for (const cdr of cdrs) {
    const key = cdr.start_time.slice(0, 10);
    const bucket = byDate.get(key) ?? { mosSum: 0, mosCount: 0, total: 0, answered: 0 };
    bucket.total++;
    if (cdr.answer_time != null && cdr.duration_seconds > 0) bucket.answered++;
    if (cdr.mos != null) { bucket.mosSum += cdr.mos; bucket.mosCount++; }
    byDate.set(key, bucket);
  }

  const result: { date: string; label: string; color: string; tooltip: string }[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const b = byDate.get(key);

    if (!b || b.total === 0) {
      result.push({ date: key, label, color: '#1e293b', tooltip: `${label}: No calls` });
      continue;
    }

    const asr = (b.answered / b.total) * 100;
    const avgMos = b.mosCount > 0 ? b.mosSum / b.mosCount : null;

    let color = '#22c55e'; // green by default
    if (asr < 85 || (avgMos != null && avgMos < 3)) color = '#ef4444';
    else if (asr < 95 || (avgMos != null && avgMos < 4)) color = '#f59e0b';

    const mosStr = avgMos != null ? `, MOS ${avgMos.toFixed(1)}` : '';
    result.push({
      date: key,
      label,
      color,
      tooltip: `${label}: ${b.total} calls, ${asr.toFixed(0)}% success${mosStr}`,
    });
  }
  return result;
}

interface BigMetricCardProps {
  label: string;
  sublabel: string;
  value: string;
  valueColor: string;
  accent: string;
  children?: React.ReactNode;
  delay?: number;
}

function BigMetricCard({ label, sublabel, value, valueColor, accent, children, delay = 0 }: BigMetricCardProps) {
  return (
    <div
      style={{
        flex: '1 1 220px',
        minWidth: 0,
        background: 'linear-gradient(145deg, rgba(26,29,39,0.95) 0%, rgba(19,21,29,0.98) 100%)',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        border: `1px solid ${accent}22`,
        borderRadius: 18,
        padding: '24px 24px 20px',
        position: 'relative',
        overflow: 'hidden',
        boxShadow: `0 8px 32px -8px rgba(0,0,0,0.55), 0 0 0 1px ${accent}0a`,
        animation: 'fadeInUp 0.4s ease both',
        animationDelay: `${delay}ms`,
      }}
    >
      {/* Accent glow in corner */}
      <div
        style={{
          position: 'absolute',
          top: -40,
          right: -40,
          width: 130,
          height: 130,
          borderRadius: '50%',
          background: `radial-gradient(circle, ${accent}18 0%, transparent 70%)`,
          pointerEvents: 'none',
        }}
      />
      {/* Top accent line */}
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 32,
          right: 32,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${accent}60, transparent)`,
          borderRadius: '0 0 2px 2px',
        }}
      />

      <div style={{ fontSize: '0.6rem', fontWeight: 700, color: accent, textTransform: 'uppercase', letterSpacing: '0.12em', opacity: 0.8, marginBottom: 10 }}>
        {label}
      </div>

      <div
        style={{
          fontSize: 'clamp(2rem, 4vw, 2.8rem)',
          fontWeight: 900,
          color: valueColor,
          letterSpacing: '-0.04em',
          lineHeight: 1,
          marginBottom: 6,
          fontVariantNumeric: 'tabular-nums',
          textShadow: `0 0 32px ${valueColor}55`,
        }}
      >
        {value}
      </div>

      {children && <div style={{ marginBottom: 8 }}>{children}</div>}

      <div style={{ fontSize: '0.75rem', color: '#64748b', lineHeight: 1.5, marginTop: 4 }}>
        {sublabel}
      </div>
    </div>
  );
}

/** Horizontal bar showing a percentage, e.g. for call success rate. */
function PercentBar({ pct, color }: { pct: number; color: string }) {
  return (
    <div
      style={{
        height: 6,
        background: 'rgba(255,255,255,0.06)',
        borderRadius: 4,
        overflow: 'hidden',
        marginTop: 8,
        marginBottom: 2,
      }}
    >
      <div
        style={{
          height: '100%',
          width: `${Math.min(pct, 100)}%`,
          background: `linear-gradient(90deg, ${color}aa, ${color})`,
          borderRadius: 4,
          transition: 'width 0.6s ease',
          boxShadow: `0 0 8px ${color}66`,
        }}
      />
    </div>
  );
}

/** Simple 5-star MOS rating display. */
function MosStars({ mos }: { mos: number }) {
  const filled = Math.round(mos); // MOS 1-5 maps naturally to 1-5 filled stars
  return (
    <div style={{ display: 'flex', gap: 3, marginTop: 8, marginBottom: 2 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <svg
          key={i}
          viewBox="0 0 16 16"
          fill={i <= filled ? '#f59e0b' : 'none'}
          stroke={i <= filled ? '#f59e0b' : '#1e293b'}
          strokeWidth={1.5}
          style={{ width: 14, height: 14 }}
        >
          <path d="M8 1.5l1.8 3.6 4 .6-2.9 2.8.7 3.9L8 10.5l-3.6 1.9.7-3.9L2.2 5.7l4-.6z" />
        </svg>
      ))}
    </div>
  );
}

function QualityTab({ customerId }: QualityTabProps) {
  const { data: summaryData, isLoading: summaryLoading } = useQuery({
    queryKey: ['rcf-summary', customerId],
    queryFn: () => getCdrSummary({ customer_id: customerId }),
    staleTime: 120_000,
  });

  const { data: cdrData, isLoading: cdrLoading } = useQuery({
    queryKey: ['rcf-quality-cdrs', customerId],
    queryFn: () =>
      searchCdrs({
        customer_id: customerId,
        product_type: 'rcf',
        limit: 500,
        sort_by: 'start_time',
        sort_dir: 'desc',
      }),
    staleTime: 120_000,
  });

  // Expanded row state — tracks which CDR uuid is expanded (null = none)
  const [expandedRowUuid, setExpandedRowUuid] = useState<string | null>(null);

  const isLoading = summaryLoading || cdrLoading;
  const cdrs = cdrData?.items ?? [];
  const stats = useMemo(() => computeQualityStats(cdrs), [cdrs]);
  const dailyDots = useMemo(() => buildDailyDots(cdrs), [cdrs]);

  // Only show CDRs that have at least some quality data in the table
  const qualityCdrs = useMemo(
    () => cdrs.filter((c) => c.mos != null || c.quality_pct != null || c.packet_loss_pct != null),
    [cdrs],
  );

  // Aggregate total calls from summary rows
  const summaryRows = summaryData?.summary ?? [];
  const totalCallsFromSummary = summaryRows.reduce((acc, r) => acc + r.total_calls, 0);
  const totalCalls = totalCallsFromSummary > 0 ? totalCallsFromSummary : stats.total;

  // Toggle expanded row — only one open at a time
  const handleToggleRow = useCallback((uuid: string) => {
    setExpandedRowUuid((prev) => (prev === uuid ? null : uuid));
  }, []);

  if (isLoading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', padding: '64px 0', color: '#64748b' }}>
        <Spinner size="sm" />
        <span style={{ fontSize: '0.875rem' }}>Loading quality data…</span>
      </div>
    );
  }

  if (cdrs.length === 0 && totalCalls === 0) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '80px 24px',
          gap: 18,
          textAlign: 'center',
          background: 'rgba(19,21,29,0.65)',
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
            boxShadow: '0 0 24px rgba(59,130,246,0.12)',
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth={1.4} style={{ width: 38, height: 38, opacity: 0.65 }}>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 8v4l3 3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <div>
          <p style={{ color: '#94a3b8', fontSize: '1rem', fontWeight: 600, margin: '0 0 8px' }}>
            No calls yet
          </p>
          <p style={{ color: '#475569', fontSize: '0.84rem', margin: 0, lineHeight: 1.65, maxWidth: 420 }}>
            Once calls start flowing, your quality dashboard will light up here with real-time health metrics.
          </p>
        </div>
      </div>
    );
  }

  // Determine colour thresholds
  const successRate = stats.successRate;
  const successColor =
    successRate == null ? '#4a5568'
    : successRate >= 95 ? '#22c55e'
    : successRate >= 85 ? '#f59e0b'
    : '#ef4444';

  const avgMos = stats.avgMos;
  const mosColor =
    avgMos == null ? '#4a5568'
    : avgMos >= 4.0 ? '#22c55e'
    : avgMos >= 3.0 ? '#f59e0b'
    : '#ef4444';

  const mosQualWord =
    avgMos == null ? '—'
    : avgMos >= 4.0 ? 'Excellent'
    : avgMos >= 3.5 ? 'Good'
    : avgMos >= 3.0 ? 'Fair'
    : 'Poor';

  const avgDurStr = stats.avgDurSec != null ? fmtDuration(Math.round(stats.avgDurSec)) : '—';

  // 7-day trend summary
  const dotsWithData = dailyDots.filter((d) => d.color !== '#1e293b');
  const hasProblems = dotsWithData.some((d) => d.color === '#ef4444');
  const hasWarnings = dotsWithData.some((d) => d.color === '#f59e0b');
  const trendSummary =
    dotsWithData.length === 0 ? 'No data for last 7 days'
    : hasProblems ? 'Some days had call quality issues — check the dots below'
    : hasWarnings ? 'Most days were good with minor variations'
    : 'All excellent — everything is running smoothly';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* ── Big metric cards ────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>

        {/* Card 1: Call Success Rate */}
        <BigMetricCard
          label="Call Success Rate"
          sublabel="of calls connected successfully"
          value={successRate != null ? `${successRate.toFixed(1)}%` : '—'}
          valueColor={successColor}
          accent={successColor}
          delay={0}
        >
          {successRate != null && (
            <PercentBar pct={successRate} color={successColor} />
          )}
        </BigMetricCard>

        {/* Card 2: Voice Quality */}
        <BigMetricCard
          label="Voice Clarity (MOS)"
          sublabel={`Average voice quality — ${mosQualWord} on the 1–5 scale`}
          value={avgMos != null ? avgMos.toFixed(1) : '—'}
          valueColor={mosColor}
          accent={mosColor}
          delay={80}
        >
          {avgMos != null && <MosStars mos={avgMos} />}
        </BigMetricCard>

        {/* Card 3: Total Calls */}
        <BigMetricCard
          label="Total Calls"
          sublabel="calls tracked in this period"
          value={totalCalls.toLocaleString()}
          valueColor="#60a5fa"
          accent="#3b82f6"
          delay={160}
        />

        {/* Card 4: Avg Duration */}
        <BigMetricCard
          label="Avg Call Length"
          sublabel="average time per connected call"
          value={avgDurStr}
          valueColor="#a78bfa"
          accent="#7c3aed"
          delay={240}
        />
      </div>

      {/* ── Plain-English explainer ────────────────────────── */}
      <div
        style={{
          background: 'rgba(59,130,246,0.04)',
          border: '1px solid rgba(59,130,246,0.10)',
          borderRadius: 14,
          padding: '18px 22px',
          display: 'flex',
          gap: 28,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#3b82f6', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>
            What is Voice Clarity?
          </div>
          <p style={{ fontSize: '0.81rem', color: '#94a3b8', margin: 0, lineHeight: 1.65 }}>
            A score from 1–5 measuring how natural voices sound on your calls.{' '}
            <strong style={{ color: '#22c55e' }}>4+ is excellent</strong> — like talking in the same room.{' '}
            Below 3 means callers may notice choppy or muffled audio.
          </p>
        </div>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <div style={{ fontSize: '0.68rem', fontWeight: 700, color: '#3b82f6', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 5 }}>
            What is Call Success Rate?
          </div>
          <p style={{ fontSize: '0.81rem', color: '#94a3b8', margin: 0, lineHeight: 1.65 }}>
            The percentage of calls that connected and were answered.{' '}
            <strong style={{ color: '#22c55e' }}>95%+ means your system is running great.</strong>{' '}
            A lower number could indicate routing issues worth investigating.
          </p>
        </div>
      </div>

      {/* ── 7-day quality trend ────────────────────────────── */}
      <div
        style={{
          background: 'rgba(19,21,29,0.68)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          border: '1px solid rgba(59,130,246,0.10)',
          borderRadius: 14,
          padding: '20px 22px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
          <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
            Last 7 Days
          </span>
          <span style={{ fontSize: '0.79rem', color: '#64748b', flex: 1 }}>
            {trendSummary}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          {dailyDots.map((d) => (
            <div
              key={d.date}
              title={d.tooltip}
              style={{
                flex: '1 1 0',
                minWidth: 32,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 6,
                cursor: 'default',
              }}
            >
              <div
                style={{
                  width: '100%',
                  height: 28,
                  borderRadius: 6,
                  background: d.color === '#1e293b'
                    ? 'rgba(30,41,59,0.4)'
                    : d.color,
                  boxShadow: d.color !== '#1e293b' ? `0 0 12px ${d.color}55` : 'none',
                  opacity: d.color === '#1e293b' ? 0.4 : 0.85,
                  transition: 'opacity 0.2s',
                  border: `1px solid ${d.color}33`,
                }}
              />
              <span style={{ fontSize: '0.55rem', color: '#334155', textAlign: 'center', letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
                {new Date(d.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' })}
              </span>
            </div>
          ))}
        </div>

        {/* Legend */}
        <div style={{ display: 'flex', gap: 16, marginTop: 14, flexWrap: 'wrap' }}>
          {[
            { color: '#22c55e', label: 'Excellent' },
            { color: '#f59e0b', label: 'Attention' },
            { color: '#ef4444', label: 'Issue' },
            { color: '#1e293b', label: 'No calls' },
          ].map((l) => (
            <div key={l.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <div style={{ width: 8, height: 8, borderRadius: 2, background: l.color, opacity: l.color === '#1e293b' ? 0.4 : 0.85 }} />
              <span style={{ fontSize: '0.68rem', color: '#475569' }}>{l.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Detailed Call Quality Metrics table ────────────────── */}
      <div
        style={{
          background: 'rgba(19,21,29,0.72)',
          backdropFilter: 'blur(10px)',
          WebkitBackdropFilter: 'blur(10px)',
          border: '1px solid rgba(59,130,246,0.10)',
          borderRadius: 16,
          overflow: 'hidden',
        }}
      >
        {/* Section header */}
        <div
          style={{
            padding: '16px 20px',
            borderBottom: '1px solid rgba(59,130,246,0.10)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div>
            <div
              style={{
                fontSize: '0.68rem',
                fontWeight: 700,
                color: '#3b82f6',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
                marginBottom: 3,
              }}
            >
              Detailed Call Quality Metrics
            </div>
            <div style={{ fontSize: '0.78rem', color: '#64748b' }}>
              Recent calls with quality data — click any row to expand full metrics
            </div>
          </div>
          {qualityCdrs.length > 0 && (
            <span
              style={{
                marginLeft: 'auto',
                fontSize: '0.72rem',
                color: '#475569',
                background: 'rgba(59,130,246,0.08)',
                border: '1px solid rgba(59,130,246,0.15)',
                borderRadius: 6,
                padding: '3px 10px',
              }}
            >
              {qualityCdrs.length} call{qualityCdrs.length !== 1 ? 's' : ''}
            </span>
          )}
        </div>

        {qualityCdrs.length === 0 ? (
          <div
            style={{
              padding: '40px 24px',
              textAlign: 'center',
              color: '#475569',
              fontSize: '0.82rem',
            }}
          >
            No calls with quality metrics found in the current window.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '0.82rem',
              }}
            >
              {/* Table header */}
              <thead>
                <tr
                  style={{
                    background: 'rgba(59,130,246,0.08)',
                    borderBottom: '1px solid rgba(59,130,246,0.15)',
                  }}
                >
                  {(['Time', 'DID', 'Duration', 'MOS', 'Quality', ''] as const).map((h) => (
                    <th
                      key={h}
                      style={{
                        padding: '10px 12px',
                        textAlign: h === '' ? 'right' : 'left',
                        fontSize: '0.65rem',
                        fontWeight: 700,
                        color: '#3b82f6',
                        textTransform: 'uppercase',
                        letterSpacing: '0.10em',
                        whiteSpace: 'nowrap',
                        userSelect: 'none',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {qualityCdrs.slice(0, 50).map((cdr) => (
                  <CallQualityTableRow
                    key={cdr.uuid}
                    cdr={cdr}
                    isExpanded={expandedRowUuid === cdr.uuid}
                    onToggle={() => handleToggleRow(cdr.uuid)}
                  />
                ))}
              </tbody>
            </table>

            {qualityCdrs.length > 50 && (
              <div
                style={{
                  padding: '12px 20px',
                  fontSize: '0.75rem',
                  color: '#475569',
                  borderTop: '1px solid rgba(255,255,255,0.04)',
                  textAlign: 'center',
                }}
              >
                Showing the 50 most recent calls with quality data. Older records are available in the CDR export.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── DIDManagementTab ─────────────────────────────────────────────────────────

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
          fontWeight: 700,
          color: '#475569',
          textTransform: 'uppercase',
          letterSpacing: '0.1em',
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

function DidTh({ children }: { children: React.ReactNode }) {
  return (
    <th
      style={{
        padding: '11px 16px',
        textAlign: 'left',
        fontSize: '0.6rem',
        fontWeight: 700,
        color: '#475569',
        textTransform: 'uppercase',
        letterSpacing: '0.11em',
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
          <span style={{ fontFamily: 'monospace', color: '#60a5fa', fontWeight: 600 }}>
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

// ── My Numbers section ────────────────────────────────────────────────────────

function MyNumbersSection({ items, isLoading, isError }: {
  items: DidInventoryItem[];
  isLoading: boolean;
  isError: boolean;
}) {
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
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
            <thead>
              <tr>
                <DidTh>DID</DidTh>
                <DidTh>City</DidTh>
                <DidTh>State</DidTh>
                <DidTh>Product</DidTh>
                <DidTh>Status</DidTh>
                <DidTh>Assigned</DidTh>
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
                  <td style={{ padding: '13px 16px' }}>
                    <div>
                      <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#e2e8f0', fontFamily: 'monospace', letterSpacing: '0.02em' }}>
                        {fmt(item.did)}
                      </div>
                      <div style={{ fontSize: '0.63rem', color: '#334155', fontFamily: 'monospace', marginTop: 2, letterSpacing: '0.01em' }}>
                        {item.did}
                      </div>
                    </div>
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
                        fontWeight: 700,
                        color: '#60a5fa',
                        background: 'rgba(59,130,246,0.10)',
                        border: '1px solid rgba(59,130,246,0.22)',
                        borderRadius: 5,
                        padding: '3px 8px',
                        textTransform: 'uppercase',
                        letterSpacing: '0.08em',
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
                  <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#e2e8f0', fontFamily: 'monospace', letterSpacing: '0.02em' }}>
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
  const [search, setSearch] = useState('');
  const [searchFocused, setSearchFocused] = useState(false);

  const filtered = useMemo(() => {
    if (!search.trim()) return items;
    const q = search.trim().toLowerCase();
    return items.filter(
      (item) =>
        item.did.includes(q) ||
        (item.city ?? '').toLowerCase().includes(q) ||
        (item.state ?? '').toLowerCase().includes(q) ||
        (item.rate_center ?? '').toLowerCase().includes(q),
    );
  }, [items, search]);

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
        right={
          /* search bar in header right slot */
          <div style={{ position: 'relative', width: 280 }}>
            <span
              style={{
                position: 'absolute',
                left: 11,
                top: '50%',
                transform: 'translateY(-50%)',
                color: searchFocused ? '#3b82f6' : '#475569',
                display: 'flex',
                alignItems: 'center',
                pointerEvents: 'none',
                transition: 'color 0.2s',
              }}
            >
              <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 13, height: 13 }}>
                <path d="m19 19-4.35-4.35M15 9A6 6 0 1 1 3 9a6 6 0 0 1 12 0Z" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by area code, city, state…"
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setSearchFocused(false)}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                padding: '7px 10px 7px 28px',
                fontSize: '0.78rem',
                background: searchFocused ? 'rgba(15,17,23,0.9)' : 'rgba(15,17,23,0.55)',
                border: `1px solid ${searchFocused ? 'rgba(59,130,246,0.40)' : 'rgba(59,130,246,0.14)'}`,
                borderRadius: 9,
                color: '#e2e8f0',
                outline: 'none',
                fontFamily: 'inherit',
                transition: 'border-color 0.2s, box-shadow 0.2s, background 0.2s',
                boxShadow: searchFocused ? '0 0 0 3px rgba(59,130,246,0.12)' : 'none',
              }}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                style={{
                  position: 'absolute',
                  right: 8,
                  top: '50%',
                  transform: 'translateY(-50%)',
                  background: 'transparent',
                  border: 'none',
                  color: '#475569',
                  cursor: 'pointer',
                  padding: '2px 3px',
                  display: 'flex',
                  alignItems: 'center',
                }}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 10, height: 10 }}>
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                </svg>
              </button>
            )}
          </div>
        }
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
      ) : filtered.length === 0 ? (
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
            No numbers match &ldquo;{search}&rdquo;
          </p>
          <button
            type="button"
            onClick={() => setSearch('')}
            style={{ background: 'transparent', border: 'none', color: '#3b82f6', fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit', padding: 0 }}
          >
            Clear filter
          </button>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 560 }}>
            <thead>
              <tr>
                <DidTh>DID</DidTh>
                <DidTh>City</DidTh>
                <DidTh>State</DidTh>
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
                        <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#e2e8f0', fontFamily: 'monospace', letterSpacing: '0.02em' }}>
                          {fmt(item.did)}
                        </div>
                        <div style={{ fontSize: '0.63rem', color: '#334155', fontFamily: 'monospace', marginTop: 2 }}>
                          {item.did}
                        </div>
                      </div>
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
    </DidCard>
  );
}

// ── DIDManagementTab (root) ───────────────────────────────────────────────────

interface DIDManagementTabProps {
  customerId: number | undefined;
}

function DIDManagementTab({ customerId }: DIDManagementTabProps) {
  // ALL hooks unconditionally at top — React rules-of-hooks
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();

  // Modal state — null = closed, DidInventoryItem = confirm dialog open
  const [confirmTarget, setConfirmTarget] = useState<DidInventoryItem | null>(null);

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
    queryFn: () => listAvailableDids({ limit: 100 }),
    staleTime: 30_000,
  });

  const requestMutation = useMutation({
    mutationFn: (did: string) => requestDid(did),
    onSuccess: (_data, did) => {
      void queryClient.invalidateQueries({ queryKey: ['my-dids'] });
      void queryClient.invalidateQueries({ queryKey: ['available-dids'] });
      setConfirmTarget(null);
      toastOk(`Number requested — ${fmt(did)} is pending admin approval`);
    },
    onError: (err: Error) => {
      setConfirmTarget(null);
      toastErr(err.message ?? 'Failed to request number');
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
    setConfirmTarget(item);
  }

  function handleConfirmRequest(item: DidInventoryItem) {
    requestMutation.mutate(item.did);
  }

  return (
    <>
      {/* Confirmation modal — rendered at top level so it sits over everything */}
      {confirmTarget && (
        <RequestModal
          did={confirmTarget}
          onConfirm={handleConfirmRequest}
          onCancel={() => setConfirmTarget(null)}
          isPending={requestMutation.isPending}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        {/* Section 1: My Numbers (assigned) */}
        <MyNumbersSection
          items={assignedItems}
          isLoading={myLoading}
          isError={myError}
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
    if (!searchQuery) return rawEntries;
    const q = searchQuery.toLowerCase();
    return rawEntries.filter(
      (e) =>
        e.did.includes(q) ||
        e.forward_to.toLowerCase().includes(q) ||
        (e.name ?? '').toLowerCase().includes(q) ||
        (e.customer_name ?? '').toLowerCase().includes(q),
    );
  }, [rawEntries, searchQuery]);

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
    <div style={{ paddingTop: 4 }}>
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
                  {searchQuery && filteredEntries.length !== rawEntries.length
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
                    <th style={{ padding: '10px 16px', textAlign: 'left', fontSize: '0.6rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.1em', whiteSpace: 'nowrap', background: 'rgba(59,130,246,0.04)' }}>Caller ID</th>
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

      {/* ── Quality Tab ──────────────────────────────────────── */}
      {activeTab === 'quality' && (
        <QualityTab customerId={customerId} />
      )}

      {/* ── DID Management Tab ───────────────────────────────── */}
      {activeTab === 'dids' && (
        <DIDManagementTab customerId={customerId} />
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
