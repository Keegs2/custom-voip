/**
 * Local types for the Programmable Voice feature folder. Page-global types
 * (`ApiDid`, `ApiDidCreate`, `WebhookSecret`) still come from
 * `src/types/apiDid.ts`; only feature-local unions/consts live here.
 */

/** Fallback signature header name when the server hasn't told us one yet. */
export const DEFAULT_SIGNATURE_HEADER = 'X-Revup-Signature';

/** Which editable webhook URL a card field maps to. */
export type WebhookFieldKind = 'voice' | 'callback';
