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
    'text-sm bg-[#1e2130] border border-[#2a2f45] text-[#e2e8f0] rounded-lg px-3 py-1.5',
    'outline-none transition-[border-color,box-shadow] duration-150',
    'focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.18)]',
    'cursor-pointer',
  );

  return (
    <div
      className="flex items-center gap-3 px-4 bg-[#0d0f15] border-b border-[#2a2f45] flex-shrink-0"
      style={{ height: '56px' }}
      role="toolbar"
      aria-label="IVR Builder controls"
    >
      {/* Back button */}
      <button
        type="button"
        onClick={onBack}
        className="text-[#718096] hover:text-[#e2e8f0] transition-colors text-sm flex items-center gap-1 flex-shrink-0"
        aria-label="Go back"
      >
        ← Back
      </button>

      {/* Divider */}
      <div className="w-px h-6 bg-[#2a2f45] flex-shrink-0" aria-hidden="true" />

      {/* Flow name */}
      <input
        type="text"
        value={state.name}
        onChange={(e) => dispatch({ type: 'SET_NAME', name: e.target.value })}
        placeholder="Flow name..."
        aria-label="Flow name"
        className={cn(
          'text-sm font-semibold bg-transparent border-none outline-none text-[#e2e8f0]',
          'placeholder:text-[#3d4460] w-[160px] focus:ring-0',
        )}
      />

      {/* Divider */}
      <div className="w-px h-6 bg-[#2a2f45] flex-shrink-0" aria-hidden="true" />

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
        <button
          type="button"
          onClick={onNew}
          className="text-xs px-3 py-1.5 rounded-lg border border-[#2a2f45] text-[#718096] hover:text-[#e2e8f0] hover:border-[#3d4460] transition-colors font-semibold"
        >
          New
        </button>
        <button
          type="button"
          onClick={onLoad}
          className="text-xs px-3 py-1.5 rounded-lg border border-[#2a2f45] text-[#718096] hover:text-[#e2e8f0] hover:border-[#3d4460] transition-colors font-semibold"
        >
          Load
        </button>
        <button
          type="button"
          onClick={onPreviewXml}
          className="text-xs px-3 py-1.5 rounded-lg border border-[#2a2f45] text-[#718096] hover:text-[#e2e8f0] hover:border-[#3d4460] transition-colors font-semibold"
        >
          Preview XML
        </button>
        <button
          type="button"
          disabled={isSaving}
          onClick={onSave}
          className={cn(
            'text-xs px-4 py-1.5 rounded-lg font-semibold transition-all duration-150',
            'bg-[#3b82f6] text-white shadow-[0_0_10px_rgba(59,130,246,0.22)]',
            'hover:bg-[#2563eb] hover:shadow-[0_0_18px_rgba(59,130,246,0.4)]',
            'disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none',
          )}
        >
          {isSaving ? 'Saving...' : 'Save Flow'}
        </button>
      </div>
    </div>
  );
}
