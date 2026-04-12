/**
 * IVR Builder — Canvas Toolbar
 *
 * Sits above the canvas area in the right section. Contains:
 *   - Editable flow name
 *   - Customer / DID dropdowns
 *   - Horizontal verb palette (draggable chips)
 *   - Preview XML, Delete Flow, Save Flow actions
 *
 * The "New" and "Load" actions have moved to the left panel flow list.
 */

import { useState, useEffect } from 'react';
import { listCustomers } from '../../api/customers';
import { listApiDids } from '../../api/apiDids';
import type { Customer } from '../../types/customer';
import type { ApiDid } from '../../types/apiDid';
import type { IvrAction, IvrFlowState } from './useIvrFlow';
import { IvrPalette } from './IvrPalette';

interface IvrTopbarProps {
  state: IvrFlowState;
  dispatch: React.Dispatch<IvrAction>;
  onSave: () => void;
  onPreviewXml: () => void;
  onDelete: () => void;
  isSaving: boolean;
  isDeleting: boolean;
}

// Shared pill base styles applied to both selects and buttons
const pillBase: React.CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 600,
  height: 30,
  borderRadius: 7,
  padding: '5px 12px',
  border: '1px solid rgba(255,255,255,0.10)',
  background: 'rgba(255,255,255,0.04)',
  color: '#94a3b8',
  outline: 'none',
  cursor: 'pointer',
  flexShrink: 0,
  transition: 'border-color 150ms, background 150ms',
};

