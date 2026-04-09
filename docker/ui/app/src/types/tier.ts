export type TierType = 'rcf' | 'api' | 'trunk' | 'all';

export interface Tier {
  id: number;
  name: string;
  tier_type: TierType;
  cps_limit: number;
  monthly_fee: number;
  per_call_fee: number;
  description?: string | null;
  features?: string[] | null;
  is_active: boolean;
  sort_order: number;
}

export interface CustomerTierResponse {
  customer_id: number;
  tier_id: number | null;
  tier: Tier | null;
  assigned_at: string | null;
}
