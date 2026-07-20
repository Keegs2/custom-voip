/**
 * TfnRow — one toll-free number. A checkbox drives multi-select (persisted across
 * loaded pages by the page's Set); clicking elsewhere opens the detail drawer.
 * Owns only its hover state (visual); all data + handlers come via props.
 */

import { useState } from 'react';
import { fmt } from '../../../../utils/format';
import { GLASS } from '../../../../components/glass/glass';
import type { Tfn } from '../../../../types/tollFree';
import { td, tfnCell, dash } from '../styles';
import { TfnStatusChip, CrChip } from './StatusChip';

interface TfnRowProps {
  tfn: Tfn;
  selected: boolean;
  onToggleSelect: () => void;
  onView: () => void;
}

export function TfnRow({ tfn, selected, onToggleSelect, onView }: TfnRowProps) {
  const [hover, setHover] = useState(false);

  return (
    <tr
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ background: hover ? 'rgba(255,255,255,0.02)' : 'transparent', transition: 'background 0.12s' }}
    >
      <td style={{ ...td(), width: 44 }}>
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggleSelect}
          aria-label={`Select ${tfn.tfn}`}
          style={{ width: 15, height: 15, accentColor: GLASS.accent, cursor: 'pointer' }}
        />
      </td>
      <td style={td()}>
        <button
          type="button"
          onClick={onView}
          style={{ ...tfnCell, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          title="View details"
        >
          {fmt(tfn.tfn)}
        </button>
      </td>
      <td style={td({ muted: true })}>{tfn.customer_name ?? (tfn.customer_id ? `#${tfn.customer_id}` : <span style={dash}>—</span>)}</td>
      <td style={td()}><TfnStatusChip status={tfn.status} /></td>
      <td style={td()}><CrChip status={tfn.cr_status} /></td>
      <td style={td({ muted: true })}>{tfn.carrier_name ?? <span style={dash}>—</span>}</td>
      <td style={td({ muted: true })}>{tfn.resp_org_id ?? <span style={dash}>—</span>}</td>
      <td style={td({ right: true })}>
        <button
          type="button"
          onClick={onView}
          style={{
            fontSize: '0.72rem',
            fontWeight: 700,
            color: hover ? GLASS.accent : GLASS.textMuted,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontFamily: 'inherit',
            transition: 'color 0.12s',
          }}
        >
          View
        </button>
      </td>
    </tr>
  );
}
