export interface ApiDid {
  id: number;
  did: string;
  customer_id: number;
  customer_name?: string;
  /** Webhook invoked when a call arrives on this number (required). */
  voice_url: string;
  /** Webhook invoked if voice_url fails / is unreachable. */
  fallback_url: string | null;
  /** Webhook that receives call lifecycle events. */
  status_callback: string | null;
  enabled: boolean;
  created_at: string;
}

export interface ApiDidCreate {
  did: string;
  customer_id: number;
  voice_url: string;
  fallback_url?: string | null;
  status_callback?: string | null;
  enabled?: boolean;
}

export interface ApiDidUpdate {
  voice_url?: string;
  fallback_url?: string | null;
  status_callback?: string | null;
  enabled?: boolean;
}
