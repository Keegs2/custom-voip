import { useEffect, useState } from 'react';

/**
 * The current time, refreshed every `intervalMs` — so relative labels
 * ("Today", "Deleted in 3 days") stay right on a page left open, and render
 * stays pure (no Date.now() during render).
 */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}
