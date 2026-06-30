/**
 * AdminPage — the Customer Management tab shell (routed at /admin).
 *
 * THIN page: composition + the tab definitions only. The glass chrome (hero,
 * tab bar, animated outlet) lives in the co-located `shell/` feature folder.
 * The child tab pages render through <ShellOutlet> and are untouched.
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

const adminTabs: ShellTab[] = [
  { label: 'Onboarding',      to: '/admin/onboarding'      },
  { label: 'Customers',       to: '/admin/customers'       },
  { label: 'Customer Trunks', to: '/admin/trunks'          },
  { label: 'User Lookup',     to: '/admin/customers/users' },
];

export function AdminPage() {
  const location = useLocation();

  return (
    <div style={shellStack}>
      <ShellHero
        eyebrow="Customer Management"
        title="Customer Administration"
        subtitle="Manage customer accounts, trunks, and configurations"
      />
      <ShellTabBar tabs={adminTabs} pathname={location.pathname} ariaLabel="Customer management sections" />
      <ShellOutlet routeKey={location.pathname} />
    </div>
  );
}
