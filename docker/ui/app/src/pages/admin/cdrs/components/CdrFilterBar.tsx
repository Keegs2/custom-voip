/**
 * CDR search filter bar — glassified. Drives the draft filter state and emits
 * search / export. Pure presentation aside from the customer-options query.
 */

import { Button } from '../../../../components/ui/Button';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import { useCustomerOptions } from '../hooks';
import { filterLabel, filterControl, filterSelect, checkboxLabel } from '../styles';
import type { CdrFilters } from '../types';

interface CdrFilterBarProps {
  filters: CdrFilters;
  onChange: (filters: CdrFilters) => void;
  onSearch: () => void;
  onExport: () => void;
  searching: boolean;
}

export function CdrFilterBar({ filters, onChange, onSearch, onExport, searching }: CdrFilterBarProps) {
  const customers = useCustomerOptions();

  function set<K extends keyof CdrFilters>(key: K, value: CdrFilters[K]) {
    onChange({ ...filters, [key]: value });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSearch();
  }

  return (
    <GlassPanel padding="24px 28px">
      <form onSubmit={handleSubmit}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-end' }}>
          {/* Customer */}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 180 }}>
            <label style={filterLabel}>Customer</label>
            <select style={filterSelect} value={filters.customer_id} onChange={(e) => set('customer_id', e.target.value)}>
              <option value="">All Customers</option>
              {customers.map((c) => (
                <option key={c.id} value={String(c.id)}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Product type */}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 110 }}>
            <label style={filterLabel}>Product</label>
            <select style={filterSelect} value={filters.product_type} onChange={(e) => set('product_type', e.target.value)}>
              <option value="">All</option>
              <option value="rcf">RCF</option>
              <option value="api">API</option>
              <option value="trunk">Trunk</option>
            </select>
          </div>

          {/* Direction */}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 110 }}>
            <label style={filterLabel}>Direction</label>
            <select style={filterSelect} value={filters.direction} onChange={(e) => set('direction', e.target.value)}>
              <option value="">All</option>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
            </select>
          </div>

          {/* SBC */}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 130 }}>
            <label style={filterLabel}>SBC</label>
            <select style={filterSelect} value={filters.sbc_id} onChange={(e) => set('sbc_id', e.target.value)}>
              <option value="">All SBCs</option>
              <option value="east-sbc-1">east-sbc-1</option>
              <option value="east-sbc-2">east-sbc-2</option>
            </select>
          </div>

          {/* Start date */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <label style={filterLabel}>Start</label>
            <input type="datetime-local" style={filterControl} value={filters.start_from} onChange={(e) => set('start_from', e.target.value)} />
          </div>

          {/* End date */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <label style={filterLabel}>End</label>
            <input type="datetime-local" style={filterControl} value={filters.start_to} onChange={(e) => set('start_to', e.target.value)} />
          </div>

          {/* Destination prefix */}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 150 }}>
            <label style={filterLabel}>Destination Prefix</label>
            <input type="text" style={filterControl} placeholder="e.g. 1800" value={filters.destination} onChange={(e) => set('destination', e.target.value)} />
          </div>

          {/* Rated only */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
            <label style={checkboxLabel}>
              <input
                type="checkbox"
                style={{ width: 16, height: 16, borderRadius: 4, accentColor: GLASS.accent, cursor: 'pointer' }}
                checked={filters.rated_only}
                onChange={(e) => set('rated_only', e.target.checked)}
              />
              Rated only
            </label>
          </div>

          {/* Actions — pushed to end */}
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', marginLeft: 'auto', paddingLeft: 8 }}>
            <Button type="submit" variant="primary" size="sm" loading={searching}>Search</Button>
            <Button type="button" variant="ghost" size="sm" onClick={onExport}>Export CSV</Button>
          </div>
        </div>
      </form>
    </GlassPanel>
  );
}
