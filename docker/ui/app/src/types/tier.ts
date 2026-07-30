export type TierType = 'rcf' | 'api' | 'trunk' | 'all';

export interface Tier {
  id: number;
  name: string;
  tier_type: TierType;
  cps_limit: number;
  /**
   * Included concurrent call paths bundled with the tier.
   * Integer for trunk tiers (e.g. 20/50/100/250); null for API tiers
   * (API Calling has no bundled call-path allotment).
   */
  call_paths?: number | null;
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
