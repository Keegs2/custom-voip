/**
 * CustomerPickerTable — the first state of the User Lookup page: a searchable,
 * paginated customer list. Selecting a customer drills into their user list.
 * The query lives in `useCustomerPickerData`; this component owns the search /
 * pagination UI state.
 *
 * React #310: all state + the query are declared at the top, before any return.
 */

import { useState } from 'react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { Badge } from '../../../../components/ui/Badge';
import { Spinner } from '../../../../components/ui/Spinner';
import type { Customer as PlatformCustomer } from '../../../../types/customer';
import { CUSTOMER_PAGE_SIZE } from '../types';
import { useCustomerPickerData } from '../hooks';
import { MONO, tableTd, tableTh, tableHeadRow, searchWrap, searchInput, ghostBtn, primaryBtn } from '../styles';
import { ErrorState } from './states';
import { IconSearch } from './icons';

const COL_COUNT = 7;

function accountTypeBadge(type: PlatformCustomer['account_type']) {
  return <Badge variant={type}>{type.toUpperCase()}</Badge>;
}
function statusBadge(status: PlatformCustomer['status']) {
  if (status === 'active') return <Badge variant="active">Active</Badge>;
  if (status === 'suspended') return <Badge variant="suspended">Suspended</Badge>;
  return <Badge variant="closed">Closed</Badge>;
}
function gradeBadge(grade: PlatformCustomer['traffic_grade']) {
  return <Badge variant={grade}>{grade}</Badge>;
}

interface CustomerPickerTableProps {
  onSelectCustomer: (customer: PlatformCustomer) => void;
}

export function CustomerPickerTable({ onSelectCustomer }: CustomerPickerTableProps) {
  const [offset, setOffset] = useState(0);
  const [search, setSearch] = useState('');
  const [committedSearch, setCommittedSearch] = useState('');
  const [focused, setFocused] = useState(false);

  const { data, isLoading, isError } = useCustomerPickerData(committedSearch, offset);

  function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setOffset(0);
    setCommittedSearch(search);
  }

  const items = data?.items ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Search toolbar */}
      <GlassPanel padding="14px 16px">
        <form onSubmit={handleSearch} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={searchWrap(focused)}>
            <span style={{ color: focused ? GLASS.accent : GLASS.textFaint, display: 'flex', alignItems: 'center', transition: 'color 0.18s' }}>
              <IconSearch />
            </span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Search customers…"
              style={searchInput}
            />
          </div>
          <button type="submit" style={{ ...ghostBtn(), flexShrink: 0 }}>Search</button>
        </form>
      </GlassPanel>

      {/* Loading */}
      {isLoading && (
        <GlassPanel padding="24px">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: GLASS.textMuted, justifyContent: 'center' }}>
            <Spinner /> Loading customers…
          </div>
        </GlassPanel>
      )}

      {/* Error */}
      {isError && <ErrorState title="Failed to load customers" message="The request failed. Please try again." />}

      {/* Table */}
      {data && (
        <>
          <GlassPanel padding={0} blur={20}>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={tableHeadRow}>
                    {['ID', 'Name', 'Type', 'Balance', 'Status', 'Grade', 'Created'].map((col) => <th key={col} style={tableTh}>{col}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td colSpan={COL_COUNT} style={{ ...tableTd, padding: '48px 16px', textAlign: 'center', color: GLASS.textMuted }}>
                        No customers found.
                      </td>
                    </tr>
                  ) : (
                    items.map((customer) => (
                      <tr
                        key={customer.id}
                        onClick={() => onSelectCustomer(customer)}
                        style={{ transition: 'background 0.15s', cursor: 'pointer' }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.04)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      >
                        <td style={tableTd}><span style={{ color: GLASS.textMuted, fontFamily: MONO, fontSize: '0.78rem' }}>#{customer.id}</span></td>
                        <td style={tableTd}><span style={{ color: GLASS.text, fontWeight: 600, fontSize: '0.875rem' }}>{customer.name}</span></td>
                        <td style={tableTd}>{accountTypeBadge(customer.account_type)}</td>
                        <td style={tableTd}>
                          <span style={{ color: customer.balance < 0 ? '#f87171' : GLASS.text, fontVariantNumeric: 'tabular-nums', fontSize: '0.875rem', fontWeight: customer.balance < 0 ? 600 : 400 }}>
                            ${customer.balance.toFixed(2)}
                          </span>
                        </td>
                        <td style={tableTd}>{statusBadge(customer.status)}</td>
                        <td style={tableTd}>{gradeBadge(customer.traffic_grade)}</td>
                        <td style={{ ...tableTd, color: GLASS.textMuted, fontSize: '0.82rem' }}>
                          {customer.created_at ? new Date(customer.created_at).toLocaleDateString() : '--'}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </GlassPanel>

          {/* Load more */}
          {items.length + offset < (data.total ?? 0) && (
            <div style={{ textAlign: 'center', paddingBottom: 8 }}>
              <button
                type="button"
                onClick={() => setOffset((o) => o + CUSTOMER_PAGE_SIZE)}
                style={{ ...primaryBtn(false), background: hexToRgba(GLASS.accent, 0.12), color: '#60a5fa', boxShadow: 'none' }}
              >
                Load more
              </button>
              <span style={{ marginLeft: 12, fontSize: '0.78rem', color: GLASS.textMuted }}>
                Showing {items.length + offset} of {data.total ?? 0}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
