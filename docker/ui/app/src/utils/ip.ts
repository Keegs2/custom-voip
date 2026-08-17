/**
 * Client-side IP / CIDR syntax validation for the FCC KYC originating-IP
 * capture on the onboarding intake form.
 *
 * Mirrors the backend rules in docker/api/src/routers/onboarding.py
 * (`_validate_ip_or_cidr`): a bare IPv4/IPv6 address, or a CIDR block no
 * wider than /24 (IPv4) / /64 (IPv6). Syntax only — private/reserved
 * ranges are accepted and no reachability check is made. The API remains
 * the final arbiter; this just prevents avoidable 422 round-trips.
 */

export type IpValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/** Strict dotted-quad IPv4: four 0-255 octets, no leading zeros. */
function isValidIpv4(addr: string): boolean {
  const parts = addr.split('.');
  if (parts.length !== 4) return false;
  return parts.every(
    (p) =>
      /^\d{1,3}$/.test(p) &&
      (p.length === 1 || p[0] !== '0') && // Python ipaddress rejects leading zeros
      Number(p) <= 255,
  );
}

/** IPv6 with optional `::` compression and optional embedded IPv4 tail. */
function isValidIpv6(addr: string): boolean {
  let s = addr;

  // Embedded IPv4 tail (e.g. ::ffff:192.0.2.1) — validate it, then stand in
  // two hex groups so the group-count arithmetic below stays uniform.
  const v4Tail = s.match(/^(.*:)((?:\d{1,3}\.){3}\d{1,3})$/);
  if (v4Tail) {
    if (!isValidIpv4(v4Tail[2])) return false;
    s = `${v4Tail[1]}0:0`;
  }

  if (s === '::') return true;

  const halves = s.split('::');
  if (halves.length > 2) return false; // at most one '::'

  const parseGroups = (part: string): string[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    return groups.every((g) => /^[0-9a-fA-F]{1,4}$/.test(g)) ? groups : null;
  };

  const head = parseGroups(halves[0]);
  if (head === null) return false;
  if (halves.length === 1) return head.length === 8;

  const tail = parseGroups(halves[1]);
  if (tail === null) return false;
  // '::' must compress at least one zero group.
  return head.length + tail.length <= 7;
}

/**
 * Validate one originating-IP entry exactly as the backend will.
 *
 * @returns `{ ok: true, value }` with the trimmed entry, or
 *          `{ ok: false, error }` with a user-facing message.
 */
export function validateIpOrCidr(raw: string): IpValidationResult {
  const entry = raw.trim();
  if (!entry) {
    return { ok: false, error: 'Enter an IP address or CIDR block' };
  }

  const slash = entry.indexOf('/');
  if (slash !== -1) {
    const addr = entry.slice(0, slash);
    const prefixStr = entry.slice(slash + 1);
    if (!/^\d{1,3}$/.test(prefixStr)) {
      return { ok: false, error: `"${entry}" has an invalid CIDR prefix` };
    }
    const prefix = Number(prefixStr);

    if (isValidIpv4(addr)) {
      if (prefix > 32) {
        return { ok: false, error: `"/${prefix}" is not a valid IPv4 prefix` };
      }
      if (prefix < 24) {
        return {
          ok: false,
          error: 'CIDR block too large — /24 is the widest IPv4 block accepted',
        };
      }
      return { ok: true, value: entry };
    }

    if (isValidIpv6(addr)) {
      if (prefix > 128) {
        return { ok: false, error: `"/${prefix}" is not a valid IPv6 prefix` };
      }
      if (prefix < 64) {
        return {
          ok: false,
          error: 'CIDR block too large — /64 is the widest IPv6 block accepted',
        };
      }
      return { ok: true, value: entry };
    }

    return { ok: false, error: `"${addr}" is not a valid IP address` };
  }

  if (isValidIpv4(entry) || isValidIpv6(entry)) {
    return { ok: true, value: entry };
  }
  return { ok: false, error: `"${entry}" is not a valid IPv4 or IPv6 address` };
}
