import { useQuery } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
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
  return params;
}

const controlStyle: React.CSSProperties = {
  fontSize: '0.875rem',
  padding: '8px 12px',
  height: 36,
  borderRadius: 8,
  border: '1px solid rgba(42,47,69,0.8)',
  background: 'rgba(19,21,29,0.8)',
  color: '#e2e8f0',
  outline: 'none',
  transition: 'border-color 0.15s, box-shadow 0.15s',
};

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

  const labelStyle: React.CSSProperties = {
    fontSize: '0.65rem',
    fontWeight: 700,
    color: '#4a5568',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    marginBottom: 6,
    display: 'block',
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        padding: '20px 24px',
        marginBottom: 20,
        boxShadow: '0 4px 20px rgba(0,0,0,0.25)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 12,
          alignItems: 'flex-end',
        }}
      >
        {/* Customer */}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 160 }}>
          <label style={labelStyle}>Customer</label>
          <select
            style={{ ...controlStyle, cursor: 'pointer' }}
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
          <label style={labelStyle}>Product</label>
          <select
            style={{ ...controlStyle, cursor: 'pointer' }}
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
          <label style={labelStyle}>Direction</label>
          <select
            style={{ ...controlStyle, cursor: 'pointer' }}
            value={filters.direction}
            onChange={(e) => set('direction', e.target.value)}
          >
            <option value="">All</option>
            <option value="inbound">Inbound</option>
            <option value="outbound">Outbound</option>
          </select>
        </div>

        {/* Start date */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <label style={labelStyle}>Start</label>
          <input
            type="datetime-local"
            style={controlStyle}
            value={filters.start_from}
            onChange={(e) => set('start_from', e.target.value)}
          />
        </div>

        {/* End date */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <label style={labelStyle}>End</label>
          <input
            type="datetime-local"
            style={controlStyle}
            value={filters.start_to}
            onChange={(e) => set('start_to', e.target.value)}
          />
        </div>

        {/* Destination prefix */}
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 130 }}>
          <label style={labelStyle}>Destination Prefix</label>
          <input
            type="text"
            style={controlStyle}
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
              fontSize: '0.875rem',
              color: '#718096',
              whiteSpace: 'nowrap',
              userSelect: 'none',
              height: 36,
            }}
          >
            <input
              type="checkbox"
              style={{ width: 16, height: 16, borderRadius: 4, accentColor: '#3b82f6', cursor: 'pointer' }}
              checked={filters.rated_only}
              onChange={(e) => set('rated_only', e.target.checked)}
            />
            Rated only
          </label>
        </div>

        {/* Actions — pushed to end */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginLeft: 'auto' }}>
          <Button type="submit" variant="primary" size="sm" loading={searching}>
            Search
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={onExport}>
            Export CSV
          </Button>
        </div>
      </div>
    </form>
  );
}
