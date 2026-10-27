/**
 * AdminCustomerPicker — THE staff customer picker. Every admin page that is
 * about "one customer, or all of them" picks with this (docker/ui/CLAUDE.md
 * §8 "Admin customer pickers"):
 *
 *   [ All customers        ]   ← pinned (stays on top while searching), hairline under it
 *   ─────────────────────────
 *     Bay State Utilities     RCF
 *     Granite Telephony       Hybrid
 *     Old Mill Water          SIP Trunking · Suspended
 *
 * Built on the themed `Select` (components/ui/Select), so the menu reads
 * right in both themes and inside the forced-dark granite band. The page
 * keeps its own trigger look (`className` = the class its native select
 * had — the full skin) and its own visible label ("Viewing", "Customer"):
 * render `<label htmlFor={id}>` next to it.
 *
 * Value: `number | 'all' | null`. null shows the placeholder (the
 * prompt-first pages — RCF console, Voicemail, Reporting, IVR — open with
 * nothing chosen). `onChange` hands back a number or 'all'.
 *
 * Data: the caller passes the customers it already has (each page's own
 * subset — call forwarding customers on the dashboard, reportable ones on
 * Reporting — or `useAdminCustomers().data`). Anything with id / name /
 * account_type / status fits: CustomerRow and the raw `Customer` both do.
 *
 * Edge cases:
 *   - a deep-linked id that isn't in the list (`?customer=999`, or the
 *     list still loading) stays selectable as "Customer #999" (or
 *     `valueLabel` when the caller knows the name);
 *   - while the list loads the menu shows a "Loading…" row;
 *   - a failed list shows a disabled "Customers couldn't load" row, and
 *     All customers still works.
 *
 * `includeAll={false}` ONLY where "all" means nothing (e.g. choosing the
 * owner of a new mailbox). The sidebar's "View as Customer" picker is not
 * this component's job: previewing is always one customer.
 */
import { useMemo } from 'react';
import { Select, type SelectOption } from './ui/Select';
import type { AccountType, CustomerStatus } from '../types/customer';

export type AdminCustomerValue = number | 'all' | null;

/** The identity fields the picker reads (CustomerRow and Customer both fit). */
export interface PickerCustomer {
  id: number;
  name: string;
  account_type: AccountType;
  status: CustomerStatus;
}

/** The account-type word on each row ("SIP Trunking"). */
const ACCOUNT_TYPE_WORD: Readonly<Record<AccountType, string>> = {
  rcf: 'RCF',
  api: 'API',
  trunk: 'SIP Trunking',
  hybrid: 'Hybrid',
  ucaas: 'UCaaS',
};

const STATUS_WORD: Readonly<Record<CustomerStatus, string>> = {
  active: 'Active',
  suspended: 'Suspended',
  closed: 'Closed',
};

/** "SIP Trunking", or "SIP Trunking · Suspended" when the account isn't active. */
function customerHint(c: Pick<PickerCustomer, 'account_type' | 'status'>): string {
  const type = ACCOUNT_TYPE_WORD[c.account_type] ?? c.account_type;
  return c.status === 'active' ? type : `${type} · ${STATUS_WORD[c.status] ?? c.status}`;
}

const ALL_VALUE = 'all';
/** A disabled row's value — never a customer id, never 'all'. */
const UNAVAILABLE_VALUE = 'unavailable';

const ALL_OPTION: SelectOption<string> = { value: ALL_VALUE, label: 'All customers', pinned: true, divider: true };

/** Case-insensitive by name, then id — a stable order for equal names. */
function byName(a: PickerCustomer, b: PickerCustomer): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id;
}

export interface AdminCustomerPickerProps {
  value: AdminCustomerValue;
  onChange: (next: number | 'all') => void;
  /** undefined while the list hasn't arrived. Sorted here — any order is fine. */
  customers: readonly PickerCustomer[] | undefined;
  /** The list is loading — a "Loading…" row in the menu. */
  loading?: boolean;
  /** The list failed — a disabled "Customers couldn't load" row (All customers still works). */
  error?: boolean;
  /** "All customers" pinned on top (default true). */
  includeAll?: boolean;
  /** Shown while `value` is null. */
  placeholder?: string;
  /** Trigger label for a `value` that isn't in `customers` (default "Customer #<id>"). */
  valueLabel?: string;
  /** Trigger id, for the page's own `<label htmlFor>`. */
  id?: string;
  /** TRIGGER class — the page's full field skin (see Select's `className`). */
  className?: string;
  menuClassName?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  disabled?: boolean;
  title?: string;
  /** Default 'auto' (a search box above 10 rows). */
  searchable?: boolean | 'auto';
  menuMinWidth?: number;
  align?: 'start' | 'end';
}

export function AdminCustomerPicker({
  value,
  onChange,
  customers,
  loading = false,
  error = false,
  includeAll = true,
  placeholder = 'Select a customer…',
  valueLabel,
  id,
  className,
  menuClassName,
  disabled,
  title,
  searchable = 'auto',
  menuMinWidth,
  align,
  ...aria
}: AdminCustomerPickerProps) {
  const sorted = useMemo(() => [...(customers ?? [])].sort(byName), [customers]);

  const options = useMemo<SelectOption<string>[]>(() => {
    const out: SelectOption<string>[] = [];
    if (includeAll) out.push(ALL_OPTION);
    // Keep a deep-linked (or not-yet-loaded) id selectable, so the trigger never goes blank.
    if (typeof value === 'number' && !sorted.some((c) => c.id === value)) {
      out.push({ value: String(value), label: valueLabel || `Customer #${value}`, keywords: String(value) });
    }
    if (error && sorted.length === 0) {
      out.push({ value: UNAVAILABLE_VALUE, label: 'Customers couldn’t load', disabled: true });
    }
    for (const c of sorted) {
      out.push({ value: String(c.id), label: c.name, hint: customerHint(c), keywords: String(c.id) });
    }
    return out;
  }, [includeAll, value, valueLabel, error, sorted]);

  const selected = value === null || (value === 'all' && !includeAll) ? '' : String(value);

  return (
    <Select<string>
      id={id}
      className={className}
      menuClassName={menuClassName}
      value={selected}
      onChange={(v) => {
        if (v === ALL_VALUE) onChange('all');
        else if (/^\d+$/.test(v)) onChange(Number(v));
      }}
      options={options}
      placeholder={placeholder}
      searchable={searchable}
      searchPlaceholder="Search customers…"
      emptyText="No customers match"
      loading={loading}
      disabled={disabled}
      title={title}
      menuMinWidth={menuMinWidth}
      align={align}
      aria-label={aria['aria-label']}
      aria-labelledby={aria['aria-labelledby']}
      aria-describedby={aria['aria-describedby']}
    />
  );
}
