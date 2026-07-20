/**
 * RatesTable — the sortable, inline-editable rate deck rendered on a single
 * frosted-glass pane. All server state (update/delete) comes from the feature
 * hooks; only transient sort/edit UI state is local.
 */

import { useState, useCallback, useMemo } from 'react';
import { Button } from '../../../../../components/ui/Button';
import { useToast } from '../../../../../components/ui/Toast';
import { GLASS, hexToRgba } from '../../../../../components/glass/glass';
import { cn } from '../../../../../utils/cn';
import type { Rate } from '../../../../../types/rate';
import { GlassTableWrap } from '../../components/GlassTableWrap';
import { EmptyState } from '../../components/states';
import { th, td, MONO } from '../../styles';
import { useRateRowMutations } from '../hooks';
import type { SortKey, EditState } from '../types';

function marginRowTint(rate: Rate): string | undefined {
  const margin = rate.margin_per_min ?? 0;
  const pct = rate.margin_pct ?? 100;
  if (margin < 0 || pct < 0) return hexToRgba(GLASS.danger, 0.06);
  if (pct < 30) return hexToRgba(GLASS.warning, 0.05);
  return undefined;
}

function marginPctClass(pct: number | null | undefined): string {
  if (pct == null) return 'text-[#94a3b8]';
  if (pct < 0) return 'text-red-400 font-bold';
  if (pct < 15) return 'text-red-400';
  if (pct < 30) return 'text-amber-400';
  return 'text-green-400';
}

function marginValueClass(val: number | null | undefined): string {
  if (val == null) return 'text-[#94a3b8]';
  return val < 0 ? 'text-red-400' : 'text-green-400';
}

function fmtRate4(val: number | null | undefined): string {
  if (val == null) return '--';
  return `$${Number(val).toFixed(4)}`;
}

interface SortableThProps {
  label: string;
  sortKey: SortKey;
  current: SortKey;
  asc: boolean;
  onSort: (key: SortKey) => void;
}

function SortableTh({ label, sortKey, current, asc, onSort }: SortableThProps) {
  const isActive = current === sortKey;
  return (
    <th style={th}>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="flex items-center gap-1 whitespace-nowrap uppercase transition-colors"
        style={{
          font: 'inherit',
          letterSpacing: 'inherit',
          textTransform: 'inherit',
          color: isActive ? GLASS.accent : GLASS.textMuted,
          background: 'none',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
        }}
      >
        {label}
        <span style={{ fontSize: '0.55rem', lineHeight: 1, opacity: 0.7 }}>
          {isActive ? (asc ? '▲' : '▼') : '▽'}
        </span>
      </button>
    </th>
  );
}

const inlineInput: React.CSSProperties = {
  fontSize: '0.82rem',
  padding: '6px 10px',
  borderRadius: 8,
  border: '1px solid rgba(255,255,255,0.12)',
  background: 'rgba(8,10,15,0.5)',
  color: GLASS.text,
  outline: 'none',
  width: '100%',
  boxSizing: 'border-box',
  transition: 'border-color 0.15s, box-shadow 0.15s',
};
const inlineInputNarrow: React.CSSProperties = { ...inlineInput, width: 96 };

function focusGlow(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = hexToRgba(GLASS.accent, 0.55);
  e.currentTarget.style.boxShadow = `0 0 0 3px ${hexToRgba(GLASS.accent, 0.14)}`;
}
function blurGlow(e: React.FocusEvent<HTMLInputElement>) {
  e.currentTarget.style.borderColor = 'rgba(255,255,255,0.12)';
  e.currentTarget.style.boxShadow = 'none';
}

interface RatesTableProps {
  rates: Rate[];
}

