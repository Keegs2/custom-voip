import { useState, useCallback, useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateRate, deleteRate } from '../../api/rates';
import { Button } from '../../components/ui/Button';
import { TableWrap, Table, Thead, Th, Td } from '../../components/ui/Table';
import { useToast } from '../../components/ui/Toast';
import { cn } from '../../utils/cn';
import type { Rate, RateUpdate } from '../../types/rate';

type SortKey = keyof Pick<
  Rate,
  'prefix' | 'description' | 'rate_per_min' | 'cost_per_min' | 'margin_per_min' | 'margin_pct' | 'increment'
>;

function marginRowClass(rate: Rate): string {
  const margin = rate.margin_per_min ?? 0;
  const pct = rate.margin_pct ?? 100;
  if (margin < 0 || pct < 0) return 'bg-red-500/[0.04]';
  if (pct < 30) return 'bg-amber-500/[0.04]';
  return '';
}

function marginPctClass(pct: number | null | undefined): string {
  if (pct == null) return 'text-[#718096]';
  if (pct < 0) return 'text-red-400 font-bold';
  if (pct < 15) return 'text-red-400';
  if (pct < 30) return 'text-amber-400';
  return 'text-green-400';
}

function marginValueClass(val: number | null | undefined): string {
  if (val == null) return 'text-[#718096]';
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
    <Th>
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className="flex items-center gap-1 whitespace-nowrap text-[0.68rem] font-bold uppercase tracking-[0.7px] text-[#718096] hover:text-[#e2e8f0] transition-colors"
      >
        {label}
        <span className="text-[0.55rem] leading-none opacity-60">
          {isActive ? (asc ? '▲' : '▼') : '▽'}
        </span>
      </button>
    </Th>
  );
}

interface EditState {
  description: string;
  rate_per_min: string;
  cost_per_min: string;
}

interface RatesTableProps {
  rates: Rate[];
}

