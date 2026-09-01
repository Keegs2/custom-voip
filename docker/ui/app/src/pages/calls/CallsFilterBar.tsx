/**
 * CallsFilterBar — the merged Calls & Quality filter slab.
 *
 * Evolved from the CDR Search filter bar (the more dynamic of the two pages'
 * search boxes) with the Call Quality page's trunk selector folded in and
 * role gating added. One white `dl-panel`: a scope row (customer / trunk /
 * product / direction / zone / destination prefix), a time row (range
 * presets + datetime pickers + rated-only), and a footer with inline
 * validation + the Search / Export actions.
 *
 * Role gating (presentation only — the API tenant-scopes server-side):
 * - Staff (admin + support) see the Customer and Zone filters and Export CSV.
 * - Tenants get neither; the Trunk selector stays (listTrunks is
 *   tenant-scoped, so tenants only ever see their own trunks).
 *
 * Time-range semantics (state + serialization live in ./callsFilters):
 * - Presets (Last hour / 24h / 7d / 30d) are RELATIVE — they resolve to
 *   concrete instants when Search is clicked, so "Last 24h" always means 24h
 *   before the search, not before page load. While a preset is active the
 *   datetime inputs show a live preview and are disabled — the preset is
 *   authoritative.
 * - Custom enables the pickers. The user enters LOCAL wall-clock time;
 *   filtersToParams() converts to ISO 8601 UTC for the wire.
 */
import { useQuery } from '@tanstack/react-query';
import { listCustomers } from '../../api/customers';
import { listTrunks } from '../../api/trunks';
import {
  PRESET_LABELS,
  presetRange,
  toDatetimeLocal,
  validateCallsFilters,
} from './callsFilters';
import type { CallsFilters, CdrRangePreset } from './callsFilters';

interface CallsFilterBarProps {
  filters: CallsFilters;
  onChange: (filters: CallsFilters) => void;
  onSearch: () => void;
  onExport: () => void;
  searching: boolean;
  exporting: boolean;
  /** Admin or support — shows Customer + Zone filters and Export CSV. */
  isStaff: boolean;
}

