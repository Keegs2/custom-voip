/**
 * NumbersToolbar — search field + NPA (area-code) filter + result count for the
 * Numbers tab. Stateless apart from its visual focus states; all data flows via
 * props from the page.
 */

import { useState } from 'react';
import { GLASS } from '../../../../components/glass/glass';
import { BLUE, BLUE_LIGHT, countPill } from '../../styles';

interface NumbersToolbarProps {
  searchInput: string;
  onSearchInput: (v: string) => void;
  onClearSearch: () => void;
  npaFilter: string;
  onNpaChange: (v: string) => void;
  onClearNpa: () => void;
  serverTotal: number;
  filteredCount: number;
  rawCount: number;
  filterActive: boolean;
}

export function NumbersToolbar({
  searchInput,
  onSearchInput,
  onClearSearch,
  npaFilter,
  onNpaChange,
  onClearNpa,
  serverTotal,
  filteredCount,
  rawCount,
  filterActive,
}: NumbersToolbarProps) {
  const [searchFocused, setSearchFocused] = useState(false);
  const npaActive = npaFilter.length === 3;

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
      {/* Search */}
      <div style={{ position: 'relative', flex: '1 1 240px', minWidth: 200 }}>
        <span
          aria-hidden
          style={{
            position: 'absolute',
            left: 13,
            top: '50%',
            transform: 'translateY(-50%)',
            color: searchFocused ? BLUE : GLASS.textFaint,
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
          onChange={(e) => onSearchInput(e.target.value)}
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
            color: GLASS.text,
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
            onClick={onClearSearch}
            style={{
              position: 'absolute',
              right: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'rgba(59,130,246,0.12)',
              border: '1px solid rgba(59,130,246,0.20)',
              borderRadius: 5,
              color: BLUE_LIGHT,
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

      {/* NPA filter */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <label style={{ fontSize: '0.68rem', fontWeight: 600, color: GLASS.textFaint, whiteSpace: 'nowrap' }}>NPA</label>
        <input
          type="text"
          value={npaFilter}
          onChange={(e) => onNpaChange(e.target.value.replace(/\D/g, '').slice(0, 3))}
          placeholder="617"
          maxLength={3}
          inputMode="numeric"
          title="Filter by area code (NPA)"
          style={{
            width: 56,
            padding: '8px 8px',
            fontSize: '0.83rem',
            fontFamily: 'ui-monospace, monospace',
            textAlign: 'center',
            letterSpacing: '0.08em',
            background: npaActive ? 'rgba(19,21,29,0.85)' : 'rgba(19,21,29,0.65)',
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
            border: `1px solid ${npaActive ? 'rgba(59,130,246,0.55)' : 'rgba(59,130,246,0.12)'}`,
            borderRadius: 9,
            color: npaActive ? BLUE_LIGHT : GLASS.text,
            outline: 'none',
            boxShadow: npaActive ? '0 0 0 3px rgba(59,130,246,0.14)' : '0 2px 8px rgba(0,0,0,0.2)',
            transition: 'border-color 0.2s, box-shadow 0.2s, color 0.2s',
          }}
        />
        {npaFilter && (
          <button
            type="button"
            onClick={onClearNpa}
            title="Clear NPA filter"
            style={{
              background: 'rgba(59,130,246,0.10)',
              border: '1px solid rgba(59,130,246,0.18)',
              borderRadius: 5,
              color: BLUE_LIGHT,
              cursor: 'pointer',
              padding: '3px 5px',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 9, height: 9 }}>
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>

      {/* Count pill */}
      {serverTotal > 0 && (
        <div style={countPill()}>
          {filterActive && filteredCount !== rawCount
            ? `${filteredCount} of ${serverTotal}`
            : `${serverTotal} ${serverTotal === 1 ? 'number' : 'numbers'}`}
        </div>
      )}
    </div>
  );
}
