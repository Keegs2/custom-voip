/**
 * NumbersTable — the dense table view of RCF lines inside a frosted glass panel.
 * Sortable headers, an inline forward_to editor, and live enable / caller-id
 * toggles per row. All server state comes from the hooks in `../../hooks`.
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { fmt } from '../../../../utils/format';
import type { RcfEntry } from '../../../../types/rcf';
import type { SortField, SortDir } from '../../types';
import { useEnableToggle, useCallerIdToggle, useForwardToEditor } from '../../hooks';
import { BLUE, BLUE_LIGHT, MONO, numbersTh, toggleTrack, toggleKnob } from '../../styles';
import { PaginationControls } from './PaginationControls';

// ── EnableToggle ─────────────────────────────────────────────────────────────

function EnableToggle({ entry, canEdit }: { entry: RcfEntry; canEdit: boolean }) {
  const { enabled, isPending, toggle } = useEnableToggle(entry);
  return (
    <button
      type="button"
      role="switch"
      aria-checked={enabled}
      disabled={!canEdit || isPending}
      onClick={() => { if (canEdit && !isPending) toggle(); }}
      title={canEdit ? (enabled ? 'Click to disable' : 'Click to enable') : undefined}
      style={{ ...toggleTrack(enabled, isPending), cursor: canEdit && !isPending ? 'pointer' : 'not-allowed' }}
    >
      <span style={toggleKnob(enabled)} />
    </button>
  );
}

// ── CallerIdToggle ───────────────────────────────────────────────────────────

function CallerIdToggle({ entry, canEdit }: { entry: RcfEntry; canEdit: boolean }) {
  const { passthrough, isPending, toggle } = useCallerIdToggle(entry);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <button
        type="button"
        role="switch"
        aria-checked={passthrough}
        disabled={!canEdit || isPending}
        onClick={() => { if (canEdit && !isPending) toggle(); }}
        title={canEdit ? (passthrough ? 'Showing original caller ID — click to show your DID instead' : 'Showing your DID — click to pass through original caller ID') : 'Caller ID setting'}
        style={{ ...toggleTrack(passthrough, isPending), cursor: canEdit ? 'pointer' : 'not-allowed' }}
      >
        <span style={toggleKnob(passthrough)} />
      </button>
      <span style={{ fontSize: '0.72rem', color: passthrough ? BLUE_LIGHT : GLASS.textFaint, fontWeight: 500, whiteSpace: 'nowrap' }}>
        {passthrough ? 'Pass-through' : 'Show DID'}
      </span>
    </div>
  );
}

// ── SortHeader ───────────────────────────────────────────────────────────────

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
    <th onClick={() => onSort(field)} style={{ ...numbersTh, color: isActive ? BLUE_LIGHT : GLASS.textFaint, cursor: 'pointer', userSelect: 'none', transition: 'color 0.15s' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        {label}
        {isActive ? (
          <span style={{ color: BLUE, fontSize: '0.75rem', lineHeight: 1 }}>{currentDir === 'asc' ? '↑' : '↓'}</span>
        ) : (
          <span style={{ color: '#334155', fontSize: '0.75rem', lineHeight: 1 }}>↕</span>
        )}
      </span>
    </th>
  );
}

// ── ForwardToCell ────────────────────────────────────────────────────────────

interface ForwardToCellProps {
  entry: RcfEntry;
  canEdit: boolean;
  pendingValue: string;
  onPendingChange: (did: string, value: string) => void;
}

function ForwardToCell({ entry, canEdit, pendingValue, onPendingChange }: ForwardToCellProps) {
  const ed = useForwardToEditor(entry, canEdit, pendingValue, onPendingChange);

  if (ed.editing && canEdit) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="tel"
          value={pendingValue}
          autoFocus
          placeholder="+1XXXXXXXXXX"
          disabled={ed.isPending}
          onChange={(e) => onPendingChange(entry.did, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); ed.save(); }
            if (e.key === 'Escape') ed.cancel();
          }}
          style={{
            width: 150,
            fontSize: '0.82rem',
            padding: '5px 9px',
            borderRadius: 7,
            border: `1px solid ${ed.isDirty ? BLUE : 'rgba(59,130,246,0.25)'}`,
            background: 'rgba(15,17,23,0.85)',
            color: GLASS.text,
            fontFamily: MONO,
            outline: 'none',
            boxShadow: ed.isDirty ? '0 0 0 3px rgba(59,130,246,0.18)' : '0 0 0 2px rgba(59,130,246,0.1)',
            opacity: ed.isPending ? 0.5 : 1,
            transition: 'border-color 0.15s, box-shadow 0.15s',
          }}
        />
        <button
          type="button"
          disabled={!ed.isDirty || ed.isPending}
          onMouseDown={(e) => { e.preventDefault(); ed.save(); }}
          style={{
            fontSize: '0.65rem',
            fontWeight: 700,
            padding: '5px 11px',
            borderRadius: 5,
            border: 'none',
            background: ed.isDirty && !ed.isPending ? 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' : 'rgba(59,130,246,0.25)',
            color: '#fff',
            cursor: ed.isDirty && !ed.isPending ? 'pointer' : 'not-allowed',
            flexShrink: 0,
            lineHeight: 1,
            letterSpacing: '0.02em',
            transition: 'background 0.15s',
          }}
        >
          {ed.isPending ? '…' : 'Save'}
        </button>
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); ed.cancel(); }}
          style={{ fontSize: '0.65rem', fontWeight: 500, padding: '5px 9px', borderRadius: 5, border: 'none', background: 'transparent', color: '#64748b', cursor: 'pointer', flexShrink: 0, lineHeight: 1 }}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: canEdit ? 'pointer' : 'default' }}
      onMouseEnter={() => { if (canEdit) ed.setHovered(true); }}
      onMouseLeave={() => ed.setHovered(false)}
      onClick={ed.beginEdit}
      title={canEdit ? 'Click to edit destination' : undefined}
    >
      <span
        style={{
          fontSize: '0.84rem',
          color: ed.savedFlash ? BLUE_LIGHT : BLUE,
          fontFamily: MONO,
          fontWeight: 600,
          letterSpacing: '0.01em',
          borderBottom: canEdit ? `1px dashed rgba(59,130,246,${ed.hovered ? '0.6' : '0.28'})` : 'none',
          paddingBottom: canEdit ? 1 : 0,
          transition: 'color 0.25s, border-color 0.2s',
        }}
      >
        {fmt(entry.forward_to)}
      </span>
      {canEdit && (
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" style={{ width: 12, height: 12, color: BLUE, opacity: ed.hovered ? 0.7 : 0, transition: 'opacity 0.2s', flexShrink: 0 }}>
          <path d="M11.5 2.5a1.414 1.414 0 0 1 2 2L5 13H2v-3L11.5 2.5z" />
        </svg>
      )}
    </div>
  );
}

// ── TableRow ─────────────────────────────────────────────────────────────────

interface TableRowProps {
  entry: RcfEntry;
  isAdmin: boolean;
  canEdit: boolean;
  pendingValue: string;
  onPendingChange: (did: string, value: string) => void;
  last: boolean;
}

function TableRow({ entry, isAdmin, canEdit, pendingValue, onPendingChange, last }: TableRowProps) {
  return (
    <tr style={{ borderBottom: last ? 'none' : '1px solid rgba(59,130,246,0.06)', transition: 'background 0.18s ease' }}>
      <td style={{ padding: '14px 16px' }}>
        <div style={{ fontSize: '0.9rem', fontWeight: 700, color: GLASS.text, fontFamily: MONO, letterSpacing: '0.02em', lineHeight: 1.2 }}>{fmt(entry.did)}</div>
        <div style={{ fontSize: '0.63rem', color: '#334155', fontFamily: MONO, marginTop: 3, letterSpacing: '0.01em' }}>{entry.did}</div>
      </td>
      <td style={{ padding: '14px 16px' }}>
        <span style={{ fontSize: '0.83rem', color: entry.name ? '#cbd5e0' : '#2d3748', fontStyle: entry.name ? 'normal' : 'italic' }}>{entry.name ?? 'No label'}</span>
      </td>
      <td style={{ padding: '10px 16px' }}>
        <ForwardToCell entry={entry} canEdit={canEdit} pendingValue={pendingValue} onPendingChange={onPendingChange} />
      </td>
      <td style={{ padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
          <EnableToggle entry={entry} canEdit={canEdit} />
          <span style={{ fontSize: '0.72rem', fontWeight: 600, color: entry.enabled ? BLUE_LIGHT : GLASS.textFaint, letterSpacing: '0.04em', textTransform: 'uppercase', transition: 'color 0.2s' }}>
            {entry.enabled ? 'Active' : 'Disabled'}
          </span>
        </div>
      </td>
      <td style={{ padding: '14px 16px' }}>
        <CallerIdToggle entry={entry} canEdit={canEdit} />
      </td>
      {isAdmin && (
        <td style={{ padding: '14px 16px' }}>
          <span style={{ fontSize: '0.78rem', color: '#64748b', background: 'rgba(59,130,246,0.06)', border: '1px solid rgba(59,130,246,0.12)', borderRadius: 6, padding: '2px 8px', whiteSpace: 'nowrap' }}>
            {entry.customer_name ?? `ID ${entry.customer_id}`}
          </span>
        </td>
      )}
    </tr>
  );
}

// ── NumbersTable ─────────────────────────────────────────────────────────────

interface NumbersTableProps {
  entries: RcfEntry[];
  isAdmin: boolean;
  canEdit: boolean;
  sortField: SortField;
  sortDir: SortDir;
  onSort: (field: SortField) => void;
  resolveValue: (entry: RcfEntry) => string;
  onPendingChange: (did: string, value: string) => void;
  showPagination: boolean;
  page: number;
  totalPages: number;
  pageSize: number;
  serverTotal: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export function NumbersTable({
  entries,
  isAdmin,
  canEdit,
  sortField,
  sortDir,
  onSort,
  resolveValue,
  onPendingChange,
  showPagination,
  page,
  totalPages,
  pageSize,
  serverTotal,
  onPageChange,
  onPageSizeChange,
}: NumbersTableProps) {
  return (
    <GlassPanel padding={0} blur={20}>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <SortHeader label="DID" field="did" currentField={sortField} currentDir={sortDir} onSort={onSort} />
              <SortHeader label="Name" field="name" currentField={sortField} currentDir={sortDir} onSort={onSort} />
              <SortHeader label="Forward To" field="forward_to" currentField={sortField} currentDir={sortDir} onSort={onSort} />
              <SortHeader label="Status" field="status" currentField={sortField} currentDir={sortDir} onSort={onSort} />
              <th style={{ ...numbersTh, color: GLASS.textFaint }}>Caller ID</th>
              {isAdmin && <SortHeader label="Customer" field="customer" currentField={sortField} currentDir={sortDir} onSort={onSort} />}
            </tr>
          </thead>
          <tbody>
            {entries.map((entry, i) => (
              <TableRow
                key={entry.id}
                entry={entry}
                isAdmin={isAdmin}
                canEdit={canEdit}
                pendingValue={resolveValue(entry)}
                onPendingChange={onPendingChange}
                last={i === entries.length - 1}
              />
            ))}
          </tbody>
        </table>
      </div>
      {showPagination && (
        <PaginationControls
          currentPage={page}
          totalPages={totalPages}
          pageSize={pageSize}
          totalItems={serverTotal}
          onPageChange={onPageChange}
          onPageSizeChange={onPageSizeChange}
        />
      )}
    </GlassPanel>
  );
}
