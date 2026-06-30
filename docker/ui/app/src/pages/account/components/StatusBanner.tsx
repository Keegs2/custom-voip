/**
 * StatusBanner — a frosted success/error banner shown inline inside a form card.
 * Driven entirely by props.
 */

import { statusBanner } from '../styles';
import type { StatusType } from '../types';

export function StatusBanner({ type, message }: { type: StatusType; message: string }) {
  return <div style={statusBanner(type)}>{message}</div>;
}
