/**
 * ConflictDialog — someone else (a teammate, another tab) saved this flow
 * after it was opened here: the server answered 409 `stale_revision`.
 * Autosave has stopped; nothing is lost yet. Two clear ways out:
 *
 *   Load the latest version  — drop the edits made here, show theirs.
 *   Keep my version          — save this draft over theirs (at the
 *                              server's current revision).
 */
import { useState } from 'react';
import { GitMerge } from 'lucide-react';
import { VmDialog } from '../../pages/voicemail/VmDialog';

export interface ConflictDialogProps {
  onLoadLatest: () => Promise<boolean>;
  onKeepMine: () => Promise<boolean>;
}

export function ConflictDialog({ onLoadLatest, onKeepMine }: ConflictDialogProps) {
  const [pending, setPending] = useState<'latest' | 'mine' | null>(null);
  const run = async (which: 'latest' | 'mine') => {
    setPending(which);
    await (which === 'latest' ? onLoadLatest() : onKeepMine());
    setPending(null);
  };
  return (
    <VmDialog
      title="This flow was changed somewhere else"
      sub="Someone saved it — maybe you, in another tab — after you opened it here."
      onClose={() => undefined}
      busy
      width={540}
      footer={
        <>
          <button type="button" className="dl-btn dl-btn-ghost" disabled={pending !== null} onClick={() => void run('latest')}>
            {pending === 'latest' && <span className="vm-spin" aria-hidden="true" />}
            Load the latest version
          </button>
          <button
            type="button"
            className="dl-btn dl-btn-primary"
            disabled={pending !== null}
            onClick={() => void run('mine')}
            data-autofocus
          >
            {pending === 'mine' && <span className="vm-spin vm-spin-light" aria-hidden="true" />}
            Keep my version
          </button>
        </>
      }
    >
      <div className="ivr-conflict">
        <span className="ivr-conflict-icon" aria-hidden="true">
          <GitMerge size={20} />
        </span>
        <div className="vm-confirm-body">
          <p>Your edits since then aren’t saved yet, and saving has paused so neither change is lost by accident.</p>
          <ul className="ivr-conflict-list">
            <li>
              <strong>Load the latest version</strong> shows the other change and drops the edits you made here.
            </li>
            <li>
              <strong>Keep my version</strong> saves what you see now, replacing the other change.
            </li>
          </ul>
          <p className="dl-help">Either way, nothing is published until someone presses Publish.</p>
        </div>
      </div>
    </VmDialog>
  );
}
