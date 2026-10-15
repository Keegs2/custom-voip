/**
 * ActivityDidPicker — the "Viewing: All Numbers / one DID" dropdown on the
 * Call Activity tab (moved verbatim from RcfPage; behavior unchanged). The
 * selection scopes EVERYTHING on the tab — KPIs, chart and table — via the
 * server-side `destination` filter.
 */
import { useEffect, useRef, useState } from 'react';
import type { RcfEntry } from '../../types/rcf';
import { fmt } from '../../utils/format';
import { AZURE, AZURE_DEEP, INK, INK_DIM, INK_FAINT, MONO } from './theme';
import { didLabel } from './activityFormat';

export interface ActivityDidPickerProps {
  entries: RcfEntry[];
  /** E.164 DID, or null for All Numbers. */
  selectedDid: string | null;
  onChange: (did: string | null) => void;
}

export function ActivityDidPicker({ entries: rcfEntries, selectedDid, onChange }: ActivityDidPickerProps) {
  // ALL hooks unconditionally at top — rules of hooks (#310 prevention)
  const [didDropdownOpen, setDidDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

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

  const selectedLabel = didLabel(rcfEntries, selectedDid);
  const setSelectedDid = onChange;

  return (
    <div className="rcf-act-didpick">
      {/* Left: icon + label */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: '#e4eeff',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg viewBox="0 0 16 16" fill="none" stroke={AZURE_DEEP} strokeWidth={1.7} style={{ width: 11, height: 11 }}>
            <path d="M3 5a2 2 0 0 1 2-2h1.28a.8.8 0 0 1 .758.547l.6 1.797a.8.8 0 0 1-.401.968l-.903.452a8.833 8.833 0 0 0 4.413 4.413l.452-.903a.8.8 0 0 1 .968-.401l1.797.6A.8.8 0 0 1 14 11.72V13a2 2 0 0 1-2 2h-.4C5.87 15 1 10.13 1 4.4V4a1 1 0 0 1 1-1h1z" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>
        <span style={{ fontSize: '0.66rem', fontWeight: 700, color: INK_DIM, letterSpacing: '0.08em', textTransform: 'uppercase' }}>
          Viewing
        </span>
      </div>

      {/* Centre: custom dropdown */}
      <div ref={dropdownRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
        <button
          type="button"
          onClick={() => setDidDropdownOpen((o) => !o)}
          className="rcf-input"
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            cursor: 'pointer',
            borderColor: didDropdownOpen ? AZURE : selectedDid ? 'rgba(47,125,246,0.45)' : undefined,
            boxShadow: didDropdownOpen ? '0 0 0 3px rgba(47,125,246,0.16)' : undefined,
            background: '#ffffff',
          }}
        >
          <span style={{ flex: 1, minWidth: 0, textAlign: 'left', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selectedDid ? (
              <span style={{ fontSize: '0.84rem', fontWeight: 700, color: AZURE_DEEP, fontFamily: MONO, letterSpacing: '0.01em' }}>
                {selectedLabel}
              </span>
            ) : (
              <span style={{ fontSize: '0.84rem', fontWeight: 700, color: INK }}>
                All Numbers
              </span>
            )}
          </span>
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke={selectedDid ? AZURE_DEEP : INK_DIM}
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
              background: '#ffffff',
              border: '1px solid #d5deeb',
              borderRadius: 12,
              overflow: 'hidden',
              boxShadow: '0 20px 44px -12px rgba(14,23,38,0.32)',
              animation: 'fx-rise 0.12s ease',
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
                borderBottom: '1px solid var(--rcf-line)',
                background: !selectedDid ? 'rgba(47,125,246,0.07)' : 'transparent',
                cursor: 'pointer',
                fontFamily: 'inherit',
                textAlign: 'left',
                transition: 'background 0.14s',
              }}
              onMouseEnter={(e) => { if (selectedDid) e.currentTarget.style.background = '#f2f7ff'; }}
              onMouseLeave={(e) => { if (selectedDid) e.currentTarget.style.background = 'transparent'; }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: !selectedDid ? '#dfeaff' : '#eef2f8',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'background 0.14s',
                }}
              >
                <svg viewBox="0 0 16 16" fill="none" stroke={!selectedDid ? AZURE_DEEP : INK_DIM} strokeWidth={1.7} style={{ width: 11, height: 11 }}>
                  <rect x="2" y="2" width="5" height="5" rx="1.2" />
                  <rect x="9" y="2" width="5" height="5" rx="1.2" />
                  <rect x="2" y="9" width="5" height="5" rx="1.2" />
                  <rect x="9" y="9" width="5" height="5" rx="1.2" />
                </svg>
              </div>
              <div>
                <div style={{ fontSize: '0.84rem', fontWeight: 800, color: !selectedDid ? AZURE_DEEP : INK, letterSpacing: '-0.01em' }}>
                  All Numbers
                </div>
                <div style={{ fontSize: '0.65rem', color: INK_FAINT, marginTop: 1 }}>
                  Aggregate data for all {rcfEntries.length} number{rcfEntries.length !== 1 ? 's' : ''}
                </div>
              </div>
              {!selectedDid && (
                <span style={{ marginLeft: 'auto', fontSize: '0.6rem', fontWeight: 700, color: AZURE_DEEP, background: 'rgba(47,125,246,0.1)', border: '1px solid rgba(47,125,246,0.28)', borderRadius: 20, padding: '2px 8px', letterSpacing: '0.06em', textTransform: 'uppercase', flexShrink: 0 }}>
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
                      borderBottom: '1px solid var(--rcf-line-soft)',
                      background: isSelected ? 'rgba(47,125,246,0.06)' : 'transparent',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      textAlign: 'left',
                      transition: 'background 0.14s',
                    }}
                    onMouseEnter={(e) => { if (!isSelected) e.currentTarget.style.background = '#f2f7ff'; }}
                    onMouseLeave={(e) => { if (!isSelected) e.currentTarget.style.background = 'transparent'; }}
                  >
                    {/* Status dot */}
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: entry.enabled ? '#16a34a' : '#dc2626',
                        flexShrink: 0,
                        display: 'inline-block',
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.84rem', fontWeight: 700, color: isSelected ? AZURE_DEEP : INK, fontFamily: MONO, letterSpacing: '0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {fmt(entry.did)}
                      </div>
                      {entry.name && (
                        <div style={{ fontSize: '0.65rem', color: isSelected ? AZURE : INK_DIM, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {entry.name}
                        </div>
                      )}
                    </div>
                    {isSelected && (
                      <svg viewBox="0 0 16 16" fill="none" stroke={AZURE_DEEP} strokeWidth={2.2} style={{ width: 13, height: 13, flexShrink: 0 }}>
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
            color: INK_DIM,
            background: 'var(--rcf-tint)',
            border: '1px solid var(--rcf-line)',
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
              border: '1px solid rgba(47,125,246,0.3)',
              background: 'rgba(47,125,246,0.07)',
              color: AZURE_DEEP,
              cursor: 'pointer',
              padding: 0,
              transition: 'background 0.15s, border-color 0.15s',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(47,125,246,0.14)';
              e.currentTarget.style.borderColor = 'rgba(47,125,246,0.5)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(47,125,246,0.07)';
              e.currentTarget.style.borderColor = 'rgba(47,125,246,0.3)';
            }}
          >
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2.2} style={{ width: 10, height: 10 }}>
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        )}
      </div>
    </div>
  );
}
