/**
 * InlineEdit — a small inline text input with save/cancel affordances, used for
 * renaming folders in the folder rail.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { GLASS } from '../../../components/glass/glass';
import { inlineEditInput } from '../styles';

interface InlineEditProps {
  initialValue: string;
  onSave: (value: string) => void;
  onCancel: () => void;
}

export function InlineEdit({ initialValue, onSave, onCancel }: InlineEditProps) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); if (value.trim()) onSave(value.trim()); }
    if (e.key === 'Escape') onCancel();
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1 }}>
      <input
        ref={ref}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        style={inlineEditInput}
      />
      <button
        type="button"
        onClick={() => { if (value.trim()) onSave(value.trim()); }}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: GLASS.success, padding: 2, display: 'flex' }}
      >
        <Check size={13} strokeWidth={2.5} />
      </button>
      <button
        type="button"
        onClick={onCancel}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: GLASS.textMuted, padding: 2, display: 'flex' }}
      >
        <X size={13} strokeWidth={2.5} />
      </button>
    </div>
  );
}
