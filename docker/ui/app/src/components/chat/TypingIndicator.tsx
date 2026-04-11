import { useEffect, useState } from 'react';
import type { ChatParticipant } from '../../types/chat';

interface TypingIndicatorProps {
  typingUserIds: Set<number>;
  participants: ChatParticipant[];
}

/** Animated "... is typing" indicator. Only renders when typingUserIds is non-empty. */
export function TypingIndicator({ typingUserIds, participants }: TypingIndicatorProps) {
  const [dotPhase, setDotPhase] = useState(0);

  useEffect(() => {
    if (typingUserIds.size === 0) return;
    const timer = setInterval(() => {
      setDotPhase((p) => (p + 1) % 3);
    }, 450);
    return () => clearInterval(timer);
  }, [typingUserIds.size]);

  if (typingUserIds.size === 0) return null;

  const names = [...typingUserIds]
    .map((id) => participants.find((p) => p.user_id === id)?.name ?? 'Someone')
    .filter(Boolean);

  let label: string;
  if (names.length === 1) {
    label = `${names[0]} is typing`;
  } else if (names.length === 2) {
    label = `${names[0]} and ${names[1]} are typing`;
  } else {
    label = `${names.slice(0, 2).join(', ')} and ${names.length - 2} more are typing`;
  }

  const dots = '.'.repeat(dotPhase + 1).padEnd(3, '\u00a0');

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 16px 8px',
        minHeight: 28,
      }}
      aria-live="polite"
      aria-label={label}
    >
      {/* Animated dot trio */}
      <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: '#3b82f6',
              display: 'inline-block',
              opacity: dotPhase === i ? 1 : 0.3,
              transition: 'opacity 0.2s',
            }}
          />
        ))}
      </div>
      <span
        style={{
          fontSize: '0.75rem',
          color: '#64748b',
          fontStyle: 'italic',
          letterSpacing: '-0.01em',
          userSelect: 'none',
        }}
      >
        {label}
        <span style={{ fontFamily: 'monospace', letterSpacing: 1 }}>{dots}</span>
      </span>
    </div>
  );
}
