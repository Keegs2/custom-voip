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

  const selectClass = cn(
    'text-xs bg-[rgba(255,255,255,0.04)] border border-[rgba(255,255,255,0.08)] text-[#94a3b8] rounded-lg px-2.5 py-1.5',
    'outline-none transition-[border-color] duration-150',
    'focus:border-[rgba(59,130,246,0.4)] cursor-pointer',
  );

  const ghostBtnClass = cn(
    'text-xs px-3 py-1.5 rounded-lg border border-[rgba(255,255,255,0.08)] text-[#64748b]',
    'hover:text-[#e2e8f0] hover:border-[rgba(255,255,255,0.14)] hover:bg-[rgba(255,255,255,0.04)]',
    'transition-all duration-150 font-semibold flex-shrink-0',
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
              'text-sm font-bold bg-transparent border-none outline-none min-w-0',
              'text-[#e2e8f0] placeholder:text-[#334155] focus:ring-0 w-[160px]',
            )}
          />
        </div>

        {/* Divider */}
        <div className="w-px h-5 flex-shrink-0" style={{ background: 'rgba(255,255,255,0.06)' }} aria-hidden="true" />

        {/* Customer dropdown */}
        <select
          className={selectClass}
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

        {/* DID dropdown */}
        <select
          className={selectClass}
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

        {/* Right-side actions */}
        <div className="ml-auto flex items-center gap-2">
          <button type="button" onClick={onPreviewXml} className={ghostBtnClass}>
            Preview XML
          </button>

          {/* Delete — only show when flow is saved */}
          {state.id !== null && (
            <button
              type="button"
              disabled={isDeleting}
              onClick={onDelete}
              className={cn(
                'text-xs px-3 py-1.5 rounded-lg font-semibold transition-all duration-150 flex-shrink-0',
                'border border-[rgba(239,68,68,0.22)] text-[#f87171]',
                'hover:bg-[rgba(239,68,68,0.08)] hover:border-[rgba(239,68,68,0.35)]',
                'disabled:opacity-40 disabled:cursor-not-allowed',
              )}
            >
              {isDeleting ? 'Deleting...' : 'Delete'}
            </button>
          )}

          {/* Divider */}
          <div className="w-px h-5 flex-shrink-0" style={{ background: 'rgba(255,255,255,0.06)' }} aria-hidden="true" />

          {/* Save — primary CTA */}
          <button
            type="button"
            disabled={isSaving}
            onClick={onSave}
            className={cn(
              'text-xs px-4 py-1.5 rounded-lg font-semibold transition-all duration-150 flex-shrink-0',
              'bg-[#3b82f6] text-white shadow-[0_0_12px_rgba(59,130,246,0.25)]',
              'hover:bg-[#2563eb] hover:shadow-[0_0_20px_rgba(59,130,246,0.40)]',
              'disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none',
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
