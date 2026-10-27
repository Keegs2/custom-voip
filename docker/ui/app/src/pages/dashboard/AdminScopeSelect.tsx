/**
 * AdminScopeSelect — the "Viewing" dropdown that sits in the granite header
 * of the admin dashboard and the admin /rcf console:
 *
 *   VIEWING  [ All customers ▾ ]
 *
 * The shared AdminCustomerPicker (themed Select: "All customers" pinned on
 * top, then every customer with its account type) wearing the band's dark
 * glass trigger (`.ad-scope-select`, account-dashboard.css). The band's
 * columns pin `data-force-theme="dark"`, and the menu carries that pin, so
 * it opens dark on the light theme too. `value` null shows the placeholder
 * (the console opens empty until the admin picks a scope); the dashboard
 * always has a value.
 */
import { useId } from 'react';
import { AdminCustomerPicker, type AdminCustomerValue, type PickerCustomer } from '../../components/AdminCustomerPicker';

export type AdminScopeValue = AdminCustomerValue;

export interface AdminScopeSelectProps {
  value: AdminScopeValue;
  onChange: (next: number | 'all') => void;
  customers: readonly PickerCustomer[];
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
  placeholder,
}: AdminScopeSelectProps) {
  const id = useId();
  return (
    <div className="ad-scope-pick">
      <label className="ad-scope-label" htmlFor={id}>
        Viewing
      </label>
      <span className="ad-scope-field">
        <AdminCustomerPicker
          id={id}
          className="ad-scope-select"
          value={value}
          onChange={onChange}
          customers={customers}
          loading={loading}
          error={error}
          includeAll={allowAll}
          placeholder={placeholder}
        />
      </span>
    </div>
  );
}
