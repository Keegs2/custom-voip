/**
 * OnboardingTabs — the status filter strip inside a glass panel. Stateless;
 * driven entirely by props from the page.
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import { STATUS_TABS, type FilterTab } from '../types';
import { tabBtn } from '../styles';

interface OnboardingTabsProps {
  active: FilterTab;
  onSelect: (tab: FilterTab) => void;
}

export function OnboardingTabs({ active, onSelect }: OnboardingTabsProps) {
  return (
    <GlassPanel padding="6px 8px" style={{ overflowX: 'auto' }}>
      <nav style={{ display: 'flex', gap: 4 }} role="tablist" aria-label="Onboarding request filter">
        {STATUS_TABS.map((tab) => {
          const isActive = active === tab.value;
          return (
            <button
              key={tab.value}
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(tab.value)}
              style={tabBtn(isActive)}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>
    </GlassPanel>
  );
}
