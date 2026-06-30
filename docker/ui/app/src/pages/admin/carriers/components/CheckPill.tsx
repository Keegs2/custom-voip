/**
 * CheckPill — a frosted-glass toggle pill used for the carrier form's product
 * types and role/option flags. Controlled; purely presentational.
 */

import { checkPill, checkBox } from '../styles';
import { IconCheck } from './icons';

interface CheckPillProps {
  label: string;
  checked: boolean;
  onChange: () => void;
}

export function CheckPill({ label, checked, onChange }: CheckPillProps) {
  return (
    <label style={checkPill(checked)}>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ position: 'absolute', opacity: 0, width: 0, height: 0 }} />
      <span style={checkBox(checked)}>{checked && <IconCheck />}</span>
      {label}
    </label>
  );
}
