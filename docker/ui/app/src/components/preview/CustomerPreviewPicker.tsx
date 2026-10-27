/**
 * CustomerPreviewPicker — the "which customer am I previewing?" picker an
 * admin uses in "View as Customer" mode. Rendered in the sidebar's amber
 * customer-view banner (`tone="dark"`) and on customer pages that need a
 * pick before they can show anything (`tone="light"`, PreviewPrompt).
 *
 * The shared AdminCustomerPicker (themed Select, searchable, account type
 * on each row) — with NO "All customers": previewing shows the app exactly
 * as ONE customer sees it, so there is no "all" to preview. Keep it that
 * way (docker/ui/CLAUDE.md §8 "Admin customer pickers").
 *
 * Choosing a customer sets AuthContext.previewCustomer; every customer page
 * keys on that id, so it remounts on the new account.
 */
import { useId } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { AdminCustomerPicker } from '../AdminCustomerPicker';
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
  const pickerId = useId();

  return (
    <div className={`cvp cvp--${tone}`}>
      <label className="cvp-label" htmlFor={pickerId}>
        {label}
      </label>
      <AdminCustomerPicker
        id={pickerId}
        className="cvp-select"
        // One customer at a time — never "All customers" (see the header).
        includeAll={false}
        searchable
        value={previewCustomer?.id ?? null}
        // The current pick keeps its name even before (or without) the list.
        valueLabel={previewCustomer?.name}
        onChange={(next) => {
          if (next === 'all') return;
          const picked = customers.find((c) => c.id === next);
          if (picked) setPreviewCustomer(toEffectiveCustomer(picked));
        }}
        customers={customers}
        loading={isLoading}
        error={isError}
        placeholder={isLoading ? 'Loading customers…' : isError ? 'Customers couldn’t load' : 'Pick a customer…'}
        disabled={isLoading && !previewCustomer}
      />
    </div>
  );
}
