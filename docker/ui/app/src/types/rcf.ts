export interface RcfEntry {
  id: number;
  did: string;
  customer_id: number;
  customer_name?: string;
  forward_to: string;
  enabled: boolean;
  pass_caller_id: boolean;
  ring_timeout: number;
  failover_to?: string | null;
  created_at: string;
}

export interface RcfCreate {
  did: string;
  customer_id: number;
  forward_to: string;
  enabled?: boolean;
  pass_caller_id?: boolean;
  ring_timeout?: number;
  failover_to?: string | null;
}

export interface RcfUpdate {
  forward_to?: string;
  enabled?: boolean;
  pass_caller_id?: boolean;
  ring_timeout?: number;
  failover_to?: string | null;
}
