export type AccountType = 'rcf' | 'api' | 'trunk' | 'hybrid' | 'ucaas';
export type CustomerStatus = 'active' | 'suspended' | 'closed';
/** Traffic pattern (migration 63): which carriers deliver the customer's
 *  calls. 'premium' = Tier 1 carriers only (falls back to all carriers when
 *  none is left); 'enterprise' = all carriers by zone priority. */
export type TrafficGrade = 'enterprise' | 'premium';
/** CDRs written before migration 63 keep the old grade names. */
export type CdrTrafficGrade = TrafficGrade | 'standard' | 'economy';

export interface Customer {
  id: number;
  name: string;
  account_type: AccountType;
  status: CustomerStatus;
  /** Internal routing grade — staff-only; absent from tenant responses. */
  traffic_grade?: TrafficGrade;
  daily_limit: number | null;
  cpm_limit: number | null;
  fraud_score: number;
  created_at: string;
  ucaas_enabled: boolean | null;
}

export interface CustomerCreate {
  name: string;
  account_type: AccountType;
  status?: CustomerStatus;
  traffic_grade?: TrafficGrade;
  daily_limit?: number | null;
  cpm_limit?: number | null;
  ucaas_enabled?: boolean | null;
}

export interface CustomerUpdate {
  name?: string;
  account_type?: AccountType;
  status?: CustomerStatus;
  traffic_grade?: TrafficGrade;
  daily_limit?: number | null;
  cpm_limit?: number | null;
  ucaas_enabled?: boolean | null;
}
