/**
 * useShowMore — "show the first N, then expand" for any list or table.
 *
 *   const more = useShowMore(rows, 8);
 *   <tbody id={more.listId}>{more.visible.map(renderRow)}</tbody>
 *   {more.needed && <ShowMoreButton {...more.buttonProps} noun="numbers" />}
 *
 * `visible` is the first `limit` items until expanded (every item when
 * there are no more than `limit`). Changing the items (a filter, a search)
 * keeps the expanded choice; pass `resetKey` to collapse whenever it
 * changes (e.g. the active filter).
 */
import { useCallback, useId, useMemo, useState } from 'react';

export interface ShowMoreState<T> {
  /** The rows to render now. */
  visible: readonly T[];
  /** Every row is shown because the user asked for it. */
  expanded: boolean;
  /** There are more rows than `limit` (render the button only then). */
  needed: boolean;
  total: number;
  /** Rows still hidden (0 when expanded or not needed). */
  hiddenCount: number;
  setExpanded: (next: boolean) => void;
  toggle: () => void;
  /** Put on the list/table body so the button can point at it (aria-controls). */
  listId: string;
  /** Spread onto <ShowMoreButton>. */
  buttonProps: { expanded: boolean; total: number; onToggle: () => void; controls: string };
}

export function useShowMore<T>(items: readonly T[], limit: number, resetKey?: unknown): ShowMoreState<T> {
  const listId = useId();
  // Expanded is remembered per resetKey, so a new key starts collapsed
  // without an effect (derived state, not synchronised state).
  const [expandedFor, setExpandedFor] = useState<{ key: unknown; on: boolean }>({ key: resetKey, on: false });
  const expandedRaw = expandedFor.key === resetKey && expandedFor.on;

  const total = items.length;
  const needed = total > limit;
  const expanded = needed && expandedRaw;
  const visible = useMemo(() => (expanded || !needed ? items : items.slice(0, limit)), [items, limit, expanded, needed]);

  const setExpanded = useCallback((next: boolean) => setExpandedFor({ key: resetKey, on: next }), [resetKey]);
  const toggle = useCallback(
    () => setExpandedFor((cur) => ({ key: resetKey, on: !(cur.key === resetKey && cur.on) })),
    [resetKey],
  );

  return {
    visible,
    expanded,
    needed,
    total,
    hiddenCount: total - visible.length,
    setExpanded,
    toggle,
    listId,
    buttonProps: { expanded, total, onToggle: toggle, controls: listId },
  };
}