export function RatesTable({ rates }: RatesTableProps) {
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();

  const [sortKey, setSortKey] = useState<SortKey>('prefix');
  const [sortAsc, setSortAsc] = useState(true);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editState, setEditState] = useState<EditState>({
    description: '',
    rate_per_min: '',
    cost_per_min: '',
  });

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

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: number; data: RateUpdate }) => updateRate(id, data),
    onSuccess: (_, { id }) => {
      toastOk(`Rate #${id} updated`);
      setEditingId(null);
      void queryClient.invalidateQueries({ queryKey: ['rates'] });
      void queryClient.invalidateQueries({ queryKey: ['margins'] });
    },
    onError: (err: Error) => toastErr(`Update failed: ${err.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteRate(id),
    onSuccess: (_, id) => {
      toastOk(`Rate #${id} deleted`);
      void queryClient.invalidateQueries({ queryKey: ['rates'] });
      void queryClient.invalidateQueries({ queryKey: ['margins'] });
    },
    onError: (err: Error) => toastErr(`Delete failed: ${err.message}`),
  });

  function startEdit(rate: Rate) {
    setEditingId(rate.id);
    setEditState({
      description: rate.description ?? '',
      rate_per_min: rate.rate_per_min.toFixed(4),
      cost_per_min: rate.cost_per_min.toFixed(4),
    });
  }

  function cancelEdit() {
    setEditingId(null);
  }

  function saveEdit(id: number) {
    const sell = parseFloat(editState.rate_per_min);
    const cost = parseFloat(editState.cost_per_min);

    if (isNaN(sell) || sell < 0) {
      toastErr('Sell rate must be a non-negative number');
      return;
    }
    if (isNaN(cost) || cost < 0) {
      toastErr('Cost rate must be a non-negative number');
      return;
    }

    updateMutation.mutate({
      id,
      data: {
        description: editState.description || null,
        rate_per_min: sell,
        cost_per_min: cost,
      },
    });
  }

  function handleDelete(rate: Rate) {
    const label = `${rate.prefix}${rate.description ? ` (${rate.description})` : ''}`;
    if (!confirm(`Delete rate ${label}?\n\nThis cannot be undone.`)) return;
    deleteMutation.mutate(rate.id);
  }

  if (rates.length === 0) {
    return (
      <div
        style={{
          textAlign: 'center',
          padding: '48px 24px',
          background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
          border: '1px solid rgba(42,47,69,0.6)',
          borderRadius: 16,
          color: '#718096',
          fontSize: '0.875rem',
        }}
      >
        <p style={{ fontWeight: 600, color: '#e2e8f0', marginBottom: 6 }}>No rates found</p>
        <p>Add your first rate using the form above.</p>
      </div>
    );
  }

  const inlineInputStyle: React.CSSProperties = {
    fontSize: '0.82rem',
    padding: '6px 10px',
    borderRadius: 7,
    border: '1px solid rgba(42,47,69,0.8)',
    background: 'rgba(13,15,21,0.9)',
    color: '#e2e8f0',
    outline: 'none',
    width: '100%',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  };

  const inlineInputNarrowStyle: React.CSSProperties = {
    ...inlineInputStyle,
    width: 90,
  };

  return (
    <TableWrap>
      <Table>
        <Thead>
          <tr>
            <SortableTh label="Prefix" sortKey="prefix" current={sortKey} asc={sortAsc} onSort={handleSort} />
            <SortableTh label="Description" sortKey="description" current={sortKey} asc={sortAsc} onSort={handleSort} />
            <SortableTh label="Sell Rate" sortKey="rate_per_min" current={sortKey} asc={sortAsc} onSort={handleSort} />
            <SortableTh label="Cost Rate" sortKey="cost_per_min" current={sortKey} asc={sortAsc} onSort={handleSort} />
            <SortableTh label="Margin" sortKey="margin_per_min" current={sortKey} asc={sortAsc} onSort={handleSort} />
            <SortableTh label="Margin %" sortKey="margin_pct" current={sortKey} asc={sortAsc} onSort={handleSort} />
            <SortableTh label="Increment" sortKey="increment" current={sortKey} asc={sortAsc} onSort={handleSort} />
            <Th>Actions</Th>
          </tr>
        </Thead>
        <tbody>
          {sorted.map((rate) => {
            const isEditing = editingId === rate.id;
            const rowTint = marginRowClass(rate);

            if (isEditing) {
              return (
                <tr
                  key={rate.id}
                  className={cn('transition-colors', rowTint)}
                  style={{ background: 'rgba(59,130,246,0.06)' }}
                >
                  <Td>
                    <span className="tabular-nums font-semibold text-[#e2e8f0]">
                      {rate.prefix}
                    </span>
                  </Td>
                  <Td>
                    <input
                      style={inlineInputStyle}
                      value={editState.description}
                      onChange={(e) => setEditState((s) => ({ ...s, description: e.target.value }))}
                      placeholder="Description"
                      onFocus={(e) => {
                        e.currentTarget.style.borderColor = '#3b82f6';
                        e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.12)';
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.borderColor = 'rgba(42,47,69,0.8)';
                        e.currentTarget.style.boxShadow = 'none';
                      }}
                    />
                  </Td>
                  <Td>
                    <input
                      style={inlineInputNarrowStyle}
                      type="number"
                      step="0.0001"
                      min="0"
                      value={editState.rate_per_min}
                      onChange={(e) => setEditState((s) => ({ ...s, rate_per_min: e.target.value }))}
                      onFocus={(e) => {
                        e.currentTarget.style.borderColor = '#3b82f6';
                        e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.12)';
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.borderColor = 'rgba(42,47,69,0.8)';
                        e.currentTarget.style.boxShadow = 'none';
                      }}
                    />
                  </Td>
                  <Td>
                    <input
                      style={inlineInputNarrowStyle}
                      type="number"
                      step="0.0001"
                      min="0"
                      value={editState.cost_per_min}
                      onChange={(e) => setEditState((s) => ({ ...s, cost_per_min: e.target.value }))}
                      onFocus={(e) => {
                        e.currentTarget.style.borderColor = '#3b82f6';
                        e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.12)';
                      }}
                      onBlur={(e) => {
                        e.currentTarget.style.borderColor = 'rgba(42,47,69,0.8)';
                        e.currentTarget.style.boxShadow = 'none';
                      }}
                    />
                  </Td>
                  <Td>
                    <span className={cn('tabular-nums text-[0.82rem]', marginValueClass(rate.margin_per_min))}>
                      {fmtRate4(rate.margin_per_min)}
                    </span>
                  </Td>
                  <Td>
                    <span className={cn('tabular-nums text-[0.82rem] font-semibold', marginPctClass(rate.margin_pct))}>
                      {rate.margin_pct != null ? `${Number(rate.margin_pct).toFixed(1)}%` : '--'}
                    </span>
                  </Td>
                  <Td>
                    <span className="text-[#718096] text-[0.82rem]">
                      {rate.increment != null ? `${rate.increment}s` : '--'}
                    </span>
                  </Td>
                  <Td>
                    <div className="flex gap-1.5 whitespace-nowrap">
                      <Button
                        variant="success"
                        size="xs"
                        loading={updateMutation.isPending}
                        onClick={() => saveEdit(rate.id)}
                      >
                        Save
                      </Button>
                      <Button variant="ghost" size="xs" onClick={cancelEdit}>
                        Cancel
                      </Button>
                    </div>
                  </Td>
                </tr>
              );
            }

            return (
              <tr
                key={rate.id}
                className={cn('transition-colors', rowTint)}
                style={{ transition: 'background 0.15s' }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.018)';
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLTableRowElement).style.background = '';
                }}
              >
                <Td>
                  <span className="tabular-nums font-semibold text-[#e2e8f0]">{rate.prefix}</span>
                </Td>
                <Td>
                  <span className="text-[#718096] text-[0.85rem]">{rate.description || '--'}</span>
                </Td>
                <Td>
                  <span className="tabular-nums text-[0.82rem] text-[#e2e8f0]">
                    {fmtRate4(rate.rate_per_min)}
                  </span>
                </Td>
                <Td>
                  <span className="tabular-nums text-[0.82rem] text-[#718096]">
                    {fmtRate4(rate.cost_per_min)}
                  </span>
                </Td>
                <Td>
                  <span className={cn('tabular-nums text-[0.82rem]', marginValueClass(rate.margin_per_min))}>
                    {fmtRate4(rate.margin_per_min)}
                  </span>
                </Td>
                <Td>
                  <span className={cn('tabular-nums text-[0.82rem] font-semibold', marginPctClass(rate.margin_pct))}>
                    {rate.margin_pct != null ? `${Number(rate.margin_pct).toFixed(1)}%` : '--'}
                  </span>
                </Td>
                <Td>
                  <span className="text-[#718096] text-[0.82rem]">
                    {rate.increment != null ? `${rate.increment}s` : '--'}
                  </span>
                </Td>
                <Td>
                  <div className="flex gap-1.5 whitespace-nowrap">
                    <Button variant="ghost" size="xs" onClick={() => startEdit(rate)}>
                      Edit
                    </Button>
                    <Button
                      variant="danger"
                      size="xs"
                      loading={deleteMutation.isPending && deleteMutation.variables === rate.id}
                      onClick={() => handleDelete(rate)}
                    >
                      Delete
                    </Button>
                  </div>
                </Td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </TableWrap>
  );
}
