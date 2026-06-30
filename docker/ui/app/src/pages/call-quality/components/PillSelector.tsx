/**
 * PillSelector — a small segmented pill control for enum filters (direction,
 * product type). Purely presentational; selection is owned by the parent.
 */

import type { PillOption } from '../types';
import { pillBtn } from '../styles';

interface PillSelectorProps<T extends string> {
  options: PillOption<T>[];
  value: T;
  onChange: (v: T) => void;
}

export function PillSelector<T extends string>({ options, value, onChange }: PillSelectorProps<T>) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map((opt) => (
        <button key={opt.value} type="button" onClick={() => onChange(opt.value)} style={pillBtn(opt.value === value)}>
          {opt.label}
        </button>
      ))}
    </div>
  );
}
