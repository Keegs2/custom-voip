/**
 * Least-Cost Outbound types — map 1:1 to `routers/lco.py`
 * (`carrier_rate_decks`, `customer_carrier_policy`, the LCO decision + savings).
 */

export type Jurisdiction = 'interstate' | 'intrastate' | 'intl' | 'default';
export type PolicyMode = 'allow' | 'deny';

/** One rate-deck entry (cost-per-min for a carrier + destination prefix). */
export interface RateDeck {
  id: number;
  carrier_id: number;
  /** Present on list rows (JOINed); absent on create/update returns. */
  gateway_name?: string;
  prefix: string;
  description: string | null;
  cost_per_min: number;
  jurisdiction: string;
  priority: number;
  effective_date: string | null;
  expires_at: string | null;
  enabled: boolean;
  updated_at: string;
}

export interface RateDeckListResponse {
  items: RateDeck[];
  total: number;
  limit: number;
  offset: number;
}

export interface RateDeckCreate {
  carrier_id: number;
  prefix: string;
  cost_per_min: number;
  jurisdiction?: string;
  priority?: number;
  description?: string | null;
  effective_date?: string | null;
  expires_at?: string | null;
}

export interface RateDeckUpdate {
  cost_per_min?: number;
  priority?: number;
  description?: string | null;
  expires_at?: string | null;
  enabled?: boolean;
}

export interface RateDeckImportRequest {
  carrier_id: number;
  csv: string;
  effective_date?: string | null;
}

export interface RateDeckImportResult {
  carrier_id: number;
  gateway_name: string;
  effective_date: string;
  processed: number;
  skipped: number;
  errors: Array<Record<string, unknown>>;
}

/** A per-customer carrier allow/deny rule. */
export interface CarrierPolicy {
  id: number;
  customer_id: number;
  carrier_id: number;
  gateway_name?: string;
  mode: string; // 'allow' | 'deny'
  priority_override: number | null;
  notes: string | null;
  updated_at: string;
}

export interface CarrierPolicyUpsert {
  customer_id: number;
  carrier_id: number;
  mode: PolicyMode;
  priority_override?: number | null;
  notes?: string | null;
}

/** One hop in the cheapest-first ordered route for a destination. */
export interface LcoRouteHop {
  carrier_id: number;
  x_carrier_value: string | null;
  pop_ip: string | null;
  cost_per_min: number | null;
  priority: number | null;
  prefix: string | null;
}

export interface LcoRouteDecision {
  destination: string;
  customer_id: number | null;
  x_lco_route: string | null;
  routes: LcoRouteHop[];
}

/** One destination-prefix row in the transparent savings breakdown. */
export interface SavingsPrefix {
  prefix: string;
  calls: number;
  billable_min: number;
  baseline_rate: number | null;
  actual_cost: number;
  baseline_cost: number;
  savings: number;
}

export interface SavingsReport {
  start: string;
  end: string;
  customer_id: number | null;
  total_calls: number;
  actual_cost: number;
  baseline_cost: number;
  savings: number;
  savings_pct: number;
  prefixes: SavingsPrefix[];
  note: string;
}

/** Billing-feed export format (streamed download). */
export type BillingExportFormat = 'csv' | 'jsonl';
