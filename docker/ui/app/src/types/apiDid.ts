export interface ApiDid {
  id: number;
  did: string;
  customer_id: number;
  customer_name?: string;
  voice_url: string;
  status_callback: string | null;
  enabled: boolean;
  created_at: string;
}

export interface ApiDidCreate {
  did: string;
  customer_id: number;
  voice_url: string;
  status_callback?: string | null;
  enabled?: boolean;
}

export interface ApiDidUpdate {
  voice_url?: string;
  status_callback?: string | null;
  enabled?: boolean;
}

/**
 * Per-customer webhook signing secret. Every programmable-voice callback is
 * signed with an HMAC over the request body, sent in the `signature_header`
 * header, so the customer can verify the request originated from us. Managed via
 * the customer webhook-secret endpoints.
 */
export interface WebhookSecret {
  customer_id: number;
  webhook_signing_secret: string;
  signature_header: string;
  rotated?: boolean;
}
