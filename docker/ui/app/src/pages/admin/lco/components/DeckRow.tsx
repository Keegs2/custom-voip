/**
 * DeckRow — one rate-deck entry. Owns only its hover state (visual). Enabled/
 * disabled is shown as a dot; edit + delete come via props.
 */

import { useState } from 'react';
import { Pencil, Trash2 } from 'lucide-react';
import { GLASS } from '../../../../components/glass/glass';
import { fmtRate } from '../../../../utils/format';
import type { RateDeck } from '../../../../types/lco';
import { td, prefixCell, costCell, dash, jurChip, iconBtn } from '../styles';

interface DeckRowProps {
  deck: RateDeck;
  onEdit: () => void;
  onDelete: () => void;
}

export function DeckRow({ deck, onEdit, onDelete }: DeckRowProps) {
  const [hover, setHover] = useState<string | null>(null);

  return (
    <tr>
      <td style={td()}><span style={prefixCell}>{deck.prefix}</span></td>
      <td style={td({ muted: true })}>{deck.gateway_name ?? `#${deck.carrier_id}`}</td>
      <td style={td({ right: true })}><span style={{ ...costCell, color: GLASS.success }}>{fmtRate(deck.cost_per_min)}</span></td>
      <td style={td()}><span style={jurChip()}>{deck.jurisdiction}</span></td>
      <td style={td({ right: true, muted: true })}>{deck.priority}</td>
      <td style={td()}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: '0.68rem',
            fontWeight: 700,
            color: deck.enabled ? GLASS.success : GLASS.textFaint,
          }}
        >
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: deck.enabled ? GLASS.success : GLASS.textFaint }} />
          {deck.enabled ? 'On' : 'Off'}
        </span>
      </td>
      <td style={td({ muted: true })}>{deck.description ?? <span style={dash}>—</span>}</td>
      <td style={td({ right: true })}>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onEdit} onMouseEnter={() => setHover('edit')} onMouseLeave={() => setHover(null)} style={iconBtn('accent', hover === 'edit')}>
            <Pencil size={12} />
          </button>
          <button type="button" onClick={onDelete} onMouseEnter={() => setHover('del')} onMouseLeave={() => setHover(null)} style={iconBtn('danger', hover === 'del')}>
            <Trash2 size={12} />
          </button>
        </div>
      </td>
    </tr>
  );
}
