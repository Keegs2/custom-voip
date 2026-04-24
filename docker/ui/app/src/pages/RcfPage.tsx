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

// ─── API helpers ──────────────────────────────────────────────────────────────

async function updateRcfForwardTo(did: string, forward_to: string): Promise<RcfEntry> {
  return apiRequest('PUT', `/rcf/${encodeURIComponent(did)}`, { forward_to });
}

async function updateRcfEnabled(id: number, enabled: boolean): Promise<RcfEntry> {
  return apiRequest('PATCH', `/rcf/${id}`, { enabled });
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

// ─── Main Page ────────────────────────────────────────────────────────────────

export function RcfPage() {
  const { user, isAdmin } = useAuth();
  const [adminSelectedCustomer, setAdminSelectedCustomer] = useState<number | undefined>(undefined);

  const customerId = isAdmin ? adminSelectedCustomer : (user?.customer_id ?? undefined);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);

  const [searchInput, setSearchInput] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [sortField, setSortField] = useState<SortField>('did');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [searchFocused, setSearchFocused] = useState(false);

  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({});

  function handleSearchInput(value: string) {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      setSearchQuery(value.trim());
      setPage(1);
    }, 250);
  }

  useEffect(() => {
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, []);

  function handleCustomerSelect(id: number | undefined) {
    setAdminSelectedCustomer(id);
    setPage(1);
    setSearchInput('');
    setSearchQuery('');
  }

  const { data, isLoading, isError } = useQuery({
    queryKey: ['rcf', customerId, page, pageSize],
    queryFn: () => listRcf({ limit: pageSize, offset: (page - 1) * pageSize, customer_id: customerId }),
  });

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

  // For the header: use total from server when no search query
  const headerTotal = serverTotal;

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

  // Decide view: admin always table; customers with ≤10 numbers use cards, else table
  const useCardView = !isAdmin && role !== 'readonly' && serverTotal <= 10;

  const pageTitle = user?.customer_name
    ? `${user.customer_name}'s Numbers`
    : 'Remote Call Forwarding';

  return (
    <div style={{ paddingTop: 4 }}>
      {/* Premium glass-morphism header */}
      <RcfPageHeader
        title={pageTitle}
        subtitle="Manage your Remote Call Forwarding numbers. Changes take effect within seconds — no reboots, no carrier coordination."
        totalNumbers={isLoading ? 0 : headerTotal}
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

      {/* ── Toolbar: Search + count ─────────────────────────── */}
      {!isLoading && !isError && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginBottom: 16,
            flexWrap: 'wrap',
          }}
        >
          {/* Glass-morphism search bar */}
          <div
            style={{
              position: 'relative',
              flex: '1 1 240px',
              minWidth: 200,
            }}
          >
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
                background: searchFocused
                  ? 'rgba(19, 21, 29, 0.85)'
                  : 'rgba(19, 21, 29, 0.65)',
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

      {/* ── Loading ─────────────────────────────────────────── */}
      {isLoading && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            color: '#718096',
            fontSize: '0.875rem',
            padding: '48px 0',
            justifyContent: 'center',
          }}
        >
          <Spinner size="sm" />
          <span>Loading your numbers…</span>
        </div>
      )}

      {/* ── Error ───────────────────────────────────────────── */}
      {isError && (
        <div
          style={{
            padding: '16px 20px',
            borderRadius: 12,
            background: 'rgba(239,68,68,0.08)',
            border: '1px solid rgba(239,68,68,0.22)',
            color: '#f87171',
            fontSize: '0.875rem',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16, flexShrink: 0 }}>
            <circle cx="8" cy="8" r="7" />
            <path d="M8 5v3.5M8 10.5v.5" strokeLinecap="round" />
          </svg>
          Unable to load RCF numbers. Please try refreshing the page.
        </div>
      )}

      {/* ── Empty (no numbers at all) ────────────────────────── */}
      {!isLoading && !isError && rawEntries.length === 0 && <EmptyState />}

      {/* ── Search empty state ───────────────────────────────── */}
      {!isLoading && !isError && rawEntries.length > 0 && sortedEntries.length === 0 && searchQuery && (
        <SearchEmptyState
          query={searchQuery}
          onClear={() => { setSearchInput(''); setSearchQuery(''); }}
        />
      )}

      {/* ── Card View (small customer accounts) ─────────────── */}
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
            <div
              style={{
                marginTop: 20,
                background: 'rgba(19, 21, 29, 0.65)',
                backdropFilter: 'blur(8px)',
                WebkitBackdropFilter: 'blur(8px)',
                border: '1px solid rgba(59,130,246,0.10)',
                borderRadius: 14,
                overflow: 'hidden',
              }}
            >
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

      {/* ── Table View ──────────────────────────────────────── */}
      {!isLoading && !isError && sortedEntries.length > 0 && !useCardView && (
        <div
          style={{
            background: 'rgba(19, 21, 29, 0.68)',
            backdropFilter: 'blur(10px)',
            WebkitBackdropFilter: 'blur(10px)',
            border: '1px solid rgba(59,130,246,0.12)',
            borderRadius: 16,
            overflow: 'hidden',
            boxShadow: '0 8px 32px -8px rgba(0,0,0,0.45)',
          }}
        >
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <SortHeader label="DID"        field="did"        currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                <SortHeader label="Name"       field="name"       currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                <SortHeader label="Forward To" field="forward_to" currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                <SortHeader label="Status"     field="status"     currentField={sortField} currentDir={sortDir} onSort={handleSort} />
                {isAdmin && (
                  <SortHeader label="Customer" field="customer"   currentField={sortField} currentDir={sortDir} onSort={handleSort} />
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
