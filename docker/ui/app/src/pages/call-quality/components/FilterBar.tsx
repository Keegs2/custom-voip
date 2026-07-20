/**
 * FilterBar — the customer / trunk / number / date / direction / product-type
 * filter strip inside a frosted glass panel, with Search + Reset actions.
 *
 * Stateless apart from per-field focus + reset-hover (purely visual). All filter
 * values + the apply/reset actions are owned by the page.
 */

import { useState } from 'react';
import { GlassPanel } from '../../../components/glass/GlassCard';
import type { Customer } from '../../../types/customer';
import type { Trunk } from '../../../types/trunk';
import type { CallDirection, ProductType } from '../../../types/cdr';
import type { FilterState } from '../types';
import { PillSelector } from './PillSelector';
import { IconSearchSmall } from './icons';
import {
  sectionLabel,
  fieldLabel,
  inputStyle,
  selectStyle,
  primaryBtn,
  ghostBtn,
  spinnerRing,
} from '../styles';

interface FilterBarProps {
  filters: FilterState;
  onPatch: (patch: Partial<FilterState>) => void;
  customers: Customer[];
  trunks: Trunk[];
  isLoading: boolean;
  onSearch: () => void;
  onReset: () => void;
  loadedCount?: number;
  total?: number;
}

export function FilterBar({ filters, onPatch, customers, trunks, isLoading, onSearch, onReset, loadedCount, total }: FilterBarProps) {
  const [focused, setFocused] = useState<string | null>(null);
  const [resetHover, setResetHover] = useState(false);

  const isFocused = (k: string) => focused === k;

  return (
    <GlassPanel padding="24px">
      <div style={{ ...sectionLabel(), marginBottom: 18 }}>Filters</div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 16, marginBottom: 18 }}>
        {/* Customer */}
        <div>
          <label style={fieldLabel}>Customer</label>
          <select
            value={filters.customerId ?? ''}
            onChange={(e) => onPatch({ customerId: e.target.value ? Number(e.target.value) : null })}
            onFocus={() => setFocused('customer')}
            onBlur={() => setFocused(null)}
            style={selectStyle(isFocused('customer'))}
          >
            <option value="">All Customers</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        {/* Trunk */}
        <div>
          <label style={fieldLabel}>Trunk</label>
          <select
            value={filters.trunkId ?? ''}
            onChange={(e) => onPatch({ trunkId: e.target.value ? Number(e.target.value) : null })}
            onFocus={() => setFocused('trunk')}
            onBlur={() => setFocused(null)}
            style={selectStyle(isFocused('trunk'))}
          >
            <option value="">All Trunks</option>
            {trunks.map((t) => (
              <option key={t.id} value={t.id}>{t.trunk_name}</option>
            ))}
          </select>
        </div>

        {/* Number / DID search */}
        <div>
          <label style={fieldLabel}>Number / DID</label>
          <input
            type="text"
            placeholder="e.g. +14155551234"
            value={filters.numberSearch}
            onChange={(e) => onPatch({ numberSearch: e.target.value })}
            onFocus={() => setFocused('number')}
            onBlur={() => setFocused(null)}
            style={inputStyle(isFocused('number'))}
          />
        </div>

        {/* Start Date */}
        <div>
          <label style={fieldLabel}>Start Date</label>
          <input
            type="date"
            value={filters.startDate}
            onChange={(e) => onPatch({ startDate: e.target.value })}
            onFocus={() => setFocused('start')}
            onBlur={() => setFocused(null)}
            style={inputStyle(isFocused('start'))}
          />
        </div>

        {/* End Date */}
        <div>
          <label style={fieldLabel}>End Date</label>
          <input
            type="date"
            value={filters.endDate}
            onChange={(e) => onPatch({ endDate: e.target.value })}
            onFocus={() => setFocused('end')}
            onBlur={() => setFocused(null)}
            style={inputStyle(isFocused('end'))}
          />
        </div>
      </div>

      {/* Direction + Product type pills */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 24, marginBottom: 20, alignItems: 'flex-start' }}>
        <div>
          <div style={fieldLabel}>Direction</div>
          <PillSelector<CallDirection | 'all'>
            options={[
              { value: 'all', label: 'All' },
              { value: 'inbound', label: 'Inbound' },
              { value: 'outbound', label: 'Outbound' },
            ]}
            value={filters.direction}
            onChange={(v) => onPatch({ direction: v })}
          />
        </div>
        <div>
          <div style={fieldLabel}>Product Type</div>
          <PillSelector<ProductType | 'all'>
            options={[
              { value: 'all', label: 'All' },
              { value: 'rcf', label: 'RCF' },
              { value: 'trunk', label: 'Trunk' },
              { value: 'api', label: 'API' },
            ]}
            value={filters.productType}
            onChange={(v) => onPatch({ productType: v })}
          />
        </div>
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" onClick={onSearch} disabled={isLoading} style={primaryBtn(isLoading)}>
          {isLoading ? <span style={spinnerRing()} /> : <IconSearchSmall />}
          {isLoading ? 'Loading…' : 'Search'}
        </button>
        <button
          type="button"
          onClick={onReset}
          onMouseEnter={() => setResetHover(true)}
          onMouseLeave={() => setResetHover(false)}
          style={ghostBtn(resetHover)}
        >
          Reset
        </button>
        {total != null && loadedCount != null && (
          <span style={{ fontSize: '0.72rem', color: '#94a3b8', marginLeft: 4 }}>
            {loadedCount.toLocaleString()} of {total.toLocaleString()} records
          </span>
        )}
      </div>
    </GlassPanel>
  );
}
