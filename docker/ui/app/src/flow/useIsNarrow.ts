/** True below the app's mobile breakpoint (767px) — the builder shows its read-only phone view there. */
import { useSyncExternalStore } from 'react';

const QUERY = '(max-width: 767px)';

function subscribe(onChange: () => void): () => void {
  try {
    const mql = window.matchMedia(QUERY);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  } catch {
    return () => {};
  }
}

function snapshot(): boolean {
  try {
    return window.matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

export function useIsNarrow(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
