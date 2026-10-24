/**
 * ActivityDidPicker — the "Viewing: All Numbers / one DID" dropdown on the
 * Call Activity tab (moved verbatim from RcfPage). The selection scopes
 * EVERYTHING on the tab — KPIs, chart and table — via a server-side filter
 * (`destination` on the /rcf console, `number` on the dashboard's
 * account-wide view).
 *
 * Takes generic numbers (`PickerNumber`): the /rcf console passes its RCF
 * entries and renders exactly as before; the account view passes every
 * product's numbers, and a non-forwarding number carries a product tag.
 *
 * Colours are theme tokens (docker/ui/CLAUDE.md §18); the menu panel and
 * the option / clear-button hover states are CSS (`.rcf-didpick-*` in
 * index.css), so they follow the theme and need no mouse handlers.
 */
import { useEffect, useRef, useState } from 'react';
import { productTag } from '../../config/products';
import { fmt } from '../../utils/format';
import { T, tMix } from '../../styles/theme';
import { AZURE_DEEP, DL, INK, INK_DIM, INK_FAINT, MONO } from './theme';
import { didLabel, type PickerNumber } from './activityFormat';

export interface ActivityDidPickerProps {
  entries: readonly PickerNumber[];
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
            background: DL.iconWash,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.7} style={{ width: 11, height: 11, stroke: AZURE_DEEP }}>
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
            borderColor: didDropdownOpen ? T.accentLine : selectedDid ? tMix('accent-line', 45) : undefined,
            boxShadow: didDropdownOpen ? T.focusHalo : undefined,
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
            strokeWidth={2}
            style={{
              stroke: selectedDid ? AZURE_DEEP : INK_DIM,
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
            className="rcf-didpick-menu"
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              right: 0,
              zIndex: 999,
              borderRadius: 12,
              overflow: 'hidden',
              animation: 'fx-rise 0.12s ease',
            }}
          >
            {/* All Numbers option */}
            <button
              type="button"
              onClick={() => { setSelectedDid(null); setDidDropdownOpen(false); }}
              className={`rcf-didpick-opt rcf-didpick-opt-all${!selectedDid ? ' rcf-didpick-opt-on' : ''}`}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '11px 14px',
                border: 'none',
                borderBottom: '1px solid var(--rcf-line)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                textAlign: 'left',
              }}
            >
              <div
                style={{
                  width: 28,
                  height: 28,
                  borderRadius: 7,
                  background: !selectedDid ? DL.iconWashStrong : DL.iconWashMute,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  flexShrink: 0,
                  transition: 'background 0.14s',
                }}
              >
                <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.7} style={{ width: 11, height: 11, stroke: !selectedDid ? AZURE_DEEP : INK_DIM }}>
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
                <span style={{ marginLeft: 'auto', fontSize: '0.6rem', fontWeight: 700, color: AZURE_DEEP, background: tMix('accent-line', 10), border: `1px solid ${tMix('accent-line', 28)}`, borderRadius: 20, padding: '2px 8px', letterSpacing: '0.06em', textTransform: 'uppercase', flexShrink: 0 }}>
                  Active
                </span>
              )}
            </button>

            {/* Individual DID options */}
            <div style={{ maxHeight: 280, overflowY: 'auto' }}>
              {rcfEntries.map((entry) => {
                const isSelected = selectedDid === entry.number;
                const product = entry.product ?? 'rcf';
                return (
                  <button
                    key={entry.number}
                    type="button"
                    onClick={() => { setSelectedDid(entry.number); setDidDropdownOpen(false); }}
                    className={`rcf-didpick-opt${isSelected ? ' rcf-didpick-opt-on' : ''}`}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 10,
                      padding: '10px 14px',
                      border: 'none',
                      borderBottom: '1px solid var(--rcf-line-soft)',
                      cursor: 'pointer',
                      fontFamily: 'inherit',
                      textAlign: 'left',
                    }}
                  >
                    {/* Status dot */}
                    <span
                      style={{
                        width: 7,
                        height: 7,
                        borderRadius: '50%',
                        background: entry.enabled === undefined ? 'transparent' : entry.enabled ? T.okSolid : T.dangerSolid,
                        flexShrink: 0,
                        display: 'inline-block',
                      }}
                    />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: '0.84rem', fontWeight: 700, color: isSelected ? AZURE_DEEP : INK, fontFamily: MONO, letterSpacing: '0.01em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {fmt(entry.number)}
                      </div>
                      {entry.name && (
                        <div style={{ fontSize: '0.65rem', color: isSelected ? T.accentLine : INK_DIM, marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {entry.name}
                        </div>
                      )}
                    </div>
                    {product !== 'rcf' && <span className="ad-prodtag">{productTag(product)}</span>}
                    {isSelected && (
                      <svg viewBox="0 0 16 16" fill="none" strokeWidth={2.2} style={{ width: 13, height: 13, flexShrink: 0, stroke: AZURE_DEEP }}>
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
            className="rcf-didpick-clear"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 7,
              color: AZURE_DEEP,
              cursor: 'pointer',
              padding: 0,
              flexShrink: 0,
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
