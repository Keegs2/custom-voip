/**
 * PaginationControls — page navigation + per-page selector for the Numbers
 * table. Offset/page based. Driven entirely by props.
 */

import { GLASS } from '../../../../components/glass/glass';
import { PAGE_SIZE_OPTIONS } from '../../types';

interface PaginationControlsProps {
  currentPage: number;
  totalPages: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
}

export function PaginationControls({
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
    color: active ? '#60a5fa' : disabled ? '#1e293b' : GLASS.textFaint,
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
        <span style={{ fontSize: '0.75rem', color: GLASS.textFaint }}>
          Showing <strong style={{ color: GLASS.textMuted, fontVariantNumeric: 'tabular-nums' }}>{start}–{end}</strong> of{' '}
          <strong style={{ color: GLASS.textMuted, fontVariantNumeric: 'tabular-nums' }}>{totalItems}</strong>
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ fontSize: '0.7rem', color: GLASS.textFaint }}>Per page:</span>
          <select
            value={pageSize}
            onChange={(e) => { onPageSizeChange(Number(e.target.value)); onPageChange(1); }}
            style={{
              fontSize: '0.75rem',
              background: 'rgba(15,17,23,0.8)',
              border: '1px solid rgba(59,130,246,0.18)',
              borderRadius: 7,
              color: GLASS.textMuted,
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
        <button type="button" disabled={currentPage === 1} onClick={() => onPageChange(currentPage - 1)} style={btnStyle(false, currentPage === 1)} aria-label="Previous page">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 11, height: 11 }}>
            <path d="M10 12L6 8l4-4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        {pageNumbers.map((p, i) =>
          p === 'ellipsis' ? (
            <span key={`ell-${i}`} style={{ color: '#334155', padding: '0 4px', fontSize: '0.78rem' }}>…</span>
          ) : (
            <button key={p} type="button" onClick={() => onPageChange(p)} style={btnStyle(currentPage === p, false)}>{p}</button>
          ),
        )}

        <button type="button" disabled={currentPage === totalPages} onClick={() => onPageChange(currentPage + 1)} style={btnStyle(false, currentPage === totalPages)} aria-label="Next page">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 11, height: 11 }}>
            <path d="M6 4l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
