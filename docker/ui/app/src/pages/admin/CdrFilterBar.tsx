/**
 * CdrFilterBar — the CDR search filter slab (/admin/platform/cdrs).
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css plus the
 * page-scoped `dlx4-*` layer in styles/dl-platform-b.css). Renders INSIDE the
 * PlatformManagementPage shell — one white `dl-panel` holding the labelled
 * filter fields and the Search / Export CSV actions. Filter state, defaults,
 * and the filters→params mapping are unchanged.
 */
import { useQuery } from '@tanstack/react-query';
import { listCustomers } from '../../api/customers';
import type { CdrSearchParams } from '../../types/cdr';
import type { ProductType, CallDirection } from '../../types/cdr';

function toDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function defaultStartDate(): string {
  return toDatetimeLocal(new Date(Date.now() - 24 * 60 * 60 * 1000));
}

function defaultEndDate(): string {
  return toDatetimeLocal(new Date());
}

export interface CdrFilters {
  customer_id: string;
  product_type: string;
  direction: string;
  start_from: string;
  start_to: string;
  destination: string;
  rated_only: boolean;
  sbc_id: string;
}

export function defaultCdrFilters(): CdrFilters {
  return {
    customer_id: '',
    product_type: '',
    direction: '',
    start_from: defaultStartDate(),
    start_to: defaultEndDate(),
    destination: '',
    rated_only: false,
    sbc_id: '',
  };
}

export function filtersToParams(filters: CdrFilters, limit: number, offset: number): CdrSearchParams {
  const params: CdrSearchParams = { limit, offset };
  if (filters.customer_id) params.customer_id = Number(filters.customer_id);
  if (filters.product_type) params.product_type = filters.product_type as ProductType;
  if (filters.direction) params.direction = filters.direction as CallDirection;
  if (filters.start_from) params.start_from = new Date(filters.start_from).toISOString();
  if (filters.start_to) params.start_to = new Date(filters.start_to).toISOString();
  if (filters.destination) params.destination = filters.destination;
  if (filters.sbc_id) params.sbc_id = filters.sbc_id;
  return params;
}

interface CdrFilterBarProps {
  filters: CdrFilters;
  onChange: (filters: CdrFilters) => void;
  onSearch: () => void;
  onExport: () => void;
  searching: boolean;
}

export function CdrFilterBar({ filters, onChange, onSearch, onExport, searching }: CdrFilterBarProps) {
  const { data: customersData } = useQuery({
    queryKey: ['customers-all'],
    queryFn: () => listCustomers({ limit: 500 }),
    staleTime: 5 * 60 * 1000,
  });

  function set<K extends keyof CdrFilters>(key: K, value: CdrFilters[K]) {
    onChange({ ...filters, [key]: value });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSearch();
  }

  return (
    <section className="dl-panel">
      <form onSubmit={handleSubmit} className="dl-panel-body">
        <div className="dlx4-filterbar">
          {/* Customer */}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 180 }}>
            <label className="dl-flabel">Customer</label>
            <select
              className="dl-input"
              value={filters.customer_id}
              onChange={(e) => set('customer_id', e.target.value)}
            >
              <option value="">All Customers</option>
              {(customersData?.items ?? []).map((c) => (
                <option key={c.id} value={String(c.id)}>{c.name}</option>
              ))}
            </select>
          </div>

          {/* Product type */}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 110 }}>
            <label className="dl-flabel">Product</label>
            <select
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

          {/* Direction */}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 110 }}>
            <label className="dl-flabel">Direction</label>
            <select
              className="dl-input"
              value={filters.direction}
              onChange={(e) => set('direction', e.target.value)}
            >
              <option value="">All</option>
              <option value="inbound">Inbound</option>
              <option value="outbound">Outbound</option>
            </select>
          </div>

          {/* SBC */}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 130 }}>
            <label className="dl-flabel">SBC</label>
            <select
              className="dl-input"
              value={filters.sbc_id}
              onChange={(e) => set('sbc_id', e.target.value)}
            >
              <option value="">All SBCs</option>
              <option value="east-sbc-1">east-sbc-1</option>
              <option value="east-sbc-2">east-sbc-2</option>
            </select>
          </div>

          {/* Start date */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <label className="dl-flabel">Start</label>
            <input
              type="datetime-local"
              className="dl-input"
              value={filters.start_from}
              onChange={(e) => set('start_from', e.target.value)}
            />
          </div>

          {/* End date */}
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <label className="dl-flabel">End</label>
            <input
              type="datetime-local"
              className="dl-input"
              value={filters.start_to}
              onChange={(e) => set('start_to', e.target.value)}
            />
          </div>

          {/* Destination prefix */}
          <div style={{ display: 'flex', flexDirection: 'column', minWidth: 150 }}>
            <label className="dl-flabel">Destination Prefix</label>
            <input
              type="text"
              className="dl-input"
              placeholder="e.g. 1800"
              value={filters.destination}
              onChange={(e) => set('destination', e.target.value)}
            />
          </div>

          {/* Rated only */}
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end' }}>
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

          {/* Actions — pushed to end */}
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', marginLeft: 'auto', paddingLeft: 8 }}>
            <button type="submit" className="dl-btn dl-btn-primary" disabled={searching}>
              {searching ? 'Searching…' : 'Search'}
            </button>
            <button type="button" className="dl-btn dl-btn-ghost" onClick={onExport}>
              Export CSV
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
