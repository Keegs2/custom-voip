/**
 * CustomerPreviewPicker — the "which customer am I previewing?" select an
 * admin uses in "View as Customer" mode. Rendered in the sidebar's amber
 * customer-view banner (`tone="dark"`) and on customer pages that need a
 * pick before they can show anything (`tone="light"`).
 *
 * Choosing a customer sets AuthContext.previewCustomer; every customer page
 * keys on that id, so it remounts on the new account.
 */
import { useId } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { toEffectiveCustomer, usePreviewCustomers } from './usePreviewCustomers';

export interface CustomerPreviewPickerProps {
  tone: 'dark' | 'light';
  /** Visible label text (always present for assistive tech). */
  label?: string;
}

export function CustomerPreviewPicker({ tone, label = 'Previewing' }: CustomerPreviewPickerProps) {
  // ALL hooks unconditionally at the top (React #310).
  const { previewCustomer, setPreviewCustomer } = useAuth();
  const { customers, isLoading, isError } = usePreviewCustomers();
  const selectId = useId();

  const value = previewCustomer ? String(previewCustomer.id) : '';
  // Keep the current pick selectable even before the list arrives.
  const listed = previewCustomer ? customers.some((c) => c.id === previewCustomer.id) : true;

  return (
    <div className={`cvp cvp--${tone}`}>
      <label className="cvp-label" htmlFor={selectId}>{label}</label>
      <select
        id={selectId}
        className="cvp-select"
        value={value}
        disabled={isLoading && !previewCustomer}
        onChange={(e) => {
          const next = customers.find((c) => String(c.id) === e.target.value);
          if (next) setPreviewCustomer(toEffectiveCustomer(next));
        }}
      >
        {!previewCustomer && (
          <option value="" disabled>
            {isLoading ? 'Loading customers…' : isError ? 'Customers couldn’t load' : 'Pick a customer…'}
          </option>
        )}
        {previewCustomer && !listed && <option value={value}>{previewCustomer.name}</option>}
        {customers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
    </div>
  );
}
