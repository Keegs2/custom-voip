/**
 * AdminScopeSelect — the "Viewing" dropdown that sits in the granite header
 * of the admin dashboard and the admin /rcf console:
 *
 *   VIEWING  [ All customers ▾ ]
 *
 * A native <select> (keyboard, screen readers and phone pickers for free),
 * dressed as dark glass on the granite with the azure-bright focus ring.
 * `value` null shows a disabled placeholder (the console opens empty until
 * the admin picks a scope); the dashboard always has a value.
 */
import { useId } from 'react';
import type { CustomerRow } from './adminData';

export type AdminScopeValue = number | 'all' | null;

const TYPE_WORD: Record<CustomerRow['account_type'], string> = {
  rcf: 'RCF',
  api: 'API',
  trunk: 'SIP Trunking',
  hybrid: 'Hybrid',
  ucaas: 'UCaaS',
};

export interface AdminScopeSelectProps {
  value: AdminScopeValue;
  onChange: (next: number | 'all') => void;
  customers: readonly CustomerRow[];
  loading: boolean;
  error: boolean;
  /** Offer "All customers" (default true). */
  allowAll?: boolean;
  /** Placeholder while `value` is null. */
  placeholder?: string;
}

export function AdminScopeSelect({
  value,
  onChange,
  customers,
  loading,
  error,
  allowAll = true,
  placeholder = 'Select a customer…',
}: AdminScopeSelectProps) {
  const id = useId();
  const selected = value === null ? '' : String(value);
  // Keep a deep-linked id selectable before (or without) the list.
  const listed = typeof value !== 'number' || customers.some((c) => c.id === value);

  return (
    <div className="ad-scope-pick">
      <label className="ad-scope-label" htmlFor={id}>
        Viewing
      </label>
      <span className="ad-scope-field">
        <select
          id={id}
          className="ad-scope-select"
          value={selected}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'all') onChange('all');
            else if (/^\d+$/.test(v)) onChange(Number(v));
          }}
        >
          {value === null && (
            <option value="" disabled>
              {loading ? 'Loading customers…' : placeholder}
            </option>
          )}
          {allowAll && <option value="all">All customers</option>}
          {!listed && typeof value === 'number' && <option value={value}>{`Customer #${value}`}</option>}
          {customers.length > 0 && (
            <optgroup label={error ? 'Customers (list unavailable)' : 'Customers'}>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.account_type === 'rcf' ? c.name : `${c.name} · ${TYPE_WORD[c.account_type] ?? c.account_type}`}
                  {c.status !== 'active' ? ` (${c.status})` : ''}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <svg className="ad-scope-caret" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
    </div>
  );
}
