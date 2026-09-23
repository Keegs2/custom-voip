/**
 * Number multi-select — a button that opens a checklist of the customer's
 * numbers (`/reports/my-numbers`). No selection = "All numbers" (the API
 * then reports on every number). Closes on Escape, outside click, or
 * focus leaving the picker; the button reflects the current selection.
 */
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { MyNumber } from '../../types/reports';
import { fmtPhone } from './reportFormat';

interface NumberPickerProps {
  options: MyNumber[];
  selected: string[];
  onChange: (next: string[]) => void;
  loading: boolean;
  failed: boolean;
}

export function NumberPicker({ options, selected, onChange, loading, failed }: NumberPickerProps) {
  // ALL hooks unconditionally at the top (React #310 prevention).
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popId = useId();
  const labelId = useId();

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent): void {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return options;
    const digits = q.replace(/\D/g, '');
    return options.filter(
      (o) => (o.name ?? '').toLowerCase().includes(q) || (digits.length > 0 && o.number.replace(/\D/g, '').includes(digits)),
    );
  }, [options, filter]);

  function toggle(num: string): void {
    const next = new Set(selectedSet);
    if (next.has(num)) next.delete(num);
    else next.add(num);
    // Picking every number is the same report as "all" — keep the URL/query clean.
    onChange(next.size === options.length ? [] : [...next]);
  }

  function close(returnFocus: boolean): void {
    setOpen(false);
    setFilter('');
    if (returnFocus) buttonRef.current?.focus();
  }

  let summary: string;
  if (loading) summary = 'Loading numbers…';
  else if (failed) summary = 'All numbers';
  else if (selected.length === 0) summary = options.length === 1 ? fmtPhone(options[0].number) : `All numbers (${options.length})`;
  else if (selected.length === 1) {
    const one = options.find((o) => o.number === selected[0]);
    summary = one?.name ? `${one.name}` : fmtPhone(selected[0]);
  } else summary = `${selected.length} numbers`;

  const disabled = loading || failed || options.length <= 1;

  return (
    <div
      ref={rootRef}
      className="rpt-numpick"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && open) {
          e.stopPropagation();
          close(true);
        }
      }}
      onBlur={(e) => {
        if (open && rootRef.current && !rootRef.current.contains(e.relatedTarget as Node | null)) close(false);
      }}
    >
      <span className="dl-flabel" id={labelId}>Numbers</span>
      <button
        ref={buttonRef}
        type="button"
        className="dl-input rpt-numpick-btn"
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        aria-labelledby={labelId}
        aria-describedby={failed ? `${labelId}-err` : undefined}
        disabled={disabled}
        onClick={() => (open ? close(false) : setOpen(true))}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{summary}</span>
        <ChevronDown size={14} aria-hidden="true" style={{ flexShrink: 0, color: 'var(--rcf-ink-dim)' }} />
      </button>
      {failed && (
        <span id={`${labelId}-err`} className="dl-help" style={{ display: 'block' }}>
          Couldn’t load your number list — showing all numbers.
        </span>
      )}

      {open && (
        <div id={popId} className="rpt-numpick-pop" role="group" aria-label="Choose numbers">
          <div className="rpt-numpick-head">
            <span>{selected.length === 0 ? 'Showing all numbers' : `${selected.length} picked`}</span>
            <button type="button" className="rpt-linkbtn" disabled={selected.length === 0} onClick={() => onChange([])}>
              Show all
            </button>
          </div>
          {options.length > 8 && (
            <div style={{ padding: '8px 10px 0' }}>
              <input
                type="search"
                className="dl-input"
                placeholder="Find a number or name"
                aria-label="Find a number or name"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                style={{ width: '100%', padding: '7px 10px', fontSize: '0.8rem' }}
                autoFocus
              />
            </div>
          )}
          <div className="rpt-numpick-list">
            {visible.length === 0 && <div className="rpt-numpick-opt rpt-dim">No matches</div>}
            {visible.map((o) => (
              <label key={o.number} className="rpt-numpick-opt">
                <input type="checkbox" checked={selectedSet.has(o.number)} onChange={() => toggle(o.number)} />
                <span style={{ minWidth: 0 }}>
                  <span className="rpt-numpick-num">{fmtPhone(o.number)}</span>
                  {o.name && <span className="rpt-numpick-name">{o.name}</span>}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
