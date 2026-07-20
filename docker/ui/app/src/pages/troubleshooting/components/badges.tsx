/**
 * Status / message-count / duration pills for the SIP results table. Frosted
 * tints keyed off the semantic colour of each value.
 */

import { GLASS } from '../../../components/glass/glass';
import { badge, badgeMutedText, DURATION_COLOR } from '../styles';
import { fmtCallDuration } from '../format';

/** Map a SIP status code to its semantic colour. */
function statusColor(status: number): string {
  if (status >= 200 && status < 300) return GLASS.success;
  if (status >= 400 && status < 500) return GLASS.warning;
  if (status >= 500) return GLASS.danger;
  if (status >= 100 && status < 200) return GLASS.accent;
  return GLASS.textMuted;
}

export function StatusBadge({ status }: { status: number | null }) {
  if (status === null) {
    return <span style={badge(GLASS.textMuted)}>—</span>;
  }
  return <span style={badge(statusColor(status))}>{status}</span>;
}

export function MsgCountBadge({ count }: { count: number }) {
  return (
    <span style={badge(GLASS.accent)}>
      {count} msg{count !== 1 ? 's' : ''}
    </span>
  );
}

export function DurationBadge({ seconds }: { seconds: number | null }) {
  if (seconds === null) {
    return <span style={badgeMutedText}>—</span>;
  }
  return <span style={badge(DURATION_COLOR)}>{fmtCallDuration(seconds)}</span>;
}
