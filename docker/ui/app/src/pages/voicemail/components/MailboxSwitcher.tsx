/**
 * MailboxSwitcher — the glass dropdown that switches between the customer's
 * voicemail boxes. Owns only its open/close state (visual); selection is lifted.
 */

import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { VoicemailMailbox } from '../../../types/voicemail';
import { GLASS } from '../../../components/glass/glass';
import { ACCENT, switcherEmpty, switcherBtn, switcherMenu, switcherItem } from '../styles';

interface MailboxSwitcherProps {
  mailboxes: VoicemailMailbox[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}

export function MailboxSwitcher({ mailboxes, selectedId, onSelect }: MailboxSwitcherProps) {
  // All hooks unconditionally at the top (React #310).
  const [open, setOpen] = useState(false);
  const selected = mailboxes.find((m) => m.id === selectedId);

  if (mailboxes.length === 0) {
    return <div style={switcherEmpty}>No mailboxes yet</div>;
  }

  return (
    <div style={{ position: 'relative' }}>
      <button type="button" onClick={() => setOpen((v) => !v)} style={switcherBtn}>
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
          <span
            style={{
              fontSize: '0.82rem',
              fontWeight: 700,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 180,
            }}
          >
            {selected?.label ?? `Mailbox ${selected?.id ?? ''}`}
          </span>
          <span style={{ fontSize: '0.64rem', color: ACCENT }}>
            {mailboxes.length} mailbox{mailboxes.length === 1 ? '' : 'es'}
          </span>
        </span>
        <ChevronDown
          size={14}
          style={{ color: ACCENT, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}
        />
      </button>

      {open && (
        <div style={switcherMenu}>
          {mailboxes.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => { onSelect(m.id); setOpen(false); }}
              style={switcherItem(m.id === selectedId)}
            >
              <span style={{ fontWeight: 600 }}>{m.label ?? `Mailbox ${m.id}`}</span>
              {m.status !== 'active' && (
                <span style={{ marginLeft: 8, fontSize: '0.64rem', color: GLASS.warning }}>{m.status}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
