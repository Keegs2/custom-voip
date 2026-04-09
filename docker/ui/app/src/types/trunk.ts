export type TrunkAuthType = 'ip' | 'credentials' | 'both';

export interface Trunk {
  id: number;
  customer_id: number;
  customer_name?: string;
  trunk_name: string;
  max_channels: number;
  cps_limit: number;
  auth_type: TrunkAuthType;
  tech_prefix?: string | null;
  enabled: boolean;
  ip_count?: number;
  did_count?: number;
  package_name?: string | null;
  created_at: string;
}

export interface TrunkIp {
  id: number;
  trunk_id: number;
  ip_address: string;
  description?: string | null;
  created_at: string;
}

export interface TrunkDid {
  id: number;
  trunk_id: number;
  did: string;
  enabled: boolean;
  created_at: string;
}

export interface TrunkStats {
  active_channels: number;
  calls_today: number;
  minutes_today: number;
  cost_today: number;
}

export interface CallPathPackage {
  id: number;
  name: string;
  description?: string | null;
  monthly_fee: number;
  included_minutes: number;
  overage_rate: number;
  max_channels: number | null;
  is_active: boolean;
}

export interface TrunkCreate {
  customer_id: number;
  trunk_name: string;
  max_channels?: number;
  cps_limit?: number;
  auth_type?: TrunkAuthType;
  tech_prefix?: string | null;
  enabled?: boolean;
  package_name?: string | null;
}
