import { useCallback, useRef, useState } from 'react';

interface MessageInputProps {
  onSend: (content: string) => Promise<void>;
  onTyping: () => void;
  disabled?: boolean;
  placeholder?: string;
}

const IconSend = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16 }}>
    <path d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export function MessageInput({ onSend, onTyping, disabled = false, placeholder = 'Message' }: MessageInputProps) {
  const [value, setValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const growTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Reset height so shrinking works correctly
    el.style.height = 'auto';
    // Cap at 5 lines (~140px with 1.55 line-height at 14px font)
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, []);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setValue(e.target.value);
      growTextarea();
      onTyping();
    },
    [growTextarea, onTyping],
  );

  const submit = useCallback(async () => {
    const trimmed = value.trim();
    if (!trimmed || isSending) return;

    setIsSending(true);
    setValue('');
    // Reset height immediately
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      await onSend(trimmed);
    } finally {
      setIsSending(false);
      // Refocus after send
      textareaRef.current?.focus();
    }
  }, [value, isSending, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void submit();
      }
    },
    [submit],
  );

  const canSend = value.trim().length > 0 && !isSending && !disabled;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-end',
        gap: 10,
        padding: '12px 16px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(255,255,255,0.01)',
      }}
    >
      <div
        style={{
          flex: 1,
          display: 'flex',
          alignItems: 'flex-end',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 12,
          padding: '0 4px',
          transition: 'border-color 0.15s',
        }}
        onFocusCapture={(e) => {
          (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(59,130,246,0.35)';
        }}
        onBlurCapture={(e) => {
          (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(255,255,255,0.08)';
        }}
      >
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || isSending}
          rows={1}
          aria-label="Message input"
          style={{
            flex: 1,
            resize: 'none',
            background: 'transparent',
            border: 'none',
            outline: 'none',
            color: '#f1f5f9',
            fontSize: '0.875rem',
            lineHeight: 1.55,
            padding: '10px 8px',
            fontFamily: 'inherit',
            overflowY: 'auto',
            minHeight: 42,
            maxHeight: 140,
            width: '100%',
          }}
        />
      </div>

      <button
        type="button"
        onClick={() => void submit()}
        disabled={!canSend}
        aria-label="Send message"
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          border: 'none',
          cursor: canSend ? 'pointer' : 'not-allowed',
          transition: 'background 0.15s, opacity 0.15s, transform 0.1s',
          background: canSend
            ? 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)'
            : 'rgba(255,255,255,0.06)',
          color: canSend ? '#fff' : '#334155',
          opacity: canSend ? 1 : 0.5,
          boxShadow: canSend ? '0 2px 10px rgba(59,130,246,0.35)' : 'none',
        }}
        onMouseDown={(e) => {
          if (canSend) e.currentTarget.style.transform = 'scale(0.92)';
        }}
        onMouseUp={(e) => {
          e.currentTarget.style.transform = 'scale(1)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.transform = 'scale(1)';
        }}
      >
        <IconSend />
      </button>
    </div>
  );
}
