export type AccountType = 'rcf' | 'api' | 'trunk' | 'hybrid' | 'ucaas';
export type CustomerStatus = 'active' | 'suspended' | 'closed';
export type TrafficGrade = 'standard' | 'premium' | 'economy';

export interface Customer {
  id: number;
  name: string;
  account_type: AccountType;
  balance: number;
  credit_limit: number;
  status: CustomerStatus;
  traffic_grade: TrafficGrade;
  daily_limit: number | null;
  cpm_limit: number | null;
  fraud_score: number;
  created_at: string;
  ucaas_enabled: boolean | null;
}

export interface CustomerCreate {
  name: string;
  account_type: AccountType;
  credit_limit?: number;
  status?: CustomerStatus;
  traffic_grade?: TrafficGrade;
  daily_limit?: number | null;
  cpm_limit?: number | null;
  ucaas_enabled?: boolean | null;
}

export interface CustomerUpdate {
  name?: string;
  account_type?: AccountType;
  credit_limit?: number;
  status?: CustomerStatus;
  traffic_grade?: TrafficGrade;
  daily_limit?: number | null;
  cpm_limit?: number | null;
  ucaas_enabled?: boolean | null;
}
