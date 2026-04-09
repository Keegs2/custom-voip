import type { TrafficGrade } from './customer';

export type ProductType = 'rcf' | 'api' | 'trunk';
export type CallDirection = 'inbound' | 'outbound';

export interface Cdr {
  uuid: string;
  start_time: string;
  answer_time?: string | null;
  end_time?: string | null;
  caller_id: string;
  destination: string;
  customer_id: number;
  product_type: ProductType;
  direction: CallDirection;
  duration_seconds: number;
  billable_seconds: number;
  rate_per_min?: number | null;
  total_cost?: number | null;
  carrier_cost?: number | null;
  margin?: number | null;
  hangup_cause?: string | null;
  sip_code?: number | null;
  carrier_used?: string | null;
  traffic_grade?: TrafficGrade | null;
  fraud_score?: number | null;
  rated_at?: string | null;
}

export interface CdrSearchParams {
  customer_id?: number;
  product_type?: ProductType;
  direction?: CallDirection;
  caller_id?: string;
  destination?: string;
  start_from?: string;
  start_to?: string;
  hangup_cause?: string;
  limit?: number;
  offset?: number;
}

export interface CdrSearchResult {
  /** Normalised list of CDR records (from either `items` or `cdrs` field). */
  items: Cdr[];
  /** Total matching records (from either `total` or `count` field). */
  total: number;
  limit: number;
  offset: number;
}
