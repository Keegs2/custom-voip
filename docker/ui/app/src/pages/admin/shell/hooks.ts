/**
 * Derived-state helpers for the admin tab shells. Pure functions (no hooks) so
 * the thin pages and the tab-bar component can share the active-tab logic.
 */

import type { ShellTab } from './types';

/**
 * Whether `tab` is the active tab for the current `pathname`.
 *
 * A tab is active when the path equals or is nested under its `to`, EXCEPT when
 * another tab is a more specific match (e.g. `/admin/customers` must not light up
 * when the real route is `/admin/customers/users`, which has its own tab).
 */
export function isTabActive(tabs: ShellTab[], tab: ShellTab, pathname: string): boolean {
  const hasMoreSpecificTab = tabs.some(
    (other) => other !== tab && other.to.startsWith(tab.to + '/') && pathname.startsWith(other.to),
  );
  return !hasMoreSpecificTab && (pathname === tab.to || pathname.startsWith(tab.to + '/'));
}
