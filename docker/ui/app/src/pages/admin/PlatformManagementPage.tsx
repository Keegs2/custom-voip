/**
 * PlatformManagementPage — the Platform Management tab shell (routed at
 * /admin/platform).
 *
 * THIN page: composition + the tab definitions only. The glass chrome (hero,
 * tab bar, animated outlet) is shared with AdminPage via the co-located `shell/`
 * feature folder. The child tab pages render through <ShellOutlet> untouched.
 *
 * Spacing: no top padding here — AppLayout owns the page top offset. `shellStack`
 * provides even vertical rhythm between hero → tabs → content.
 */

import { useLocation } from 'react-router-dom';
import { ShellHero } from './shell/components/ShellHero';
import { ShellTabBar } from './shell/components/ShellTabBar';
import { ShellOutlet } from './shell/components/ShellOutlet';
import { shellStack } from './shell/styles';
import type { ShellTab } from './shell/types';

const platformTabs: ShellTab[] = [
  { label: 'Carrier Trunks', to: '/admin/platform/carriers' },
  { label: 'CDRs',           to: '/admin/platform/cdrs'     },
  { label: 'Rates',          to: '/admin/platform/rates'    },
  { label: 'Tiers',          to: '/admin/platform/tiers'    },
  { label: 'Testing',        to: '/admin/platform/sipp'     },
  { label: 'DID Search',     to: '/admin/platform/dids'     },
];

export function PlatformManagementPage() {
  const location = useLocation();

  return (
    <div style={shellStack}>
      <ShellHero
        eyebrow="Platform Management"
        title="Platform Configuration"
        subtitle="Carrier trunks, CDR management, rates, tiers, and testing tools"
      />
      <ShellTabBar tabs={platformTabs} pathname={location.pathname} ariaLabel="Platform sections" />
      <ShellOutlet routeKey={location.pathname} />
    </div>
  );
}
