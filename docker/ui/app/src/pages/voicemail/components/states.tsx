/**
 * Empty / loading state surfaces for the voicemail inbox — all frosted-glass,
 * blue-accented, driven entirely by props.
 */

import { Inbox, Mail, Plus } from 'lucide-react';
import type { VoicemailMailbox } from '../../../types/voicemail';
import type { Folder } from '../types';
import {
  stateWrap,
  stateIcon,
  stateTitle,
  stateBody,
  spinnerRing,
  newMailboxCta,
} from '../styles';

export function CenterSpinner() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
      <div style={spinnerRing()} />
    </div>
  );
}

export function EmptyFolder({ folder, hasSearch }: { folder: Folder; hasSearch: boolean }) {
  const text = hasSearch
    ? 'No messages match your search.'
    : folder === 'unread'
      ? 'You’re all caught up — no unread messages.'
      : folder === 'saved'
        ? 'No saved messages yet.'
        : folder === 'trash'
          ? 'Trash is empty.'
          : 'No messages in this mailbox yet.';
  return (
    <div style={stateWrap}>
      <div style={stateIcon()}><Inbox size={26} /></div>
      <span style={stateBody}>{text}</span>
    </div>
  );
}

export function ReadingEmpty({ mailbox }: { mailbox: VoicemailMailbox | null }) {
  return (
    <div style={{ ...stateWrap, gap: 16, padding: 48 }}>
      <div style={stateIcon(true)}><Mail size={32} /></div>
      <div style={{ textAlign: 'center', maxWidth: 300 }}>
        <div style={{ ...stateTitle, marginBottom: 6 }}>
          {mailbox ? 'Select a message' : 'No mailbox selected'}
        </div>
        <div style={stateBody}>
          Choose a message from the list to listen, read its transcript, and reply.
        </div>
      </div>
    </div>
  );
}

export function NoMailboxes({ onCreate }: { onCreate: () => void }) {
  return (
    <div style={{ ...stateWrap, gap: 16 }}>
      <div style={stateIcon(true)}><Inbox size={30} /></div>
      <div>
        <div style={{ ...stateTitle, marginBottom: 6 }}>No voicemail boxes yet</div>
        <div style={{ ...stateBody, maxWidth: 240, marginBottom: 16 }}>
          Create an encrypted voicemail box — buy a dedicated number or add it to a
          line you already have.
        </div>
        <button type="button" onClick={onCreate} style={newMailboxCta}>
          <Plus size={15} strokeWidth={2.5} /> New mailbox
        </button>
      </div>
    </div>
  );
}
