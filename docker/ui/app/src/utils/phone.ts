/**
 * Phone-number normalization — the CLIENT half of app-wide E.164 canonicalization.
 *
 * ⚠️  KEEP THIS ALGORITHM IDENTICAL to the backend + telephony layers:
 *       - Python:  docker/api/src/utils/phone.py            (`normalize_number_input`)
 *       - Lua:     docker/freeswitch/scripts/lib/number_utils.lua (`normalize_number_input`)
 *     All three implement the SAME canonical spec. If you change one, change all three.
 *
 * ─── Canonical form ────────────────────────────────────────────────────────────
 * Canonical = E.164 with a leading `+`, PRESERVING the country code.
 *   - Only a BARE 10-digit number (no `+`) defaults to `+1` (US).
 *   - NEVER strip a `+` / force `+1` on a value that already carries a country code —
 *     international numbers (+44…, +52…) pass through unchanged.
 *
 * The client is PERMISSIVE: it strips formatting separators and applies the canonical
 * form, but NEVER hard-blocks a plausible value. The API is the final arbiter — it
 * returns a helpful 422 when a value is genuinely unroutable. We optimize for "the
 * happy path is clean" without ever rejecting a number the user could legitimately want.
 *
 * ─── Algorithm (normalizeNumberInput) ─────────────────────────────────────────
 *   1. s = raw.trim(); if '' → return ''
 *   2. hasPlus = s starts with '+'
 *   3. d = digits of s (strip '+', space, '-', '(', ')', '.')
 *   4. if hasPlus → return (8..15 digits ? '+'+d : s)   # preserve CC; pass malformed through
 *   5. if d.length === 11 && d[0] === '1' && d[1] ∈ 2-9        → '+'+d
 *   6. if d.length === 10 && d[0] ∈ 2-9                        → '+1'+d   # bare US default
 *   7. if /^\d{3,6}$/.test(d)                                  → d        # local extension
 *   8. otherwise                                              → s.trim()  # unknown — pass raw
 *
 * ─── Test vectors (must agree across all three layers) ─────────────────────────
 *   '5551234567'       → '+15551234567'
 *   '15551234567'      → '+15551234567'
 *   '+15551234567'     → '+15551234567'
 *   '(555) 123-4567'   → '+15551234567'
 *   '+44 7911 123456'  → '+447911123456'   (country code PRESERVED — not forced to +1)
 *   '1001'             → '1001'             (3-6 digit local extension passes through)
 */

/** Characters treated as formatting separators and stripped when collecting digits. */
const SEPARATORS_RE = /[\s\-().+]/g;

/** A valid NANP leading digit for area code / exchange is 2–9 (never 0 or 1). */
function isNanpLead(ch: string): boolean {
  return ch >= '2' && ch <= '9';
}

/**
 * Normalize a user-entered phone number to the canonical E.164 form.
 *
 * Permissive by design: unknown/short/international-but-odd inputs are returned as
 * the trimmed original rather than rejected, so the API can 422 with guidance.
 *
 * @param raw The raw string exactly as typed (may include spaces, dashes, parens).
 * @returns The canonical value, or a passthrough of the trimmed input.
 */
export function normalizeNumberInput(raw: string): string {
  const s = raw.trim();
  if (s === '') return '';

  const hasPlus = s.startsWith('+');
  const digits = s.replace(SEPARATORS_RE, '');

  // Already carries a country code (leading '+'): preserve it. Only re-emit a clean
  // '+<digits>' when the length is a plausible E.164 (8..15 digits, per ITU-T E.164).
  // If it looks malformed, pass the raw value through and let the API decide.
  if (hasPlus) {
    return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : s;
  }

  // 11 digits with a US country-code prefix: 1 + valid NANP area code.
  if (digits.length === 11 && digits[0] === '1' && isNanpLead(digits[1])) {
    return `+${digits}`;
  }

  // Bare 10-digit US number (no country code): default to +1.
  if (digits.length === 10 && isNanpLead(digits[0])) {
    return `+1${digits}`;
  }

  // Local extension (3–6 digits, no separators): pass through unchanged. This is a
  // legitimate forward_to target for on-net local delivery.
  if (/^\d{3,6}$/.test(digits)) {
    return digits;
  }

  // Unknown shape — do NOT block. Return the trimmed original; the API is the arbiter.
  return s;
}

/**
 * Advisory check: does the input look like something the platform can route?
 *
 * ADVISORY ONLY. Use this for a soft hint or to enable a Save button — NEVER to
 * hard-disable submit on a plausible value. A `true` result means the normalized
 * value is either a `+`-prefixed 8..15-digit E.164 number or a 3–6 digit extension.
 *
 * @param raw The raw string exactly as typed.
 * @returns true if the normalized form looks enterable; false otherwise.
 */
export function isEnterableNumber(raw: string): boolean {
  const normalized = normalizeNumberInput(raw);
  if (normalized === '') return false;

  // Full E.164: '+' followed by 8..15 digits.
  if (/^\+\d{8,15}$/.test(normalized)) return true;

  // Local extension: 3–6 digits.
  if (/^\d{3,6}$/.test(normalized)) return true;

  return false;
}

// Re-export the display formatter so callers can import both the normalizer (for
// writes) and the formatter (for reads) from a single phone module if they prefer.
export { fmt } from './format';
