/**
 * Shared presentational pieces for the DID Management tab: the frosted glass
 * card wrapper, section-header bar, status badge, table header cell, and the
 * NPA / NXX / state / search filter bar. All blue-themed, all driven by props.
 */

import type { ReactNode } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import type { DidInventoryItem } from '../../../../types/didInventory';
import type { DidFilterState } from '../../types';
import { BLUE, BLUE_LIGHT, didTh } from '../../styles';

// ── Glass card wrapper (staggered entrance) ──────────────────────────────────

export function DidCard({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  return (
    <GlassPanel padding={0} style={{ animation: 'glass-rise 0.45s cubic-bezier(0.2,0.7,0.3,1) both', animationDelay: `${delay}ms` }}>
      {children}
    </GlassPanel>
  );
}

// ── Section header bar ───────────────────────────────────────────────────────

export function DidSectionHeader({ title, count, countLabel, right }: { title: string; count?: number; countLabel?: string; right?: ReactNode }) {
  return (
    <div style={{ padding: '14px 20px', borderBottom: '1px solid rgba(59,130,246,0.08)', display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', background: 'rgba(59,130,246,0.025)' }}>
      <span style={{ fontSize: '0.72rem', fontWeight: 700, color: GLASS.textFaint, textTransform: 'uppercase', letterSpacing: '0.1em', flexShrink: 0 }}>{title}</span>
      {count !== undefined && (
        <span style={{ fontSize: '0.68rem', fontWeight: 600, color: BLUE, background: 'rgba(59,130,246,0.10)', border: '1px solid rgba(59,130,246,0.20)', borderRadius: 20, padding: '2px 9px', flexShrink: 0 }}>
          {count} {countLabel ?? ''}
        </span>
      )}
      {right && <div style={{ marginLeft: 'auto' }}>{right}</div>}
    </div>
  );
}

// ── Status badge ─────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<DidInventoryItem['status'], { bg: string; color: string; border: string; label: string }> = {
  available:   { bg: 'rgba(59,130,246,0.12)',  color: '#60a5fa', border: 'rgba(59,130,246,0.30)',  label: 'Available' },
  assigned:    { bg: 'rgba(34,197,94,0.12)',   color: '#4ade80', border: 'rgba(34,197,94,0.30)',   label: 'Assigned' },
  reserved:    { bg: 'rgba(245,158,11,0.12)',  color: '#fbbf24', border: 'rgba(245,158,11,0.30)',  label: 'Pending Approval' },
  porting_in:  { bg: 'rgba(168,85,247,0.12)',  color: '#c084fc', border: 'rgba(168,85,247,0.30)', label: 'Porting In' },
  porting_out: { bg: 'rgba(168,85,247,0.12)',  color: '#c084fc', border: 'rgba(168,85,247,0.30)', label: 'Porting Out' },
  suspended:   { bg: 'rgba(239,68,68,0.12)',   color: '#f87171', border: 'rgba(239,68,68,0.30)',  label: 'Suspended' },
};

export function DidStatusBadge({ status }: { status: DidInventoryItem['status'] }) {
  const s = STATUS_STYLES[status] ?? STATUS_STYLES.available;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: '0.67rem', fontWeight: 700, color: s.color, background: s.bg, border: `1px solid ${s.border}`, borderRadius: 20, padding: '3px 9px', whiteSpace: 'nowrap', letterSpacing: '0.03em' }}>
      <span style={{ width: 5, height: 5, borderRadius: '50%', background: s.color, flexShrink: 0, boxShadow: `0 0 5px ${s.color}`, display: 'inline-block' }} />
      {s.label}
    </span>
  );
}

// ── Table header cell ────────────────────────────────────────────────────────

export function DidTh({ children }: { children?: ReactNode }) {
  return <th style={didTh}>{children}</th>;
}

// ── Filter bar ───────────────────────────────────────────────────────────────

interface DidFilterBarProps {
  filters: DidFilterState;
  onFiltersChange: (filters: DidFilterState) => void;
  availableStates: string[];
  resultCount: number;
  totalCount: number;
  compact?: boolean;
}

