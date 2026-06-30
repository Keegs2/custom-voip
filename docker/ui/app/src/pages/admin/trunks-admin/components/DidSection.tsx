/**
 * DidSection — assigned-DID management for one trunk, with a searchable
 * available-number dropdown and an inline assignment-confirmation step. Data,
 * dropdown logic, and mutations live in `useDidManager`.
 */

import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { Button } from '../../../../components/ui/Button';
import { useDidManager } from '../hooks';
import { EnabledBadge } from './badges';
import { DropdownOption } from './DropdownOption';
import {
  sectionLabel,
  spinnerRing,
  loadingHint,
  itemRow,
  itemValue,
  removeBtn,
  emptyHint,
  fieldLabel,
  didInput,
  dropdownPanel,
  dropdownInfo,
  confirmBox,
  MONO,
} from '../styles';

export function DidSection({ trunkId }: { trunkId: number }) {
  const m = useDidManager(trunkId);

  return (
    <div>
      <div style={sectionLabel()}>Assigned DIDs</div>

      {m.isLoading && (
        <div style={loadingHint}>
          <span style={spinnerRing()} /> Loading DIDs…
        </div>
      )}

      {m.dids && m.dids.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 12 }}>
          {m.dids.map((did) => (
            <div key={did.id} style={itemRow}>
              <span style={itemValue}>{did.did}</span>
              <EnabledBadge enabled={did.enabled} />
              <button
                type="button"
                onClick={() => {
                  if (!confirm(`Remove DID ${did.did}?`)) return;
                  m.remove(did.id);
                }}
                disabled={m.isDeleting}
                style={{ ...removeBtn, opacity: m.isDeleting ? 0.5 : 1 }}
                title="Remove DID"
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {m.dids && m.dids.length === 0 && !m.isLoading && <div style={emptyHint}>No DIDs assigned.</div>}

      {/* Input row with searchable dropdown */}
      <form onSubmit={m.stageAdd} style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div ref={m.wrapperRef} style={{ flex: '0 0 320px', position: 'relative' }}>
          <div style={fieldLabel}>DID / Phone Number</div>
          <input
            type="text"
            value={m.inputValue}
            onChange={m.onInputChange}
            onFocus={m.onInputFocus}
            onKeyDown={m.onInputKeyDown}
            placeholder={m.loadingTNs ? 'Loading numbers…' : '+14155551234'}
            autoComplete="off"
            style={didInput()}
            onFocusCapture={(e) => {
              (e.target as HTMLInputElement).style.borderColor = hexToRgba(GLASS.accent, 0.5);
              (e.target as HTMLInputElement).style.boxShadow = `0 0 0 3px ${hexToRgba(GLASS.accent, 0.14)}`;
            }}
            onBlurCapture={(e) => {
              (e.target as HTMLInputElement).style.borderColor = 'rgba(255,255,255,0.12)';
              (e.target as HTMLInputElement).style.boxShadow = 'none';
            }}
          />

          {m.dropdownOpen && (
            <div style={dropdownPanel}>
              {m.loadingTNs && (
                <div style={dropdownInfo}>
                  <span style={spinnerRing()} /> Loading available numbers…
                </div>
              )}

              {!m.loadingTNs && m.options.length === 0 && (
                <div style={dropdownInfo}>
                  No available numbers{m.inputValue.trim() && ' matching your search'}. You can still submit a custom number.
                </div>
              )}

              {!m.loadingTNs &&
                m.options.map((tn, idx) => (
                  <DropdownOption key={tn.tn} tn={tn} highlighted={idx === m.highlightedIndex} onSelect={m.selectOption} />
                ))}
            </div>
          )}
        </div>

        <Button type="submit" variant="ghost" size="sm" disabled={m.showConfirm}>
          + Add DID
        </Button>
      </form>

      {/* Inline confirmation step */}
      {m.showConfirm && (
        <div style={confirmBox()}>
          <div style={{ fontSize: '0.82rem', color: GLASS.text, marginBottom: 10, lineHeight: 1.5 }}>
            Assign{' '}
            <span style={{ fontFamily: MONO, color: '#93c5fd' }}>{m.pendingLabel}</span>{' '}
            to this trunk? This DID will be routed to this trunk for all inbound calls.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button type="button" variant="ghost" size="sm" onClick={m.cancelConfirm} disabled={m.isAdding}>
              Cancel
            </Button>
            <Button type="button" variant="primary" size="sm" loading={m.isAdding} onClick={m.confirmAdd}>
              Confirm Assignment
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
