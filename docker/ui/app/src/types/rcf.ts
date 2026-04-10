export interface RcfEntry {
  id: number;
  did: string;
  customer_id: number;
  customer_name?: string;
  name?: string | null;
  forward_to: string;
  enabled: boolean;
  pass_caller_id: boolean;
  ring_timeout: number;
  failover_to?: string | null;
  created_at: string;
}

export interface RcfCreate {
  did: string;
  name?: string;
  customer_id: number;
  forward_to: string;
  enabled?: boolean;
  pass_caller_id?: boolean;
  ring_timeout?: number;
  failover_to?: string | null;
}

export interface RcfUpdate {
  name?: string | null;
  forward_to?: string;
  enabled?: boolean;
  pass_caller_id?: boolean;
  ring_timeout?: number;
  failover_to?: string | null;
}
