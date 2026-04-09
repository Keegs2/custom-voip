import { useQuery } from '@tanstack/react-query';
import { Button } from '../../components/ui/Button';
import { listCustomers } from '../../api/customers';
import type { CdrSearchParams } from '../../types/cdr';
import type { ProductType, CallDirection } from '../../types/cdr';

/** Formats a Date to the value string expected by datetime-local inputs. */
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

/** Maps the filter state to CdrSearchParams consumed by the API. */
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

const controlBase = [
  'text-[0.82rem] px-2.5 py-[7px] rounded-lg',
  'border border-[#2a2f45] bg-[#1e2130] text-[#e2e8f0]',
  'outline-none transition-[border-color,box-shadow] duration-150',
  'focus:border-[#3b82f6] focus:shadow-[0_0_0_3px_rgba(59,130,246,0.28)]',
  'placeholder:text-[#718096]',
].join(' ');

interface CdrFilterBarProps {
  filters: CdrFilters;
  onChange: (filters: CdrFilters) => void;
  onSearch: () => void;
  onExport: () => void;
  searching: boolean;
}

export function CdrFilterBar({
  filters,
  onChange,
  onSearch,
  onExport,
  searching,
}: CdrFilterBarProps) {
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
    <form
      onSubmit={handleSubmit}
      className="flex flex-wrap gap-2.5 items-end bg-[#1a1d27] border border-[#2a2f45] rounded-[10px] p-4 mb-5"
    >
      {/* Customer */}
      <div className="flex flex-col gap-[4px] min-w-[160px]">
        <label className="text-[0.68rem] font-bold text-[#718096] uppercase tracking-[0.7px]">
          Customer
        </label>
        <select
          className={controlBase + ' cursor-pointer'}
          value={filters.customer_id}
          onChange={(e) => set('customer_id', e.target.value)}
        >
          <option value="">All Customers</option>
          {(customersData?.items ?? []).map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      {/* Product type */}
      <div className="flex flex-col gap-[4px]">
        <label className="text-[0.68rem] font-bold text-[#718096] uppercase tracking-[0.7px]">
          Product
        </label>
        <select
          className={controlBase + ' cursor-pointer'}
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
      <div className="flex flex-col gap-[4px]">
        <label className="text-[0.68rem] font-bold text-[#718096] uppercase tracking-[0.7px]">
          Direction
        </label>
        <select
          className={controlBase + ' cursor-pointer'}
          value={filters.direction}
          onChange={(e) => set('direction', e.target.value)}
        >
          <option value="">All</option>
          <option value="inbound">Inbound</option>
          <option value="outbound">Outbound</option>
        </select>
      </div>

      {/* Start date */}
      <div className="flex flex-col gap-[4px]">
        <label className="text-[0.68rem] font-bold text-[#718096] uppercase tracking-[0.7px]">
          Start
        </label>
        <input
          type="datetime-local"
          className={controlBase}
          value={filters.start_from}
          onChange={(e) => set('start_from', e.target.value)}
        />
      </div>

      {/* End date */}
      <div className="flex flex-col gap-[4px]">
        <label className="text-[0.68rem] font-bold text-[#718096] uppercase tracking-[0.7px]">
          End
        </label>
        <input
          type="datetime-local"
          className={controlBase}
          value={filters.start_to}
          onChange={(e) => set('start_to', e.target.value)}
        />
      </div>

      {/* Destination prefix */}
      <div className="flex flex-col gap-[4px] min-w-[130px]">
        <label className="text-[0.68rem] font-bold text-[#718096] uppercase tracking-[0.7px]">
          Destination Prefix
        </label>
        <input
          type="text"
          className={controlBase}
          placeholder="e.g. 1800"
          value={filters.destination}
          onChange={(e) => set('destination', e.target.value)}
        />
      </div>

      {/* Rated only */}
      <div className="flex flex-col gap-[4px] justify-end pb-[1px]">
        <label className="flex items-center gap-2 cursor-pointer text-[0.82rem] text-[#718096] whitespace-nowrap select-none">
          <input
            type="checkbox"
            className="w-4 h-4 rounded accent-[#3b82f6] cursor-pointer"
            checked={filters.rated_only}
            onChange={(e) => set('rated_only', e.target.checked)}
          />
          Rated only
        </label>
      </div>

      {/* Actions */}
      <div className="flex gap-2 ml-auto items-end">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          loading={searching}
        >
          Search
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onExport}
        >
          Export CSV
        </Button>
      </div>
    </form>
  );
}
