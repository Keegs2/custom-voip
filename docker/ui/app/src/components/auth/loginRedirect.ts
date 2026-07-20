/**
 * Post-login deep-link handoff.
 *
 * RequireAuth stores the blocked location as `state.from` when it bounces an
 * unauthenticated visitor to `/` (where the sidebar login form lives). The
 * login form consumes that state through this helper so a bookmarked or shared
 * deep link (e.g. /call-quality?customer=42) lands where the user intended
 * once they sign in — previously the state was written but never read.
 *
 * The shape is validated defensively: router history state is `unknown`
 * (it survives reloads and can be forged via history.pushState), so this never
 * trusts it blindly and only ever returns a same-app absolute path.
 */
export function consumeLoginRedirect(state: unknown): string | null {
  if (typeof state !== 'object' || state === null || !('from' in state)) return null;

  const from = (state as { from: unknown }).from;
  if (typeof from !== 'object' || from === null) return null;

  const { pathname, search, hash } = from as {
    pathname?: unknown;
    search?: unknown;
    hash?: unknown;
  };

  // Must be an in-app absolute path; reject protocol-relative ("//host") so a
  // forged state can never navigate off-origin.
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) {
    return null;
  }

  const target = `${pathname}${typeof search === 'string' ? search : ''}${typeof hash === 'string' ? hash : ''}`;
  // "/" is where the user already is — nothing to consume.
  return target === '/' ? null : target;
}
