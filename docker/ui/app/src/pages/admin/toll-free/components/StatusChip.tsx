/**
 * Status pills for the Toll-Free table. This file exports ONLY components so the
 * react-refresh/only-export-components rule stays happy.
 */

import { statusChip } from '../styles';
import { statusColor, crStatusColor } from '../types';

export function TfnStatusChip({ status }: { status: string | null | undefined }) {
  return <span style={statusChip(statusColor(status))}>{status ?? '—'}</span>;
}

export function CrChip({ status }: { status: string | null | undefined }) {
  return <span style={statusChip(crStatusColor(status))}>CR {status ?? 'none'}</span>;
}
