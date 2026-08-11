/**
 * SidebarCollapse — the desktop sidebar-collapse toggle tab, shared by BOTH
 * shells: AppLayout (the standard authenticated shell) and TroubleshootingPage
 * (which renders outside AppLayout with its own <Sidebar/>).
 *
 * The persisted collapse state lives in useSidebarCollapse.ts (localStorage
 * `sidebar_collapsed` — shared key, so collapse state carries across
 * navigation between the two shells). This module renders the cobalt toggle
 * pill seated on the sidebar↔content boundary (`.sidebar-collapse-tab` in
 * index.css — hidden <768px, where the mobile drawer takes over).
 */
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../../utils/cn';

interface SidebarCollapseTabProps {
  collapsed: boolean;
  onToggle: () => void;
}

/** Collapse/expand tab — cobalt pill on the sidebar↔content boundary.
    Desktop only (hidden <768px, where the mobile drawer takes over —
    see .sidebar-collapse-tab in index.css). */
export function SidebarCollapseTab({ collapsed, onToggle }: SidebarCollapseTabProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={cn(
        'sidebar-collapse-tab',
        collapsed && 'sidebar-collapse-tab--collapsed',
      )}
      aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      aria-expanded={!collapsed}
      title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
    >
      {collapsed
        ? <ChevronRight size={16} strokeWidth={3} aria-hidden="true" />
        : <ChevronLeft  size={16} strokeWidth={3} aria-hidden="true" />}
    </button>
  );
}