export function RatesTable({ rates }: RatesTableProps) {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const { toastErr } = useToast();
  const { updateMutation, deleteMutation } = useRateRowMutations();

  const [sortKey, setSortKey] = useState<SortKey>('prefix');
  const [sortAsc, setSortAsc] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editState, setEditState] = useState<EditState>({ description: '', rate_per_min: '', cost_per_min: '' });

  const handleSort = useCallback((key: SortKey) => {
    setSortKey((prev) => {
      if (prev === key) {
        setSortAsc((a) => !a);
        return prev;
      }
      setSortAsc(true);
      return key;
    });
  }, []);

  const sorted = useMemo(() => {
    return [...rates].sort((a, b) => {
      let av: string | number = a[sortKey] ?? '';
      let bv: string | number = b[sortKey] ?? '';
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return sortAsc ? -1 : 1;
      if (av > bv) return sortAsc ? 1 : -1;
      return 0;
    });
  }, [rates, sortKey, sortAsc]);

  function startEdit(rate: Rate) {
    setEditingId(rate.id);
    setEditState({
      description: rate.description ?? '',
      rate_per_min: rate.rate_per_min.toFixed(4),
      cost_per_min: rate.cost_per_min.toFixed(4),
    });
  }

  function saveEdit(id: number) {
    const sell = parseFloat(editState.rate_per_min);
    const cost = parseFloat(editState.cost_per_min);
    if (isNaN(sell) || sell < 0) { toastErr('Sell rate must be a non-negative number'); return; }
    if (isNaN(cost) || cost < 0) { toastErr('Cost rate must be a non-negative number'); return; }
    updateMutation.mutate(
      { id, data: { description: editState.description || null, rate_per_min: sell, cost_per_min: cost } },
      { onSuccess: () => setEditingId(null) },
    );
  }

  function handleDelete(rate: Rate) {
    const label = `${rate.prefix}${rate.description ? ` (${rate.description})` : ''}`;
    if (!confirm(`Delete rate ${label}?\n\nThis cannot be undone.`)) return;
    deleteMutation.mutate(rate.id);
  }

  // Early return only after all hooks.
  if (rates.length === 0) {
    return <EmptyState title="No rates found" body="Add your first rate using the form above." />;
  }

  return (
    <GlassTableWrap>
      <thead>
        <tr style={{ background: 'rgba(255,255,255,0.025)' }}>
          <SortableTh label="Prefix" sortKey="prefix" current={sortKey} asc={sortAsc} onSort={handleSort} />
          <SortableTh label="Description" sortKey="description" current={sortKey} asc={sortAsc} onSort={handleSort} />
          <SortableTh label="Sell Rate" sortKey="rate_per_min" current={sortKey} asc={sortAsc} onSort={handleSort} />
          <SortableTh label="Cost Rate" sortKey="cost_per_min" current={sortKey} asc={sortAsc} onSort={handleSort} />
          <SortableTh label="Margin" sortKey="margin_per_min" current={sortKey} asc={sortAsc} onSort={handleSort} />
          <SortableTh label="Margin %" sortKey="margin_pct" current={sortKey} asc={sortAsc} onSort={handleSort} />
          <SortableTh label="Increment" sortKey="increment" current={sortKey} asc={sortAsc} onSort={handleSort} />
          <th style={th}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {sorted.map((rate) => {
          const isEditing = editingId === rate.id;
          const tint = marginRowTint(rate);

          if (isEditing) {
            return (
              <tr key={rate.id} style={{ background: hexToRgba(GLASS.accent, 0.08) }}>
                <td style={{ ...td, fontFamily: MONO, fontWeight: 700 }}>{rate.prefix}</td>
                <td style={td}>
                  <input
                    style={inlineInput}
                    value={editState.description}
                    onChange={(e) => setEditState((s) => ({ ...s, description: e.target.value }))}
                    placeholder="Description"
                    onFocus={focusGlow}
                    onBlur={blurGlow}
                  />
                </td>
                <td style={td}>
                  <input
                    style={inlineInputNarrow}
                    type="number"
                    step="0.0001"
                    min="0"
                    value={editState.rate_per_min}
                    onChange={(e) => setEditState((s) => ({ ...s, rate_per_min: e.target.value }))}
                    onFocus={focusGlow}
                    onBlur={blurGlow}
                  />
                </td>
                <td style={td}>
                  <input
                    style={inlineInputNarrow}
                    type="number"
                    step="0.0001"
                    min="0"
                    value={editState.cost_per_min}
                    onChange={(e) => setEditState((s) => ({ ...s, cost_per_min: e.target.value }))}
                    onFocus={focusGlow}
                    onBlur={blurGlow}
                  />
                </td>
                <td style={td}>
                  <span className={cn('tabular-nums text-[0.82rem]', marginValueClass(rate.margin_per_min))}>
                    {fmtRate4(rate.margin_per_min)}
                  </span>
                </td>
                <td style={td}>
                  <span className={cn('tabular-nums text-[0.82rem] font-semibold', marginPctClass(rate.margin_pct))}>
                    {rate.margin_pct != null ? `${Number(rate.margin_pct).toFixed(1)}%` : '--'}
                  </span>
                </td>
                <td style={{ ...td, color: GLASS.textMuted }}>
                  {rate.increment != null ? `${rate.increment}s` : '--'}
                </td>
                <td style={td}>
                  <div className="flex gap-1.5 whitespace-nowrap">
                    <Button variant="success" size="xs" loading={updateMutation.isPending} onClick={() => saveEdit(rate.id)}>
                      Save
                    </Button>
                    <Button variant="ghost" size="xs" onClick={() => setEditingId(null)}>
                      Cancel
                    </Button>
                  </div>
                </td>
              </tr>
            );
          }

          return (
            <tr
              key={rate.id}
              style={{ background: tint, transition: 'background 0.15s' }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.035)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLTableRowElement).style.background = tint ?? '';
              }}
            >
              <td style={{ ...td, fontFamily: MONO, fontWeight: 700 }}>{rate.prefix}</td>
              <td style={{ ...td, color: GLASS.textMuted }}>{rate.description || '--'}</td>
              <td style={td}>
                <span className="tabular-nums text-[0.82rem]" style={{ color: GLASS.text }}>{fmtRate4(rate.rate_per_min)}</span>
              </td>
              <td style={td}>
                <span className="tabular-nums text-[0.82rem]" style={{ color: GLASS.textMuted }}>{fmtRate4(rate.cost_per_min)}</span>
              </td>
              <td style={td}>
                <span className={cn('tabular-nums text-[0.82rem]', marginValueClass(rate.margin_per_min))}>
                  {fmtRate4(rate.margin_per_min)}
                </span>
              </td>
              <td style={td}>
                <span className={cn('tabular-nums text-[0.82rem] font-semibold', marginPctClass(rate.margin_pct))}>
                  {rate.margin_pct != null ? `${Number(rate.margin_pct).toFixed(1)}%` : '--'}
                </span>
              </td>
              <td style={{ ...td, color: GLASS.textMuted }}>
                {rate.increment != null ? `${rate.increment}s` : '--'}
              </td>
              <td style={td}>
                <div className="flex gap-1.5 whitespace-nowrap">
                  <Button variant="ghost" size="xs" onClick={() => startEdit(rate)}>Edit</Button>
                  <Button
                    variant="danger"
                    size="xs"
                    loading={deleteMutation.isPending && deleteMutation.variables === rate.id}
                    onClick={() => handleDelete(rate)}
                  >
                    Delete
                  </Button>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </GlassTableWrap>
  );
}