export function IvrTopbar({
  state,
  dispatch,
  onSave,
  onPreviewXml,
  onDelete,
  isSaving,
  isDeleting,
}: IvrTopbarProps) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [dids, setDids] = useState<ApiDid[]>([]);

  // Fetch customers on mount
  useEffect(() => {
    listCustomers({ limit: 500 })
      .then((res) => setCustomers(res.items))
      .catch(() => {/* silently ignore — dropdowns will be empty */});
  }, []);

  // Fetch DIDs whenever customer changes
  useEffect(() => {
    if (!state.customerId) {
      setDids([]);
      return;
    }
    listApiDids({ customer_id: state.customerId, limit: 500 })
      .then((res) => setDids(res.items))
      .catch(() => setDids([]));
  }, [state.customerId]);

  return (
    <div
      role="toolbar"
      aria-label="IVR Builder controls"
      style={{
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        background: '#0f1117',
        flexShrink: 0,
      }}
    >
      {/* ── Row 1: name + customer/DID + actions ─────────── */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 20px',
          borderBottom: '1px solid rgba(255,255,255,0.04)',
        }}
      >
        {/* Flow name */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          {/* Cyan accent dot */}
          <div
            style={{
              width: 8,
              height: 8,
              borderRadius: '50%',
              flexShrink: 0,
              backgroundColor: '#06b6d4',
              boxShadow: '0 0 6px rgba(6,182,212,0.5)',
            }}
            aria-hidden="true"
          />
          <input
            type="text"
            value={state.name}
            onChange={(e) => dispatch({ type: 'SET_NAME', name: e.target.value })}
            placeholder="Untitled Flow"
            aria-label="Flow name"
            style={{
              fontSize: '0.875rem',
              fontWeight: 700,
              background: 'transparent',
              outline: 'none',
              minWidth: 0,
              width: 160,
              color: '#e2e8f0',
              border: 'none',
              borderBottom: '1px solid transparent',
              paddingBottom: 1,
              transition: 'border-color 150ms',
            }}
            onFocus={(e) => { e.currentTarget.style.borderBottomColor = 'rgba(59,130,246,0.35)'; }}
            onBlur={(e) => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
          />
        </div>

        {/* Divider */}
        <div
          style={{ width: 1, height: 20, flexShrink: 0, background: 'rgba(255,255,255,0.06)' }}
          aria-hidden="true"
        />

        {/* Customer dropdown — pill style with custom chevron */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <select
            style={{ ...pillBase, appearance: 'none', paddingRight: 26 }}
            value={state.customerId ?? ''}
            aria-label="Select customer"
            onChange={(e) => {
              const val = e.target.value;
              dispatch({ type: 'SET_CUSTOMER', customerId: val ? Number(val) : null });
            }}
          >
            <option value="">Customer...</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
          {/* Custom chevron */}
          <svg
            style={{
              pointerEvents: 'none',
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
            }}
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            aria-hidden="true"
          >
            <path d="M2 3.5L5 6.5L8 3.5" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>

        {/* DID dropdown — pill style with custom chevron */}
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <select
            style={{
              ...pillBase,
              appearance: 'none',
              paddingRight: 26,
              opacity: !state.customerId ? 0.4 : 1,
              cursor: !state.customerId ? 'not-allowed' : 'pointer',
            }}
            value={state.did ?? ''}
            disabled={!state.customerId}
            aria-label="Select DID"
            onChange={(e) => {
              dispatch({ type: 'SET_DID', did: e.target.value || null });
            }}
          >
            <option value="">DID...</option>
            {dids.map((d) => (
              <option key={d.id} value={d.did}>{d.did}</option>
            ))}
          </select>
          <svg
            style={{
              pointerEvents: 'none',
              position: 'absolute',
              right: 8,
              top: '50%',
              transform: 'translateY(-50%)',
            }}
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            aria-hidden="true"
          >
            <path d="M2 3.5L5 6.5L8 3.5" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>

        {/* Right-side actions */}
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {/* Preview XML — ghost/secondary pill */}
          <button
            type="button"
            onClick={onPreviewXml}
            style={{
              ...pillBase,
              background: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.10)',
              color: '#94a3b8',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.08)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.18)';
              e.currentTarget.style.color = '#cbd5e1';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
              e.currentTarget.style.borderColor = 'rgba(255,255,255,0.10)';
              e.currentTarget.style.color = '#94a3b8';
            }}
          >
            Preview XML
          </button>

          {/* Delete — danger pill, only shown when flow is persisted */}
          {state.id !== null && (
            <button
              type="button"
              disabled={isDeleting}
              onClick={onDelete}
              style={{
                ...pillBase,
                background: 'rgba(239,68,68,0.10)',
                border: '1px solid rgba(239,68,68,0.25)',
                color: '#f87171',
                opacity: isDeleting ? 0.4 : 1,
                cursor: isDeleting ? 'not-allowed' : 'pointer',
              }}
              onMouseEnter={(e) => {
                if (!isDeleting) {
                  e.currentTarget.style.background = 'rgba(239,68,68,0.18)';
                  e.currentTarget.style.borderColor = 'rgba(239,68,68,0.40)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'rgba(239,68,68,0.10)';
                e.currentTarget.style.borderColor = 'rgba(239,68,68,0.25)';
              }}
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </button>
          )}

          {/* Divider */}
          <div
            style={{ width: 1, height: 20, flexShrink: 0, background: 'rgba(255,255,255,0.06)' }}
            aria-hidden="true"
          />

          {/* Save — primary pill CTA, mirrors sidebar "New" button */}
          <button
            type="button"
            disabled={isSaving}
            onClick={onSave}
            style={{
              ...pillBase,
              background: 'rgba(59,130,246,0.15)',
              border: '1px solid rgba(59,130,246,0.30)',
              color: '#60a5fa',
              opacity: isSaving ? 0.5 : 1,
              cursor: isSaving ? 'not-allowed' : 'pointer',
            }}
            onMouseEnter={(e) => {
              if (!isSaving) {
                e.currentTarget.style.background = 'rgba(59,130,246,0.22)';
                e.currentTarget.style.borderColor = 'rgba(59,130,246,0.45)';
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'rgba(59,130,246,0.15)';
              e.currentTarget.style.borderColor = 'rgba(59,130,246,0.30)';
            }}
          >
            {isSaving ? 'Saving...' : 'Save Flow'}
          </button>
        </div>
      </div>

      {/* ── Row 2: verb palette toolbar ───────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', padding: '7px 20px' }}>
        <IvrPalette />
      </div>
    </div>
  );
}
