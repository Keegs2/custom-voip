/**
 * DecksTable — frosted, server-paginated rate-deck table. Pure composition.
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import type { RateDeck } from '../../../../types/lco';
import { tableWrap, table, th, td } from '../styles';
import { DeckRow } from './DeckRow';

interface DecksTableProps {
  decks: RateDeck[];
  onEdit: (deck: RateDeck) => void;
  onDelete: (deck: RateDeck) => void;
}

export function DecksTable({ decks, onEdit, onDelete }: DecksTableProps) {
  return (
    <GlassPanel padding={0}>
      <div style={tableWrap}>
        <table style={table}>
          <thead>
            <tr>
              <th style={th()}>Prefix</th>
              <th style={th()}>Carrier</th>
              <th style={th(true)}>Cost / min</th>
              <th style={th()}>Jurisdiction</th>
              <th style={th(true)}>Priority</th>
              <th style={th()}>Enabled</th>
              <th style={th()}>Description</th>
              <th style={th(true)}></th>
            </tr>
          </thead>
          <tbody>
            {decks.length === 0 ? (
              <tr>
                <td style={td({ muted: true })} colSpan={8}>No rate-deck entries match these filters.</td>
              </tr>
            ) : (
              decks.map((deck) => <DeckRow key={deck.id} deck={deck} onEdit={() => onEdit(deck)} onDelete={() => onDelete(deck)} />)
            )}
          </tbody>
        </table>
      </div>
    </GlassPanel>
  );
}
