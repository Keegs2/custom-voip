/**
 * ForwardToEditor — the inline forward_to editor (large in cards, compact in
 * table rows). Presentational only: all state + the live PUT mutation come from
 * `useForwardToEditor`. Saving persists and invalidates the ['rcf'] query.
 *
 * React #310: the single hook call sits at the very top, before any return.
 */

import type { RcfEntry } from '../../../types/rcf';
import { GLASS } from '../../../components/glass/glass';
import { fmt } from '../../../utils/format';
import { useForwardToEditor } from '../hooks';
import {
  editorInput,
  editorSaveBtn,
  editorCancelBtn,
  editorValue,
  editorPencil,
} from '../styles';
import { IconPencil } from './icons';

interface ForwardToEditorProps {
  entry: RcfEntry;
  canEdit: boolean;
  size: 'lg' | 'sm';
}

export function ForwardToEditor({ entry, canEdit, size }: ForwardToEditorProps) {
  // ALL hooks first (React #310). The hook owns editing/value/flash + mutation.
  const ed = useForwardToEditor(entry, canEdit);
  const big = size === 'lg';

  if (ed.editing && canEdit) {
    return (
      <div style={{ display: 'flex', flexDirection: big ? 'column' : 'row', gap: 8, alignItems: big ? 'stretch' : 'center' }}>
        <input
          type="tel"
          value={ed.value}
          autoFocus
          placeholder="+1XXXXXXXXXX"
          disabled={ed.isPending}
          onChange={(e) => ed.setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); ed.save(); }
            if (e.key === 'Escape') ed.cancel();
          }}
          style={editorInput(big, ed.isPending)}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            disabled={ed.isPending}
            onMouseDown={(e) => { e.preventDefault(); ed.save(); }}
            style={editorSaveBtn(big, ed.isPending)}
          >
            {ed.isPending ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            onMouseDown={(e) => { e.preventDefault(); ed.cancel(); }}
            style={editorCancelBtn(big)}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      onMouseEnter={() => { if (canEdit) ed.setHovered(true); }}
      onMouseLeave={() => ed.setHovered(false)}
      onClick={ed.beginEdit}
      title={canEdit ? 'Click to change forwarding destination' : undefined}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        cursor: canEdit ? 'pointer' : 'default',
        maxWidth: '100%',
      }}
    >
      <span style={editorValue(big, ed.flash)}>{fmt(entry.forward_to)}</span>
      {canEdit && (
        <span aria-hidden style={editorPencil(big, ed.hovered)}>
          <IconPencil color={GLASS.accent} big={big} />
        </span>
      )}
    </div>
  );
}
