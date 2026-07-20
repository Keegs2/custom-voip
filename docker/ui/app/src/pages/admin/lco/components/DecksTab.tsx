/**
 * DecksTab — rate-deck management: server search/filter + load-more table, plus
 * add / edit / delete / CSV import. Owns the deck tab's top-level state; data +
 * mutations live in the feature hooks. React #310: hooks first.
 */

import { useCallback, useState } from 'react';
import { Layers } from 'lucide-react';
import { Pagination } from '../../../../components/ui/Pagination';
import { GLASS } from '../../../../components/glass/glass';
import type { Carrier } from '../../../../types/carrier';
import type { RateDeck } from '../../../../types/lco';
import { useDecks, useDeleteDeck } from '../hooks';
import { PAGE_SIZE } from '../types';
import { DecksControlsBar } from './DecksControlsBar';
import { DecksTable } from './DecksTable';
import { DeckFormModal } from './DeckFormModal';
import { DeckImportModal } from './DeckImportModal';
import { TableSkeleton, StateCard } from './states';

interface DecksTabProps {
  carriers: Carrier[];
}

export function DecksTab({ carriers }: DecksTabProps) {
  const [carrierId, setCarrierId] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [committedSearch, setCommittedSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [resetKey, setResetKey] = useState(0);

  const [showAdd, setShowAdd] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [editDeck, setEditDeck] = useState<RateDeck | null>(null);

  const { items, total, shownCount, isLoading, isFetching, isError, hasData } = useDecks({
    carrierId,
    search: committedSearch,
    offset,
    resetKey,
  });
  const del = useDeleteDeck();

  const recompute = useCallback(() => {
    setOffset(0);
    setResetKey((k) => k + 1);
  }, []);

  const onCarrierChange = useCallback(
    (v: string) => {
      setCarrierId(v);
      recompute();
    },
    [recompute],
  );

  const onSearchCommit = useCallback(() => {
    setCommittedSearch(searchDraft);
    recompute();
  }, [searchDraft, recompute]);

  const handleDelete = (deck: RateDeck) => {
    if (window.confirm(`Delete rate for prefix ${deck.prefix}?`)) del.mutate(deck.id);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <DecksControlsBar
        carrierId={carrierId}
        onCarrierChange={onCarrierChange}
        search={searchDraft}
        onSearchChange={setSearchDraft}
        onSearchCommit={onSearchCommit}
        carriers={carriers}
        onAdd={() => setShowAdd(true)}
        onImport={() => setShowImport(true)}
      />

      {isLoading && offset === 0 ? (
        <TableSkeleton />
      ) : isError ? (
        <StateCard accent={GLASS.danger} icon={<Layers size={26} />} title="Couldn't load rate decks" body="The request failed. Try again." />
      ) : hasData ? (
        <>
          <DecksTable decks={items} onEdit={setEditDeck} onDelete={handleDelete} />
          <Pagination shown={shownCount} total={total} onLoadMore={() => setOffset((o) => o + PAGE_SIZE)} loading={isFetching && offset > 0} />
        </>
      ) : null}

      {showAdd && <DeckFormModal carriers={carriers} onClose={() => setShowAdd(false)} />}
      {showImport && <DeckImportModal carriers={carriers} onClose={() => setShowImport(false)} />}
      {editDeck && <DeckFormModal deck={editDeck} carriers={carriers} onClose={() => setEditDeck(null)} />}
    </div>
  );
}
