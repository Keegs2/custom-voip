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
import { cn } from '../../utils/cn';
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

  // Pill-style select — matches the sidebar "New" button language but muted
  const selectClass = cn(
    'text-[0.75rem] font-semibold bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.10)]',
    'text-[#94a3b8] rounded-[7px] px-3 py-[5px] h-[30px]',
    'outline-none transition-[border-color,background] duration-150 cursor-pointer',
    'focus:border-[rgba(59,130,246,0.40)] focus:bg-[rgba(59,130,246,0.06)]',
    'appearance-none',
    // Inline chevron via background SVG
    'bg-no-repeat bg-[right_8px_center] bg-[length:10px_10px]',
  );

  // Secondary / ghost pill — Preview XML
  const ghostBtnClass = cn(
    'text-[0.75rem] font-semibold px-3 py-[5px] h-[30px] rounded-[7px] flex-shrink-0',
    'bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.10)] text-[#94a3b8]',
    'hover:bg-[rgba(255,255,255,0.08)] hover:border-[rgba(255,255,255,0.18)] hover:text-[#cbd5e1]',
    'transition-all duration-150',
  );

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
        className="flex items-center gap-3"
        style={{ padding: '10px 20px', borderBottom: '1px solid rgba(255,255,255,0.04)' }}
      >
        {/* Flow name */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {/* Cyan accent dot */}
          <div
            className="w-2 h-2 rounded-full flex-shrink-0"
            style={{ backgroundColor: '#06b6d4', boxShadow: '0 0 6px rgba(6,182,212,0.5)' }}
            aria-hidden="true"
          />
          <input
            type="text"
            value={state.name}
            onChange={(e) => dispatch({ type: 'SET_NAME', name: e.target.value })}
            placeholder="Untitled Flow"
            aria-label="Flow name"
            className={cn(
              'text-sm font-bold bg-transparent outline-none min-w-0 w-[160px]',
              'text-[#e2e8f0] placeholder:text-[#334155] focus:ring-0',
              // Subtle bottom border — invisible on blur, accent on focus
              'border-b border-transparent focus:border-[rgba(59,130,246,0.35)]',
              'transition-[border-color] duration-150 pb-px',
            )}
          />
        </div>

        {/* Divider */}
        <div className="w-px h-5 flex-shrink-0" style={{ background: 'rgba(255,255,255,0.06)' }} aria-hidden="true" />

        {/* Customer dropdown — pill style with custom chevron */}
        <div className="relative flex-shrink-0">
          <select
            className={selectClass}
            style={{ paddingRight: '26px' }}
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
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2"
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            aria-hidden="true"
          >
            <path d="M2 3.5L5 6.5L8 3.5" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>

        {/* DID dropdown — pill style with custom chevron */}
        <div className="relative flex-shrink-0">
          <select
            className={selectClass}
            style={{ paddingRight: '26px' }}
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
            className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2"
            width="10" height="10" viewBox="0 0 10 10" fill="none"
            aria-hidden="true"
          >
            <path d="M2 3.5L5 6.5L8 3.5" stroke="#64748b" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </div>

        {/* Right-side actions */}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onPreviewXml} className={ghostBtnClass}>
            Preview XML
          </button>

          {/* Delete — danger pill, only shown when flow is persisted */}
          {state.id !== null && (
            <button
              type="button"
              disabled={isDeleting}
              onClick={onDelete}
              className={cn(
                'text-[0.75rem] font-semibold px-3 py-[5px] h-[30px] rounded-[7px] flex-shrink-0',
                'bg-[rgba(239,68,68,0.10)] border border-[rgba(239,68,68,0.25)] text-[#f87171]',
                'hover:bg-[rgba(239,68,68,0.18)] hover:border-[rgba(239,68,68,0.40)]',
                'transition-all duration-150',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </button>
          )}

          {/* Divider */}
          <div className="w-px h-5 flex-shrink-0" style={{ background: 'rgba(255,255,255,0.06)' }} aria-hidden="true" />

          {/* Save — primary pill CTA, mirrors sidebar "New" button */}
          <button
            type="button"
            disabled={isSaving}
            onClick={onSave}
            className={cn(
              'text-[0.75rem] font-semibold px-3 py-[5px] h-[30px] rounded-[7px] flex-shrink-0',
              'bg-[rgba(59,130,246,0.15)] border border-[rgba(59,130,246,0.30)] text-[#60a5fa]',
              'hover:bg-[rgba(59,130,246,0.22)] hover:border-[rgba(59,130,246,0.45)]',
              'transition-all duration-150',
              'disabled:opacity-50 disabled:cursor-not-allowed',
            )}
          >
            {isSaving ? 'Saving...' : 'Save Flow'}
          </button>
        </div>
      </div>

      {/* ── Row 2: verb palette toolbar ───────────────────── */}
      <div
        className="flex items-center"
        style={{ padding: '7px 20px' }}
      >
        <IvrPalette />
      </div>
    </div>
  );
}
