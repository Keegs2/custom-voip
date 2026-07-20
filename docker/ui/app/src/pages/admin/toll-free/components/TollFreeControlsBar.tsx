/**
 * TollFreeControlsBar — the inventory toolbar inside a glass panel: title +
 * import action, a server-side search/filter row (committed on "Search"), and a
 * selection bar for bulk carrier reassignment. Search focus is the only local
 * (visual) state; every value/handler is driven by props.
 */

import { useState } from 'react';
import { Search, X, Upload, ArrowRightLeft, Hash } from 'lucide-react';
import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS } from '../../../../components/glass/glass';
import type { Carrier } from '../../../../types/carrier';
import type { TfnFilters } from '../types';
import { TFN_STATUSES, CR_STATUSES } from '../types';
import {
  sectionTitle,
  sectionSubtitle,
  primaryBtn,
  ghostBtn,
  filterBar,
  searchWrap,
  searchInput,
  selectStyle,
  clearBtn,
  selectionBar,
} from '../styles';

interface CustomerOption {
  id: number;
  name: string;
  account_type: string;
}

interface TollFreeControlsBarProps {
  filters: TfnFilters;
  onChange: (f: TfnFilters) => void;
  onSearch: () => void;
  searching: boolean;
  customers: CustomerOption[];
  carriers: Carrier[];
  selectedCount: number;
  onReassign: () => void;
  onClearSelection: () => void;
  onImport: () => void;
}

export function TollFreeControlsBar({
  filters,
  onChange,
  onSearch,
  searching,
  customers,
  carriers,
  selectedCount,
  onReassign,
  onClearSelection,
  onImport,
}: TollFreeControlsBarProps) {
  const [focused, setFocused] = useState(false);
  const [importHover, setImportHover] = useState(false);
  const [searchHover, setSearchHover] = useState(false);
  const [reassignHover, setReassignHover] = useState(false);

  const set = <K extends keyof TfnFilters>(key: K, value: TfnFilters[K]) => onChange({ ...filters, [key]: value });

  return (
    <GlassPanel padding="20px 24px">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Header row */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Hash size={17} style={{ color: GLASS.accent }} />
              <h2 style={sectionTitle}>Toll-Free Inventory</h2>
            </div>
            <p style={sectionSubtitle}>Search, steer and manage RespOrg toll-free numbers at scale.</p>
          </div>
          <button
            type="button"
            onClick={onImport}
            onMouseEnter={() => setImportHover(true)}
            onMouseLeave={() => setImportHover(false)}
            style={primaryBtn(importHover)}
          >
            <Upload size={14} />
            Import CSV
          </button>
        </div>

        {/* Filter row */}
        <form
          style={filterBar}
          onSubmit={(e) => {
            e.preventDefault();
            onSearch();
          }}
        >
          <div style={searchWrap(focused)}>
            <Search size={15} color={focused ? GLASS.accent : GLASS.textFaint} style={{ flexShrink: 0 }} />
            <input
              type="text"
              value={filters.search}
              onChange={(e) => set('search', e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              placeholder="Search toll-free number…"
              style={searchInput}
            />
            {filters.search && (
              <button type="button" onClick={() => set('search', '')} style={clearBtn()} aria-label="Clear search">
                <X size={13} />
              </button>
            )}
          </div>

          <select value={filters.status} onChange={(e) => set('status', e.target.value)} style={selectStyle(Boolean(filters.status))} aria-label="Status filter">
            <option value="">All statuses</option>
            {TFN_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <select value={filters.cr_status} onChange={(e) => set('cr_status', e.target.value)} style={selectStyle(Boolean(filters.cr_status))} aria-label="CR status filter">
            <option value="">All CR statuses</option>
            {CR_STATUSES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>

          <select value={filters.carrier_id} onChange={(e) => set('carrier_id', e.target.value)} style={selectStyle(Boolean(filters.carrier_id))} aria-label="Carrier filter">
            <option value="">All carriers</option>
            {carriers.map((c) => (
              <option key={c.id} value={c.id}>{c.display_name || c.gateway_name}</option>
            ))}
          </select>

          <select value={filters.customer_id} onChange={(e) => set('customer_id', e.target.value)} style={selectStyle(Boolean(filters.customer_id))} aria-label="Customer filter">
            <option value="">All customers</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>

          <button
            type="submit"
            disabled={searching}
            onMouseEnter={() => setSearchHover(true)}
            onMouseLeave={() => setSearchHover(false)}
            style={ghostBtn(searchHover, searching)}
          >
            <Search size={14} />
            Search
          </button>
        </form>

        {/* Selection bar */}
        {selectedCount > 0 && (
          <div style={selectionBar()}>
            <span style={{ fontSize: '0.8rem', color: GLASS.text, fontWeight: 600 }}>
              {selectedCount.toLocaleString()} number{selectedCount === 1 ? '' : 's'} selected
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={onReassign}
                onMouseEnter={() => setReassignHover(true)}
                onMouseLeave={() => setReassignHover(false)}
                style={primaryBtn(reassignHover)}
              >
                <ArrowRightLeft size={14} />
                Reassign carrier
              </button>
              <button type="button" onClick={onClearSelection} style={ghostBtn(false)}>
                Clear
              </button>
            </div>
          </div>
        )}
      </div>
    </GlassPanel>
  );
}
