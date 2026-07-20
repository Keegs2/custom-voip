/**
 * TabBar — the inner glass segmented control switching between the DID feature's
 * tabs (Inventory / Available / Assignments / My Numbers). Driven entirely by
 * props.
 */

import { Phone, CheckCircle, Users } from 'lucide-react';
import type { ReactNode } from 'react';
import type { TabDef, TabId } from '../types';
import { tabBarWrap, tabBtn } from '../styles';

const TAB_ICON: Record<TabId, ReactNode> = {
  inventory:    <Phone size={13} />,
  available:    <CheckCircle size={13} />,
  assignments:  <Users size={13} />,
  'my-numbers': <Phone size={13} />,
};

interface TabBarProps {
  tabs: TabDef[];
  activeId: TabId;
  onChange: (id: TabId) => void;
}

export function TabBar({ tabs, activeId, onChange }: TabBarProps) {
  return (
    <div style={tabBarWrap} role="tablist" aria-label="Number management sections">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.id)}
            style={tabBtn(active)}
          >
            <span style={{ display: 'flex', alignItems: 'center', opacity: active ? 1 : 0.65 }}>
              {TAB_ICON[tab.id]}
            </span>
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
