/**
 * MessageList — the middle frosted column: a search field plus the rows for the
 * active folder, falling back to the no-mailbox / loading / empty states. All
 * data + selection is lifted to the page.
 */

import { useState } from 'react';
import { Search } from 'lucide-react';
import type { VoicemailMessage } from '../../../types/voicemail';
import { GLASS } from '../../../components/glass/glass';
import type { Folder } from '../types';
import { listColumn, listSearchWrap, searchField, searchInput, listScroll } from '../styles';
import { MessageRow } from './MessageRow';
import { CenterSpinner, EmptyFolder, NoMailboxes } from './states';

interface MessageListProps {
  search: string;
  onSearch: (v: string) => void;
  folder: Folder;
  messages: VoicemailMessage[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  loading: boolean;
  noMailbox: boolean;
  onCreateMailbox: () => void;
}

export function MessageList({
  search,
  onSearch,
  folder,
  messages,
  selectedId,
  onSelect,
  loading,
  noMailbox,
  onCreateMailbox,
}: MessageListProps) {
  // Local focus state — visual only (React #310: hook before any return).
  const [focused, setFocused] = useState(false);

  return (
    <section style={listColumn}>
      <div style={listSearchWrap}>
        <div style={searchField(focused)}>
          <Search size={14} style={{ color: focused ? GLASS.accent : GLASS.textFaint, flexShrink: 0 }} />
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            placeholder="Search messages"
            style={searchInput}
          />
        </div>
      </div>

      <div style={listScroll}>
        {noMailbox ? (
          <NoMailboxes onCreate={onCreateMailbox} />
        ) : loading ? (
          <CenterSpinner />
        ) : messages.length === 0 ? (
          <EmptyFolder folder={folder} hasSearch={search.trim().length > 0} />
        ) : (
          messages.map((m) => (
            <MessageRow key={m.id} message={m} selected={m.id === selectedId} onClick={() => onSelect(m.id)} />
          ))
        )}
      </div>
    </section>
  );
}
