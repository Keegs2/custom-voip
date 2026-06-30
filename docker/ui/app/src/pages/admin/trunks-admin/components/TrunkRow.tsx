/**
 * TrunkRow — one trunk row plus its expandable detail row. The row click toggles
 * expansion; the actions cell (toggle enabled / delete) stops propagation so it
 * does not also toggle the row.
 */

import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import type { Trunk } from '../../../../types/trunk';
import { AuthTypeBadge, EnabledBadge } from './badges';
import { InlineTrunkName } from './InlineTrunkName';
import { TrunkExpanded } from './TrunkExpanded';
import { COL_COUNT } from '../types';
import { td, rowStyle, statusDot, monoFaint, cellNum, cellMuted, rowActionBtn } from '../styles';

interface TrunkRowProps {
  trunk: Trunk;
  isExpanded: boolean;
  onToggleExpand: (id: number) => void;
  onToggleEnabled: (trunk: Trunk) => void;
  onDelete: (trunk: Trunk) => void;
}

export function TrunkRow({ trunk, isExpanded, onToggleExpand, onToggleEnabled, onDelete }: TrunkRowProps) {
  return (
    <>
      <tr
        style={rowStyle(isExpanded)}
        onMouseEnter={(e) => {
          if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = 'rgba(255,255,255,0.03)';
        }}
        onMouseLeave={(e) => {
          if (!isExpanded) (e.currentTarget as HTMLTableRowElement).style.background = 'transparent';
        }}
        onClick={() => onToggleExpand(trunk.id)}
      >
        <td style={td}><span style={monoFaint}>#{trunk.id}</span></td>

        <td style={td}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={statusDot(isExpanded)} />
            <InlineTrunkName trunkId={trunk.id} name={trunk.trunk_name} />
          </div>
        </td>

        <td style={td}>
          <span style={{ color: GLASS.textMuted, fontSize: '0.83rem' }}>
            {trunk.customer_name ?? `#${trunk.customer_id}`}
          </span>
        </td>

        <td style={td}><AuthTypeBadge type={trunk.auth_type} /></td>
        <td style={td}><span style={cellNum}>{trunk.max_channels}</span></td>
        <td style={td}><span style={cellNum}>{trunk.cps_limit}</span></td>
        <td style={td}><span style={cellMuted}>{trunk.ip_count ?? '—'}</span></td>
        <td style={td}><span style={cellMuted}>{trunk.did_count ?? '—'}</span></td>
        <td style={td}><EnabledBadge enabled={trunk.enabled} /></td>

        <td style={{ ...td, textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
            <button
              type="button"
              title={trunk.enabled ? 'Disable trunk' : 'Enable trunk'}
              onClick={() => onToggleEnabled(trunk)}
              style={rowActionBtn(trunk.enabled ? 'accent' : 'muted')}
            >
              {trunk.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              type="button"
              title="Delete trunk"
              onClick={() => onDelete(trunk)}
              style={rowActionBtn('danger')}
            >
              Delete
            </button>
          </div>
        </td>
      </tr>

      {isExpanded && (
        <tr>
          <td colSpan={COL_COUNT} style={{ padding: 0, borderTop: `1px solid ${hexToRgba(GLASS.accent, 0.15)}` }}>
            <TrunkExpanded
              trunk={trunk}
              onDelete={() => {
                if (!confirm(`Delete trunk "${trunk.trunk_name}"?\n\nThis will remove all associated IPs and DIDs. This cannot be undone.`)) return;
                onDelete(trunk);
              }}
            />
          </td>
        </tr>
      )}
    </>
  );
}
