/**
 * UI feature flags.
 *
 * API_CALLING_ENABLED — the "API Calling" product (account_type `api`) was
 * RETIRED 2026-09. The code is kept, not deleted: every API-product surface
 * (the /api-dids page, its nav item, the API DID sections on My Account and in
 * the IVR topbar, the "calling" Guides / REST-reference sections, the CDR
 * product filter, the onboarding product option) is gated on this constant.
 * While it is false nothing calls the API DID endpoints. The public landing
 * page no longer carries API Calling copy at all — restoring the product
 * means writing (fact-checked) landing copy again.
 *
 * This mirrors the backend / FreeSWITCH env var `API_CALLING_ENABLED`. To
 * restore the product, flip BOTH this constant and that env var.
 */
export const API_CALLING_ENABLED: boolean = false;
