/** E.164 (+1NPANXXXXXX) helpers shared by the RCF console and DID management. */

/** Extract NPA (area code) from E.164 +1NPANXXXXXX */
export function extractNpa(did: string): string {
  return did.replace(/^\+1/, '').substring(0, 3);
}

/** Extract NXX (exchange) from E.164 +1NPANXXXXXX */
export function extractNxx(did: string): string {
  return did.replace(/^\+1/, '').substring(3, 6);
}
