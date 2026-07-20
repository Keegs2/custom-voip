/**
 * Pure date/time formatting helpers for the Conference feature. Kept in a
 * non-component module so the `components/` folder can import them without
 * tripping react-refresh's "only export components" rule.
 */

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

/** The `*88XX` dial code for a conference room. */
export function dialCodeFor(roomNumber: string): string {
  return `*88${roomNumber}`;
}
