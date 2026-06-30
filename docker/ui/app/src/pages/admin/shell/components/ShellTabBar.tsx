/**
 * ShellTabBar — the centered tab strip for an admin tab shell, wrapped in a
 * frosted GlassPanel (blue accent). Stateless: receives the tab set + the current
 * pathname and renders one ShellTab per entry, computing each tab's active state
 * through the shared `isTabActive` helper.
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import type { ShellTab as ShellTabType } from '../types';
import { isTabActive } from '../hooks';
import { ShellTab } from './ShellTab';
import { tabNav } from '../styles';

interface ShellTabBarProps {
  tabs: ShellTabType[];
  pathname: string;
  ariaLabel: string;
}

export function ShellTabBar({ tabs, pathname, ariaLabel }: ShellTabBarProps) {
  return (
    <GlassPanel padding="7px 8px" radius={16} style={{ overflowX: 'auto' }}>
      <nav style={tabNav} role="tablist" aria-label={ariaLabel}>
        {tabs.map((tab) => (
          <ShellTab key={tab.to} label={tab.label} to={tab.to} active={isTabActive(tabs, tab, pathname)} />
        ))}
      </nav>
    </GlassPanel>
  );
}
