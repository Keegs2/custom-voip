/**
 * ReadingPane — the right frosted column when a message is selected: caller
 * header + encryption badge, the waveform player, the transcript, and the action
 * footer (call back / save / forward / delete · restore / delete-forever).
 *
 * React #310: the `forwardHref` memo is the only hook and sits at the very top.
 */

import { useMemo } from 'react';
import { Phone, Star, Forward, Trash2, RotateCcw } from 'lucide-react';
import { fmt } from '../../../utils/format';
import type { VoicemailMessage } from '../../../types/voicemail';
import { VoicemailPlayer } from '../player/VoicemailPlayer';
import { EncryptionBadge } from '../shared/EncryptionBadge';
import { formatDate, formatDuration } from '../format';
import {
  ACCENT,
  readingHeader,
  readingTitle,
  readingSub,
  readingMono,
  readingBody,
  readingActions,
  avatar,
} from '../styles';
import { ActionButton } from './ActionButton';
import { TranscriptPanel } from './TranscriptPanel';

interface ReadingPaneProps {
  message: VoicemailMessage;
  detail: VoicemailMessage | undefined;
  detailLoading: boolean;
  isTrash: boolean;
  canCallBack: boolean;
  onPlay: () => void;
  onCallBack: () => void;
  onToggleSave: () => void;
  onDelete: () => void;
  deleting: boolean;
  onRestore: () => void;
  onPurge: () => void;
  restoring: boolean;
  purging: boolean;
}

export function ReadingPane({
  message,
  detail,
  detailLoading,
  isTrash,
  canCallBack,
  onPlay,
  onCallBack,
  onToggleSave,
  onDelete,
  deleting,
  onRestore,
  onPurge,
  restoring,
  purging,
}: ReadingPaneProps) {
  const displayName =
    message.caller_name && message.caller_name !== message.caller_id ? message.caller_name : null;

  const forwardHref = useMemo(() => {
    const subject = `Voicemail from ${displayName ?? fmt(message.caller_id)}`;
    const lines = [
      `From: ${displayName ? `${displayName} (${fmt(message.caller_id)})` : fmt(message.caller_id)}`,
      `Received: ${new Date(message.created_at).toLocaleString()}`,
      `Duration: ${formatDuration(message.duration_ms)}`,
    ];
    if (detail?.transcript?.status === 'done' && detail.transcript.text) {
      lines.push('', 'Transcript:', detail.transcript.text);
    } else {
      lines.push('', '(Audio is encrypted — open it in the revup portal to listen.)');
    }
    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
  }, [displayName, message, detail]);

  return (
    <>
      {/* Header */}
      <div style={readingHeader}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
          <div style={avatar(true)}>{(displayName ?? message.caller_id ?? '?').charAt(0).toUpperCase()}</div>
          <div style={{ minWidth: 0 }}>
            <div style={readingTitle}>{displayName ?? fmt(message.caller_id)}</div>
            <div style={readingSub}>
              {displayName && <span style={readingMono}>{fmt(message.caller_id)}</span>}
              <span>{formatDate(message.created_at)}</span>
              <span>·</span>
              <span>{formatDuration(message.duration_ms)}</span>
            </div>
          </div>
        </div>
        <EncryptionBadge size="sm" />
      </div>

      {/* Body */}
      <div style={readingBody}>
        <VoicemailPlayer
          messageId={message.id}
          durationMs={message.duration_ms}
          peaks={message.peaks}
          onFirstPlay={onPlay}
        />
        <TranscriptPanel transcript={detail?.transcript} loading={detailLoading} />
      </div>

      {/* Actions */}
      <div style={readingActions}>
        <ActionButton
          icon={<Phone size={15} />}
          label="Call back"
          onClick={onCallBack}
          disabled={!canCallBack}
          title={canCallBack ? 'Call back' : 'Softphone not connected'}
        />
        <ActionButton
          icon={<Star size={15} fill={message.is_saved ? ACCENT : 'none'} />}
          label={message.is_saved ? 'Saved' : 'Save'}
          onClick={onToggleSave}
          active={message.is_saved}
        />
        <a href={forwardHref} style={{ textDecoration: 'none' }}>
          <ActionButton icon={<Forward size={15} />} label="Forward" onClick={() => undefined} asChild />
        </a>
        <div style={{ flex: 1 }} />
        {isTrash ? (
          <>
            <ActionButton
              icon={<RotateCcw size={15} />}
              label={restoring ? 'Restoring…' : 'Restore'}
              onClick={onRestore}
              disabled={restoring || purging}
            />
            <ActionButton
              icon={<Trash2 size={15} />}
              label={purging ? 'Deleting…' : 'Delete forever'}
              onClick={onPurge}
              disabled={restoring || purging}
              danger
            />
          </>
        ) : (
          <ActionButton
            icon={<Trash2 size={15} />}
            label={deleting ? 'Deleting…' : 'Delete'}
            onClick={onDelete}
            disabled={deleting}
            danger
          />
        )}
      </div>
    </>
  );
}
