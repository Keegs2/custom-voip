/**
 * ChatPlaceholder — the frosted-glass empty state shown in the thread pane when
 * no conversation is open. Two variants:
 *   - 'none'  : the account has zero conversations.
 *   - 'empty' : conversations exist, but none is selected (icon gently pulses).
 *
 * Presentational only: it receives the new-chat callback via props. All hooks
 * sit at the top (React #310 discipline).
 */

import { useState } from 'react';
import { MessageSquarePlus, MessageSquareText, Plus } from 'lucide-react';
import { GlassPanel } from '../../../components/glass/GlassCard';
import type { PlaceholderVariant } from '../types';
import {
  newChatBtn,
  placeholderBody,
  placeholderIcon,
  placeholderInner,
  placeholderTitle,
  placeholderWrap,
} from '../styles';

interface ChatPlaceholderProps {
  variant: PlaceholderVariant;
  onNewChat: () => void;
}

export function ChatPlaceholder({ variant, onNewChat }: ChatPlaceholderProps) {
  const [hovered, setHovered] = useState(false);

  const isNone = variant === 'none';
  const Icon = isNone ? MessageSquarePlus : MessageSquareText;
  const title = isNone ? 'No conversations yet' : 'No conversation selected';
  const body = isNone
    ? 'Start a direct message with a colleague or create a group chat.'
    : 'Pick a conversation from the list on the left, or start a fresh one.';
  const label = isNone ? 'Start a Conversation' : 'New Conversation';

  return (
    <div style={placeholderWrap}>
      <GlassPanel padding="44px 40px" style={{ width: '100%', maxWidth: 420 }}>
        <div style={placeholderInner}>
          <div style={placeholderIcon(!isNone)}>
            <Icon size={34} strokeWidth={1.5} />
          </div>

          <div>
            <div style={placeholderTitle}>{title}</div>
            <div style={placeholderBody}>{body}</div>
          </div>

          <button
            type="button"
            onClick={onNewChat}
            onMouseEnter={() => setHovered(true)}
            onMouseLeave={() => setHovered(false)}
            style={newChatBtn(hovered)}
          >
            <Plus size={15} strokeWidth={2.5} />
            {label}
          </button>
        </div>
      </GlassPanel>
    </div>
  );
}
