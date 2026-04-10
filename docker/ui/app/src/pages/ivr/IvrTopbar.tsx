/**
 * IVR Builder — Top Bar
 *
 * Contains flow name input, customer/DID dropdowns, and action buttons.
 * Customer dropdown fetches from /customers; DID dropdown is filtered by customer.
 */

import { useState, useEffect } from 'react';
import { cn } from '../../utils/cn';
import { listCustomers } from '../../api/customers';
import { listApiDids } from '../../api/apiDids';
import type { Customer } from '../../types/customer';
import type { ApiDid } from '../../types/apiDid';
import type { IvrAction, IvrFlowState } from './useIvrFlow';

interface IvrTopbarProps {
  state: IvrFlowState;
  dispatch: React.Dispatch<IvrAction>;
  onSave: () => void;
  onLoad: () => void;
  onPreviewXml: () => void;
  onNew: () => void;
  isSaving: boolean;
  onBack: () => void;
}

export function IvrTopbar({
  state,
  dispatch,
  onSave,
  onLoad,
  onPreviewXml,
  onNew,
  isSaving,
  onBack,
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
    'text-sm bg-[#0d0f15] border border-[rgba(42,47,69,0.6)] text-[#e2e8f0] rounded-lg px-3 py-2',
    'outline-none transition-[border-color,box-shadow] duration-150',
    'focus:border-[#06b6d4] focus:shadow-[0_0_0_3px_rgba(6,182,212,0.15)]',
    'cursor-pointer',
  );

  const ghostButtonClass = cn(
    'text-xs px-3 py-2 rounded-lg border border-[rgba(42,47,69,0.7)] text-[#718096]',
    'hover:text-[#e2e8f0] hover:border-[rgba(42,47,69,1)] hover:bg-[rgba(42,47,69,0.25)]',
    'transition-all duration-150 font-semibold flex-shrink-0',
  );

  return (
    <div
      role="toolbar"
      aria-label="IVR Builder controls"
      className="flex items-center gap-3 flex-shrink-0"
      style={{
        padding: '14px 24px',
        background: 'linear-gradient(135deg, rgba(30,33,48,0.95) 0%, rgba(19,21,29,0.98) 100%)',
        borderBottom: '1px solid rgba(42,47,69,0.6)',
        boxShadow: '0 1px 0 rgba(0,0,0,0.3)',
      }}
    >
      {/* Back button */}
      <button
        type="button"
        onClick={onBack}
        aria-label="Go back"
        className={cn(
          'flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-semibold flex-shrink-0',
          'text-[#718096] border border-[rgba(42,47,69,0.7)]',
          'hover:text-[#e2e8f0] hover:border-[rgba(42,47,69,1)] hover:bg-[rgba(42,47,69,0.25)]',
          'transition-all duration-150',
        )}
      >
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 13, height: 13 }} aria-hidden="true">
          <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        Back
      </button>

      {/* Divider */}
      <div className="w-px h-6 bg-[rgba(42,47,69,0.8)] flex-shrink-0" aria-hidden="true" />

      {/* IVR accent dot + Flow name */}
      <div className="flex items-center gap-2 flex-shrink-0">
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
            'text-[0.9rem] font-bold bg-transparent border-none outline-none',
            'text-[#e2e8f0] placeholder:text-[#3d4460] w-[180px] focus:ring-0',
          )}
        />
      </div>

      {/* Divider */}
      <div className="w-px h-6 bg-[rgba(42,47,69,0.8)] flex-shrink-0" aria-hidden="true" />

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
        <button type="button" onClick={onNew} className={ghostButtonClass}>
          New
        </button>
        <button type="button" onClick={onLoad} className={ghostButtonClass}>
          Load
        </button>
        <button type="button" onClick={onPreviewXml} className={ghostButtonClass}>
          Preview XML
        </button>

        {/* Divider before primary action */}
        <div className="w-px h-5 bg-[rgba(42,47,69,0.8)] mx-1 flex-shrink-0" aria-hidden="true" />

        <button
          type="button"
          disabled={isSaving}
          onClick={onSave}
          className={cn(
            'text-xs px-4 py-2 rounded-lg font-semibold transition-all duration-150 flex-shrink-0',
            'bg-[#06b6d4] text-[#0a1628] shadow-[0_0_14px_rgba(6,182,212,0.28)]',
            'hover:bg-[#0891b2] hover:shadow-[0_0_22px_rgba(6,182,212,0.45)]',
            'disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none',
          )}
        >
          {isSaving ? 'Saving...' : 'Save Flow'}
        </button>
      </div>
    </div>
  );
}
