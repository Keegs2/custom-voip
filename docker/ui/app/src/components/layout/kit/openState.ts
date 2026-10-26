/**
 * Open / closed state for the layout kit's expandable pieces, with an
 * OPTIONAL per-section memory in localStorage.
 *
 * Storage is a convenience only (docker/ui/CLAUDE.md "Layout" rulebook):
 * every read and write is try/catch'd, a private window or blocked storage
 * simply falls back to the default, and nothing about the page depends on
 * it. One key per section: `crag_open:<persistKey>` = '1' | '0'.
 * Name keys `<page>:<section>` (e.g. `vm:pin`, `reporting:glossary`).
 */
import { useCallback, useState } from 'react';

const PREFIX = 'crag_open:';

/** The remembered state, or null when there is none (or storage is unavailable). */
export function readOpen(persistKey: string): boolean | null {
  try {
    const raw = window.localStorage.getItem(PREFIX + persistKey);
    return raw === '1' ? true : raw === '0' ? false : null;
  } catch {
    return null;
  }
}

/** Remembers the state; silently does nothing when storage is unavailable. */
export function writeOpen(persistKey: string, open: boolean): void {
  try {
    window.localStorage.setItem(PREFIX + persistKey, open ? '1' : '0');
  } catch {
    // Storage blocked / full / private mode — the page works without it.
  }
}

export interface OpenStateOptions {
  /** Starting state when nothing is remembered (uncontrolled). Default false. */
  defaultOpen?: boolean;
  /** Controlled state. When set, `onOpenChange` must keep it in step. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Remember the state per section (`<page>:<section>`). Uncontrolled only. */
  persistKey?: string;
}

/**
 * `[open, setOpen]` for a disclosure: controlled when `open` is given,
 * otherwise local state seeded from storage (when `persistKey`) or
 * `defaultOpen`.
 */
export function useOpenState({ defaultOpen = false, open, onOpenChange, persistKey }: OpenStateOptions) {
  const [local, setLocal] = useState<boolean>(() => {
    if (!persistKey) return defaultOpen;
    return readOpen(persistKey) ?? defaultOpen;
  });
  const controlled = open !== undefined;
  const value = controlled ? open : local;

  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setLocal(next);
      if (persistKey && !controlled) writeOpen(persistKey, next);
      onOpenChange?.(next);
    },
    [controlled, onOpenChange, persistKey],
  );

  return [value, setOpen] as const;
}