export function CallsFilterBar({
  filters,
  onChange,
  onSearch,
  onExport,
  searching,
  exporting,
  isStaff,
}: CallsFilterBarProps) {
  // ALL hooks unconditionally at the top — React #310 prevention.
  const { data: customersData } = useQuery({
    queryKey: ['customers-all'],
    queryFn: () => listCustomers({ limit: 500 }),
    staleTime: 5 * 60 * 1000,
    enabled: isStaff, // tenants have no customer filter (and no /customers read)
  });

  // Trunk options follow the selected customer for staff; tenants always get
  // their own trunks (listTrunks is tenant-scoped server-side).
  const { data: trunksData } = useQuery({
    queryKey: ['trunks-for-cdr-filter', filters.customer_id],
    queryFn: () =>
      listTrunks({
        customer_id: filters.customer_id ? Number(filters.customer_id) : undefined,
        limit: 500,
      }),
    staleTime: 2 * 60 * 1000,
  });

  const rangeError = validateCallsFilters(filters);

  // While a preset is active the pickers show its live preview (recomputed
  // each render — close enough to "now" for a preview; the authoritative
  // resolution happens at Search time).
  const preview =
    filters.range_preset === 'custom' ? null : presetRange(filters.range_preset, new Date());
  const isCustom = filters.range_preset === 'custom';
  const startValue = preview ? toDatetimeLocal(preview.start) : filters.start_local;
  const endValue = preview ? toDatetimeLocal(preview.end) : filters.end_local;

  function set<K extends keyof CallsFilters>(key: K, value: CallsFilters[K]) {
    onChange({ ...filters, [key]: value });
  }

  /** Changing customer invalidates the trunk choice (trunks are per-customer). */
  function setCustomer(value: string) {
    onChange({ ...filters, customer_id: value, trunk_id: '' });
  }

  function selectPreset(preset: CdrRangePreset) {
    if (preset === 'custom') {
      // Seed the editable pickers from whatever window is currently shown.
      onChange({
        ...filters,
        range_preset: 'custom',
        start_local: startValue,
        end_local: endValue,
      });
    } else {
      onChange({ ...filters, range_preset: preset });
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (rangeError) return;
    onSearch();
  }

  return (
    <section className="dl-panel">
      <form onSubmit={handleSubmit} className="dl-panel-body">
        {/* Row 1 — scope filters */}
        <div className="dlx4-filterrow">
          {isStaff && (
            <div className="dlx4-field" style={{ minWidth: 180 }}>
              <label className="dl-flabel" htmlFor="cdr-f-customer">Customer</label>
              <select
                id="cdr-f-customer"
                className="dl-input"
                value={filters.customer_id}
                onChange={(e) => setCustomer(e.target.value)}
              >
                <option value="">All Customers</option>
                {(customersData?.items ?? []).map((c) => (
                  <option key={c.id} value={String(c.id)}>{c.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="dlx4-field" style={{ minWidth: 150 }}>
            <label className="dl-flabel" htmlFor="cdr-f-trunk">Trunk</label>
            <select
              id="cdr-f-trunk"
              className="dl-input"
              value={filters.trunk_id}
              onChange={(e) => set('trunk_id', e.target.value)}
            >
              <option value="">All Trunks</option>
              {(trunksData?.items ?? []).map((t) => (
                <option key={t.id} value={String(t.id)}>{t.trunk_name}</option>
              ))}
            </select>
          </div>

          <div className="dlx4-field" style={{ minWidth: 110 }}>
            <label className="dl-flabel" htmlFor="cdr-f-product">Product</label>
            <select
              id="cdr-f-product"
              className="dl-input"
              value={filters.product_type}
              onChange={(e) => set('product_type', e.target.value)}
            >
              <option value="">All</option>
              <option value="rcf">RCF</option>
              <option value="api">API</option>
              <option value="trunk">Trunk</option>
            </select>
          </div>

          <div className="dlx4-field" style={{ minWidth: 110 }}>
            <label className="dl-flabel" htmlFor="cdr-f-direction">Direction</label>
            <select
              id="cdr-f-direction"
              className="dl-input"
              value={filters.direction}
              onChange={(e) => set('direction', e.target.value)}
            >
              <option value="">All</option>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
            </select>
          </div>

          {/* Zone — static options; each zone is a self-contained SIP stack.
              Per-SBC granularity stays visible in the call-detail modal. */}
          {isStaff && (
            <div className="dlx4-field" style={{ minWidth: 120 }}>
              <label className="dl-flabel" htmlFor="cdr-f-zone">Zone</label>
              <select
                id="cdr-f-zone"
                className="dl-input"
                value={filters.zone}
                onChange={(e) => set('zone', e.target.value)}
              >
                <option value="">All zones</option>
                <option value="east">East</option>
                <option value="west">West</option>
                <option value="central">Central</option>
              </select>
            </div>
          )}

          <div className="dlx4-field" style={{ minWidth: 150 }}>
            <label className="dl-flabel" htmlFor="cdr-f-dest">Destination Prefix</label>
            <input
              id="cdr-f-dest"
              type="text"
              className="dl-input"
              placeholder="e.g. 1800"
              value={filters.destination}
              onChange={(e) => set('destination', e.target.value)}
            />
          </div>
        </div>

        {/* Row 2 — time range */}
        <div className="dlx4-filterrow dlx4-filterrow-time">
          <div className="dlx4-field">
            <span className="dl-flabel">Time Range</span>
            <div className="dlx-seg" role="group" aria-label="Time range presets">
              {(Object.keys(PRESET_LABELS) as Array<Exclude<CdrRangePreset, 'custom'>>).map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={filters.range_preset === p}
                  className={filters.range_preset === p ? 'dlx-seg-btn dlx-seg-btn-active' : 'dlx-seg-btn'}
                  onClick={() => selectPreset(p)}
                >
                  {PRESET_LABELS[p]}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={isCustom}
                className={isCustom ? 'dlx-seg-btn dlx-seg-btn-active' : 'dlx-seg-btn'}
                onClick={() => selectPreset('custom')}
              >
                Custom
              </button>
            </div>
          </div>

          <div className="dlx4-field">
            <label className="dl-flabel" htmlFor="cdr-f-start">
              Start {isCustom ? '(local time)' : ''}
            </label>
            <input
              id="cdr-f-start"
              type="datetime-local"
              className="dl-input"
              value={startValue}
              disabled={!isCustom}
              aria-invalid={rangeError != null}
              onChange={(e) => set('start_local', e.target.value)}
            />
          </div>

          <div className="dlx4-field">
            <label className="dl-flabel" htmlFor="cdr-f-end">
              End {isCustom ? '(local time)' : ''}
            </label>
            <input
              id="cdr-f-end"
              type="datetime-local"
              className="dl-input"
              value={endValue}
              disabled={!isCustom}
              aria-invalid={rangeError != null}
              onChange={(e) => set('end_local', e.target.value)}
            />
          </div>

          <div className="dlx4-field" style={{ justifyContent: 'flex-end' }}>
            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                cursor: 'pointer',
                fontSize: '0.8rem',
                color: 'var(--rcf-ink-soft)',
                whiteSpace: 'nowrap',
                userSelect: 'none',
                height: 36,
              }}
            >
              <input
                type="checkbox"
                style={{ width: 15, height: 15, accentColor: 'var(--rcf-azure)', cursor: 'pointer' }}
                checked={filters.rated_only}
                onChange={(e) => set('rated_only', e.target.checked)}
              />
              Rated only
            </label>
          </div>
        </div>

        {/* Footer — inline validation on the left, actions on the right */}
        <div className="dlx4-filterfoot">
          <div role="alert" aria-live="polite">
            {rangeError && <span className="dlx4-ferr">{rangeError}</span>}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <button
              type="submit"
              className="dl-btn dl-btn-primary"
              disabled={searching || rangeError != null}
            >
              {searching ? 'Searching…' : 'Search'}
            </button>
            {isStaff && (
              <button
                type="button"
                className="dl-btn dl-btn-ghost"
                disabled={exporting || rangeError != null}
                onClick={onExport}
              >
                {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
            )}
          </div>
        </div>
      </form>
    </section>
  );
}
