/**
 * GlassTrunkCard — one SIP trunk as a frosted, lift-on-hover glass card with an
 * expandable detail body. Enabled trunks glow in the app accent (blue); disabled
 * trunks fade to faint. Purely presentational apart from local expand/hover UI.
 */

import { useState } from 'react';
import type { Trunk } from '../../../types/trunk';
import { GlassCard, GlassChip } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import { Button } from '../../../components/ui/Button';
import { TrunkDetail } from './TrunkDetail';
import { IconChevron } from './icons';
import { trunkName, trunkMeta, authPill, expandToggle } from '../styles';

interface GlassTrunkCardProps {
  trunk: Trunk;
  index: number;
  isAdmin: boolean;
  canManage: boolean;
  showCustomer: boolean;
  onDelete: (t: Trunk) => void;
  deleting: boolean;
}

export function GlassTrunkCard({
  trunk,
  index,
  isAdmin,
  canManage,
  showCustomer,
  onDelete,
  deleting,
}: GlassTrunkCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [toggleHover, setToggleHover] = useState(false);

  const accent = trunk.enabled ? GLASS.accent : GLASS.textFaint;

  return (
    <GlassCard index={index} accent={accent}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, padding: '22px 24px 16px' }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={trunkName}>{trunk.trunk_name}</span>
            <GlassChip
              label={trunk.enabled ? 'Active' : 'Disabled'}
              color={trunk.enabled ? GLASS.accent : GLASS.danger}
              dot
            />
            <span style={authPill(accent)}>{trunk.auth_type} auth</span>
          </div>
          <div style={trunkMeta}>
            {showCustomer && trunk.customer_name && <span style={{ color: GLASS.textMuted }}>{trunk.customer_name} ·</span>}
            <span>{trunk.max_channels} channels</span>
            <span>· {trunk.cps_limit} CPS</span>
            {trunk.ip_count != null && <span>· {trunk.ip_count} IP{trunk.ip_count !== 1 ? 's' : ''}</span>}
            {trunk.did_count != null && <span>· {trunk.did_count} DID{trunk.did_count !== 1 ? 's' : ''}</span>}
            {trunk.package_name && <span>· {trunk.package_name}</span>}
            <span>· added {new Date(trunk.created_at).toLocaleDateString()}</span>
          </div>
        </div>
        {isAdmin && (
          <Button variant="danger" size="xs" loading={deleting} onClick={() => onDelete(trunk)}>
            Delete
          </Button>
        )}
      </div>

      {/* Expand toggle */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        onMouseEnter={() => setToggleHover(true)}
        onMouseLeave={() => setToggleHover(false)}
        style={expandToggle(toggleHover)}
      >
        <IconChevron up={expanded} />
        {expanded ? 'Hide details' : 'Live activity, authorized IPs & DIDs'}
      </button>

      {expanded && <TrunkDetail trunk={trunk} canManage={canManage} />}
    </GlassCard>
  );
}