export function DidFilterBar({ filters, onFiltersChange, availableStates, resultCount, totalCount, compact = false }: DidFilterBarProps) {
  const hasActive = !!(filters.npa || filters.nxx || filters.state || filters.search);

  const inputBase: React.CSSProperties = {
    fontSize: '0.78rem',
    background: 'rgba(15,17,23,0.65)',
    border: '1px solid rgba(59,130,246,0.16)',
    borderRadius: 8,
    color: GLASS.text,
    outline: 'none',
    fontFamily: 'inherit',
    transition: 'border-color 0.18s, box-shadow 0.18s',
  };
  const focusOn = (e: React.FocusEvent<HTMLElement>) => { e.currentTarget.style.borderColor = 'rgba(59,130,246,0.5)'; e.currentTarget.style.boxShadow = '0 0 0 3px rgba(59,130,246,0.12)'; };
  const focusOff = (e: React.FocusEvent<HTMLElement>) => { e.currentTarget.style.borderColor = 'rgba(59,130,246,0.16)'; e.currentTarget.style.boxShadow = 'none'; };
  const labelStyle: React.CSSProperties = { fontSize: '0.56rem', fontWeight: 700, color: GLASS.textFaint, textTransform: 'uppercase', letterSpacing: '0.10em' };

  return (
    <div style={{ padding: compact ? '10px 16px' : '12px 20px', borderBottom: '1px solid rgba(59,130,246,0.08)', display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', background: 'rgba(59,130,246,0.018)' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
        <label style={labelStyle}>Area Code (NPA)</label>
        <input type="text" value={filters.npa} onChange={(e) => onFiltersChange({ ...filters, npa: e.target.value.replace(/\D/g, '').slice(0, 3) })} placeholder="617" maxLength={3} inputMode="numeric" onFocus={focusOn} onBlur={focusOff} style={{ ...inputBase, width: 56, padding: '6px 8px', fontFamily: 'monospace', textAlign: 'center', letterSpacing: '0.08em' }} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
        <label style={labelStyle}>Exchange (NXX)</label>
        <input type="text" value={filters.nxx} onChange={(e) => onFiltersChange({ ...filters, nxx: e.target.value.replace(/\D/g, '').slice(0, 3) })} placeholder="454" maxLength={3} inputMode="numeric" onFocus={focusOn} onBlur={focusOff} style={{ ...inputBase, width: 56, padding: '6px 8px', fontFamily: 'monospace', textAlign: 'center', letterSpacing: '0.08em' }} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0 }}>
        <label style={labelStyle}>State</label>
        <select value={filters.state} onChange={(e) => onFiltersChange({ ...filters, state: e.target.value })} onFocus={focusOn} onBlur={focusOff} style={{ ...inputBase, padding: '6px 8px', cursor: 'pointer', minWidth: 88 }}>
          <option value="">All States</option>
          {availableStates.map((s) => (<option key={s} value={s}>{s}</option>))}
        </select>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flex: '1 1 160px', minWidth: 140 }}>
        <label style={labelStyle}>Search</label>
        <div style={{ position: 'relative' }}>
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth={2} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', width: 12, height: 12, color: GLASS.textFaint, pointerEvents: 'none' }}>
            <path d="m19 19-4.35-4.35M15 9A6 6 0 1 1 3 9a6 6 0 0 1 12 0Z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          <input type="text" value={filters.search} onChange={(e) => onFiltersChange({ ...filters, search: e.target.value })} placeholder="City, rate center, DID…" onFocus={focusOn} onBlur={focusOff} style={{ ...inputBase, width: '100%', boxSizing: 'border-box', padding: '6px 8px 6px 26px' }} />
        </div>
      </div>

      <div style={{ marginLeft: 'auto', flexShrink: 0, alignSelf: 'flex-end', paddingBottom: 1 }}>
        <span style={{ fontSize: '0.67rem', fontWeight: 600, color: hasActive ? BLUE_LIGHT : GLASS.textFaint, background: hasActive ? 'rgba(59,130,246,0.12)' : 'rgba(59,130,246,0.05)', border: `1px solid ${hasActive ? 'rgba(59,130,246,0.28)' : 'rgba(59,130,246,0.10)'}`, borderRadius: 20, padding: '3px 10px', transition: 'all 0.2s' }}>
          {hasActive ? `${resultCount} of ${totalCount}` : `${totalCount} total`}
        </span>
      </div>

      {hasActive && (
        <button type="button" onClick={() => onFiltersChange({ npa: '', nxx: '', state: '', search: '' })} style={{ alignSelf: 'flex-end', padding: '4px 10px', borderRadius: 6, border: 'none', background: 'transparent', color: GLASS.textFaint, fontSize: '0.68rem', cursor: 'pointer', fontFamily: 'inherit', textDecoration: 'underline', marginBottom: 1 }}>Clear</button>
      )}
    </div>
  );
}
