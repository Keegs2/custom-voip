/**
 * Programmable-voice configuration (api / hybrid accounts only).
 *
 * A programmable DID maps an inbound number to a customer webhook (`voice_url`)
 * that returns call-control TwiML, with an optional `fallback_url` used when the
 * primary webhook errors or times out. The customer verifies the
 * `X-Revup-Signature` header on those callbacks using their webhook signing
 * secret, managed via the customer webhook-secret endpoints.
 */
export interface ProgrammableDid {
  id: number;
  did: string;
  customer_id: number;
  customer_name?: string;
  voice_url: string;
  fallback_url: string | null;
  enabled: boolean;
  created_at: string;
}

export interface ProgrammableDidUpdate {
  voice_url?: string;
  fallback_url?: string | null;
  enabled?: boolean;
}

export interface WebhookSecret {
  customer_id: number;
  webhook_signing_secret: string;
  signature_header: string;
  rotated?: boolean;
}
