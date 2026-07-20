/**
 * VoicemailRail — the left frosted column: a "new mailbox" action, the mailbox
 * switcher, the four folders, and (admins only) the customer scope selector.
 * Pure presentation; all state is lifted to the page.
 */

import type { ReactNode } from 'react';
import { Inbox, Mail, Star, Trash2, Plus } from 'lucide-react';
import { AdminCustomerSelector } from '../../../components/AdminCustomerSelector';
import type { VoicemailMailbox } from '../../../types/voicemail';
import type { Folder } from '../types';
import { ACCENT, railColumn, railHeader, railTitle, newMailboxBtn, railFolders, railAdmin, folderBtn, folderCount } from '../styles';
import { GLASS } from '../../../components/glass/glass';
import { MailboxSwitcher } from './MailboxSwitcher';

const FOLDERS: { id: Folder; label: string; icon: ReactNode }[] = [
  { id: 'inbox', label: 'Inbox', icon: <Inbox size={15} /> },
  { id: 'unread', label: 'Unread', icon: <Mail size={15} /> },
  { id: 'saved', label: 'Saved', icon: <Star size={15} /> },
  { id: 'trash', label: 'Trash', icon: <Trash2 size={15} /> },
];

interface VoicemailRailProps {
  mailboxes: VoicemailMailbox[];
  mailboxId: number | null;
  onSelectMailbox: (id: number) => void;
  folder: Folder;
  onFolder: (f: Folder) => void;
  counts: Record<Folder, number | undefined>;
  onNewMailbox: () => void;
  isAdmin: boolean;
  customerId: number | undefined;
  onSelectCustomer: (id: number | undefined) => void;
}

export function VoicemailRail({
  mailboxes,
  mailboxId,
  onSelectMailbox,
  folder,
  onFolder,
  counts,
  onNewMailbox,
  isAdmin,
  customerId,
  onSelectCustomer,
}: VoicemailRailProps) {
  return (
    <aside style={railColumn}>
      <div style={railHeader}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <span style={railTitle}>Voicemail</span>
          <button type="button" onClick={onNewMailbox} title="New mailbox" style={newMailboxBtn}>
            <Plus size={12} strokeWidth={2.5} /> New
          </button>
        </div>
        <MailboxSwitcher mailboxes={mailboxes} selectedId={mailboxId} onSelect={onSelectMailbox} />
      </div>

      <div style={railFolders}>
        {FOLDERS.map((f) => {
          const active = folder === f.id;
          const count = counts[f.id];
          return (
            <button key={f.id} type="button" onClick={() => onFolder(f.id)} style={folderBtn(active)}>
              <span style={{ color: active ? ACCENT : GLASS.textFaint, display: 'flex' }}>{f.icon}</span>
              <span style={{ flex: 1, textAlign: 'left', fontSize: '0.83rem', fontWeight: active ? 700 : 500 }}>
                {f.label}
              </span>
              {count !== undefined && count > 0 && <span style={folderCount(active)}>{count}</span>}
            </button>
          );
        })}
      </div>

      {isAdmin && (
        <div style={railAdmin}>
          <AdminCustomerSelector
            selectedCustomerId={customerId}
            onSelect={onSelectCustomer}
            accent={ACCENT}
          />
        </div>
      )}
    </aside>
  );
}
