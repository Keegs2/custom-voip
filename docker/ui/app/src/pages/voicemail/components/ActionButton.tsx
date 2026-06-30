/**
 * ActionButton — a single glass action in the reading-pane footer. `asChild`
 * renders it as a non-focusable visual (it sits inside an <a> for Forward).
 */

import type { ReactNode } from 'react';
import { actionBtn } from '../styles';

interface ActionButtonProps {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
  title?: string;
  asChild?: boolean;
}

export function ActionButton({ icon, label, onClick, disabled, active, danger, title, asChild }: ActionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      tabIndex={asChild ? -1 : 0}
      style={actionBtn({ active, danger, disabled })}
    >
      {icon}
      {label}
    </button>
  );
}
