/**
 * InlineTrunkName — click-to-rename a trunk's name in place. All edit state +
 * the rename mutation live in `useInlineTrunkName`.
 */

import { GLASS } from '../../../../components/glass/glass';
import { useInlineTrunkName } from '../hooks';
import { IconPencil } from './icons';
import { inlineSaveBtn, inlineCancelBtn, inlineNameInput } from '../styles';

export function InlineTrunkName({ trunkId, name }: { trunkId: number; name: string }) {
  const { editing, value, hovered, isPending, setValue, setHovered, beginEdit, save, cancel } =
    useInlineTrunkName(trunkId, name);

  if (editing) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); save(); }
            if (e.key === 'Escape') cancel();
            e.stopPropagation();
          }}
          onBlur={cancel}
          onClick={(e) => e.stopPropagation()}
          disabled={isPending}
          autoFocus
          style={inlineNameInput(value, isPending)}
        />
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); save(); }}
          disabled={isPending}
          style={{ ...inlineSaveBtn, opacity: isPending ? 0.6 : 1 }}
        >
          {isPending ? '…' : 'Save'}
        </button>
        <button
          type="button"
          onMouseDown={(e) => { e.preventDefault(); cancel(); }}
          style={inlineCancelBtn}
        >
          Cancel
        </button>
      </span>
    );
  }

  return (
    <span
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}
      onClick={(e) => { e.stopPropagation(); beginEdit(); }}
      title="Click to rename"
    >
      <span style={{ color: GLASS.text, fontWeight: 600, fontSize: '0.875rem' }}>{name}</span>
      {hovered && <IconPencil color={GLASS.accent} />}
    </span>
  );
}
