/**
 * QuickActions — admin shortcuts for the 360 view (jump to the customer / DID
 * lookup, plus two placeholder actions that ship later).
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { GLASS } from '../../../../components/glass/glass';
import type { User360Response } from '../types';
import { actionPill, disabledPill } from '../styles';
import { SectionCard } from './SectionCard';
import { IconDndOff, IconExternal, IconReset, IconSearch, IconUsers, IconZap } from './icons';

interface QuickActionsProps {
  data: User360Response;
}

function ActionLink({ to, accent, children }: { to: string; accent: string; children: React.ReactNode }) {
  const [hovered, setHovered] = useState(false);
  return (
    <Link to={to} style={actionPill(accent, hovered)} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      {children}
    </Link>
  );
}

export function QuickActions({ data }: QuickActionsProps) {
  const { user, extension } = data;
  const didSearchUrl = extension?.did ? `/admin/did-search?did=${encodeURIComponent(extension.did)}` : '/admin/did-search';

  return (
    <SectionCard accent="#a855f7" title="Quick Actions" icon={<IconZap />}>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <ActionLink to={`/admin/customers/${user.customer_id}`} accent={GLASS.accent}>
          <IconUsers size={14} />View Customer<IconExternal />
        </ActionLink>

        <ActionLink to={didSearchUrl} accent="#0ea5e9">
          <IconSearch size={14} />View in DID Lookup
        </ActionLink>

        <button type="button" disabled title="Coming soon" style={disabledPill(GLASS.danger)}>
          <IconDndOff />Toggle DND
          <span style={{ fontSize: '0.58rem', color: GLASS.textFaint, letterSpacing: '0.04em', textTransform: 'uppercase' }}>soon</span>
        </button>

        <button type="button" disabled title="Coming soon" style={disabledPill(GLASS.warning)}>
          <IconReset />Reset Extension
          <span style={{ fontSize: '0.58rem', color: GLASS.textFaint, letterSpacing: '0.04em', textTransform: 'uppercase' }}>soon</span>
        </button>
      </div>
    </SectionCard>
  );
}
