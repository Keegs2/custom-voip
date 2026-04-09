export interface Rate {
  id: number;
  prefix: string;
  description?: string | null;
  rate_per_min: number;
  cost_per_min: number;
  margin_per_min: number;
  margin_pct?: number | null;
  connection_fee: number;
  increment: number;
}

export interface RateCreate {
  prefix: string;
  description?: string | null;
  rate_per_min: number;
  cost_per_min: number;
  connection_fee?: number;
  increment?: number;
}

export interface RateUpdate {
  description?: string | null;
  rate_per_min?: number;
  cost_per_min?: number;
  connection_fee?: number;
  increment?: number;
}

export interface RatesResponse {
  items: Rate[];
  total: number;
  limit: number;
  offset: number;
}

export interface MarginRateEntry {
  prefix: string;
  description?: string | null;
  rate_per_min: number;
  cost_per_min: number;
  margin_per_min: number;
  margin_pct?: number | null;
}

export interface MarginsData {
  total_rates: number;
  avg_margin_pct: number;
  min_margin_pct: number;
  max_margin_pct: number;
  negative_margin_count: number;
  negative_margins?: MarginRateEntry[];
  low_margins?: MarginRateEntry[];
  best_margins?: MarginRateEntry[];
}

export interface CdrSummaryRow {
  date?: string | null;
  hour?: string | null;
  destination?: string | null;
  product_type?: string | null;
  direction?: string | null;
  total_calls: number;
  answered_calls: number;
  total_duration_sec: number;
  total_cost: number;
}

export interface CdrSummaryResponse {
  summary: CdrSummaryRow[];
}
