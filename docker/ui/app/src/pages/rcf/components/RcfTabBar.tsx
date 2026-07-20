/**
 * RcfTabBar — the Numbers / Call Activity / DID Management segmented control,
 * rendered as a frosted glass strip. Driven entirely by props.
 */

import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { BLUE_LIGHT } from '../styles';
import type { DashboardTab } from '../types';

interface RcfTabBarProps {
  active: DashboardTab;
  onChange: (tab: DashboardTab) => void;
}

const TABS: { id: DashboardTab; label: string; icon: React.ReactNode }[] = [
  {
    id: 'numbers',
    label: 'Numbers',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 13, height: 13 }}>
        <rect x="2" y="2" width="5" height="5" rx="1.5" />
        <rect x="9" y="2" width="5" height="5" rx="1.5" />
        <rect x="2" y="9" width="5" height="5" rx="1.5" />
        <rect x="9" y="9" width="5" height="5" rx="1.5" />
      </svg>
    ),
  },
  {
    id: 'activity',
    label: 'Call Activity',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 13, height: 13 }}>
        <path d="M2 12 L4 8 L6 10 L9 5 L11 7 L14 3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ),
  },
  {
    id: 'dids',
    label: 'DID Management',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 13, height: 13 }}>
        <rect x="2" y="2" width="12" height="12" rx="2" />
        <path d="M5 8h6M8 5v6" strokeLinecap="round" />
      </svg>
    ),
  },
];

export function RcfTabBar({ active, onChange }: RcfTabBarProps) {
  return (
    <GlassPanel padding={4} radius={14}>
      <div style={{ display: 'flex', gap: 0 }}>
        {TABS.map((tab) => {
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChange(tab.id)}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 7,
                padding: '9px 16px',
                borderRadius: 9,
                border: 'none',
                cursor: 'pointer',
                fontSize: '0.82rem',
                fontWeight: isActive ? 700 : 500,
                fontFamily: 'inherit',
                color: isActive ? GLASS.text : GLASS.textFaint,
                background: isActive
                  ? 'linear-gradient(135deg, rgba(59,130,246,0.22) 0%, rgba(59,130,246,0.12) 100%)'
                  : 'transparent',
                boxShadow: isActive ? '0 0 14px rgba(59,130,246,0.18), inset 0 1px 0 rgba(255,255,255,0.06)' : 'none',
                transition: 'all 0.18s ease',
                whiteSpace: 'nowrap',
                letterSpacing: isActive ? '-0.01em' : 'normal',
                position: 'relative',
              }}
            >
              <span style={{ color: isActive ? BLUE_LIGHT : GLASS.textFaint, transition: 'color 0.18s' }}>{tab.icon}</span>
              {tab.label}
            </button>
          );
        })}
      </div>
    </GlassPanel>
  );
}
