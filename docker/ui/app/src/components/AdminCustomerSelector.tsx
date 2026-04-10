/**
 * Customer selector dropdown for admin users on portal pages.
 * Allows admins to view data for "All Customers" or a specific customer.
 * Non-admin users never see this component.
 */

import { useQuery } from '@tanstack/react-query';
import { listCustomers } from '../api/customers';
import { useAuth } from '../contexts/AuthContext';

interface AdminCustomerSelectorProps {
  selectedCustomerId: number | undefined;
  onSelect: (customerId: number | undefined) => void;
  /** Optional accent color for the border highlight */
  accent?: string;
  /** Only show customers with these account types. If omitted, show all. */
  accountTypes?: string[];
}

export function AdminCustomerSelector({ selectedCustomerId, onSelect, accent = '#3b82f6', accountTypes }: AdminCustomerSelectorProps) {
  const { isAdmin } = useAuth();

  const { data } = useQuery({
    queryKey: ['customers-dropdown'],
    queryFn: () => listCustomers({ limit: 500 }),
    enabled: isAdmin,
    staleTime: 60_000,
  });

  if (!isAdmin) return null;

  const allCustomers = data?.items ?? [];
  const customers = accountTypes
    ? allCustomers.filter((c) => accountTypes.includes(c.account_type))
    : allCustomers;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        marginBottom: 24,
      }}
    >
      <label
        style={{
          fontSize: '0.75rem',
          fontWeight: 600,
          color: '#718096',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        Viewing
      </label>
      <select
        value={selectedCustomerId ?? ''}
        onChange={(e) => onSelect(e.target.value ? Number(e.target.value) : undefined)}
        style={{
          fontSize: '0.85rem',
          padding: '8px 14px',
          borderRadius: 8,
          border: `1px solid ${selectedCustomerId ? accent + '50' : 'rgba(42,47,69,0.7)'}`,
          background: '#0d0f15',
          color: '#e2e8f0',
          outline: 'none',
          minWidth: 240,
          transition: 'border-color 0.15s',
          cursor: 'pointer',
        }}
        onFocus={(e) => { e.currentTarget.style.borderColor = accent; }}
        onBlur={(e) => { e.currentTarget.style.borderColor = selectedCustomerId ? accent + '50' : 'rgba(42,47,69,0.7)'; }}
      >
        <option value="">All Customers</option>
        {customers.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} ({c.account_type.toUpperCase()})
          </option>
        ))}
      </select>
      {selectedCustomerId && (
        <button
          type="button"
          onClick={() => onSelect(undefined)}
          style={{
            fontSize: '0.72rem',
            color: '#718096',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            textDecoration: 'underline',
            padding: 0,
          }}
        >
          Clear
        </button>
      )}
    </div>
  );
}
