export type CarrierTransport = 'UDP' | 'TCP' | 'TLS';
export type CarrierAuthType = 'ip' | 'credentials' | 'none';

export interface Carrier {
  id: number;
  gateway_name: string;
  display_name: string;
  description?: string | null;
  sip_proxy: string;
  port: number;
  transport: CarrierTransport;
  auth_type: CarrierAuthType;
  username?: string | null;
  password?: string | null;
  codec_prefs: string[];
  max_channels?: number | null;
  cps_limit?: number | null;
  product_types: string[];
  is_primary: boolean;
  is_failover: boolean;
  register: boolean;
  caller_id_in_from: boolean;
  enabled: boolean;
}

export interface CarrierCreate {
  gateway_name: string;
  display_name: string;
  description?: string | null;
  sip_proxy: string;
  port?: number;
  transport?: CarrierTransport;
  auth_type?: CarrierAuthType;
  username?: string | null;
  password?: string | null;
  codec_prefs?: string[];
  max_channels?: number | null;
  cps_limit?: number | null;
  product_types?: string[];
  is_primary?: boolean;
  is_failover?: boolean;
  register?: boolean;
  caller_id_in_from?: boolean;
  enabled?: boolean;
}

export interface CarrierUpdate {
  display_name?: string;
  description?: string | null;
  sip_proxy?: string;
  port?: number;
  transport?: CarrierTransport;
  auth_type?: CarrierAuthType;
  username?: string | null;
  password?: string | null;
  codec_prefs?: string[];
  max_channels?: number | null;
  cps_limit?: number | null;
  product_types?: string[];
  is_primary?: boolean;
  is_failover?: boolean;
  register?: boolean;
  caller_id_in_from?: boolean;
  enabled?: boolean;
}

export interface CarrierTestResult {
  carrier_id: number;
  gateway_name: string;
  reachable: boolean;
  latency_ms?: number | null;
  error?: string | null;
  tested_at: string;
}
