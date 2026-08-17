/**
 * useSidebarCollapse — the persisted desktop sidebar-collapse state, shared
 * by BOTH shells: AppLayout (the standard authenticated shell) and
 * TroubleshootingPage (which renders outside AppLayout with its own
 * <Sidebar/>). Because the localStorage key is shared, collapse state
 * carries across navigation between the two shells.
 *
 * The matching toggle UI lives in SidebarCollapse.tsx (<SidebarCollapseTab/>).
 * Kept in a component-free module so both files satisfy
 * react-refresh/only-export-components.
 */
import { useCallback, useState } from 'react';

/* ─── Sidebar collapse persistence ────────────────────────── */

const COLLAPSE_KEY = 'sidebar_collapsed';

function loadCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}

function saveCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0');
  } catch {
    // ignore quota errors
  }
}

interface SidebarCollapseState {
  collapsed: boolean;
  toggleCollapsed: () => void;
}

export function useSidebarCollapse(): SidebarCollapseState {
  const [collapsed, setCollapsed] = useState<boolean>(loadCollapsed);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      saveCollapsed(next);
      return next;
    });
  }, []);

  return { collapsed, toggleCollapsed };
}
