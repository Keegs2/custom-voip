/**
 * MessageRow — one voicemail in the list column. Avatar + caller + relative date
 * + duration/transcript preview, with an unread accent dot. Pure presentation.
 */

import { fmt } from '../../../utils/format';
import type { VoicemailMessage } from '../../../types/voicemail';
import { formatDate, formatDuration, transcriptPreview } from '../format';
import { messageRow, avatar, unreadDot, rowName, rowDate, rowMeta, rowPreview } from '../styles';

interface MessageRowProps {
  message: VoicemailMessage;
  selected: boolean;
  onClick: () => void;
}

export function MessageRow({ message, selected, onClick }: MessageRowProps) {
  const displayName =
    message.caller_name && message.caller_name !== message.caller_id ? message.caller_name : null;
  const initial = (displayName ?? message.caller_id ?? '?').charAt(0).toUpperCase();

  return (
    <button type="button" onClick={onClick} style={messageRow(selected, message.is_read)}>
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <div style={avatar(false)}>{initial}</div>
        {!message.is_read && <span style={unreadDot} />}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
          <span style={rowName(message.is_read)}>{displayName ?? fmt(message.caller_id)}</span>
          <span style={rowDate}>{formatDate(message.created_at)}</span>
        </div>
        <div style={rowMeta}>
          {displayName ? fmt(message.caller_id) : `${formatDuration(message.duration_ms)} min`}
        </div>
        <div style={rowPreview}>{transcriptPreview(message.transcript_status)}</div>
      </div>
    </button>
  );
}
