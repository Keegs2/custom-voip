import { useCallback, useRef, useState } from 'react';
import { Smile, Paperclip, SendHorizontal } from 'lucide-react';

interface MessageInputProps {
  onSend: (content: string) => Promise<void>;
  onTyping: () => void;
  disabled?: boolean;
  placeholder?: string;
}

export function MessageInput({
  onSend,
  onTyping,
  disabled = false,
  placeholder = 'Message',
}: MessageInputProps) {
  const [value, setValue] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [isFocused, setIsFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const growTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    // Cap at ~5 lines (140px at 1.55 line-height, 14px font)
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
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    try {
      await onSend(trimmed);
    } finally {
      setIsSending(false);
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
        padding: '10px 16px 14px',
        borderTop: '1px solid rgba(255,255,255,0.06)',
        background: 'rgba(255,255,255,0.01)',
      }}
    >
      {/* Input row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          background: isFocused ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.04)',
          border: isFocused
            ? '1px solid rgba(59,130,246,0.38)'
            : '1px solid rgba(255,255,255,0.08)',
          borderRadius: 14,
          padding: '4px 6px 4px 12px',
          transition: 'border-color 0.15s, background 0.15s, box-shadow 0.15s',
          boxShadow: isFocused ? '0 0 0 3px rgba(59,130,246,0.10)' : 'none',
        }}
      >
        {/* Leading accessory icons — emoji & attachment (decorative / future) */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, paddingBottom: 6 }}>
          <button
            type="button"
            aria-label="Emoji"
            title="Emoji (coming soon)"
            tabIndex={-1}
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              color: '#475569',
              cursor: 'pointer',
              transition: 'color 0.15s',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#94a3b8'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#475569'; }}
          >
            <Smile size={17} strokeWidth={1.75} />
          </button>
          <button
            type="button"
            aria-label="Attach file"
            title="Attach file (coming soon)"
            tabIndex={-1}
            style={{
              width: 30,
              height: 30,
              borderRadius: 8,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'transparent',
              border: 'none',
              color: '#475569',
              cursor: 'pointer',
              transition: 'color 0.15s',
              flexShrink: 0,
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = '#94a3b8'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = '#475569'; }}
          >
            <Paperclip size={16} strokeWidth={1.75} />
          </button>
        </div>

        {/* Text area */}
        <textarea
          ref={textareaRef}
          value={value}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onFocus={() => setIsFocused(true)}
          onBlur={() => setIsFocused(false)}
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
            padding: '9px 4px',
            fontFamily: 'inherit',
            overflowY: 'auto',
            minHeight: 40,
            maxHeight: 140,
            width: '100%',
          }}
        />

        {/* Send button — integrated in the input bar */}
        <div style={{ paddingBottom: 5, paddingRight: 2, flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSend}
            aria-label="Send message"
            style={{
              width: 36,
              height: 36,
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              border: 'none',
              cursor: canSend ? 'pointer' : 'default',
              transition: 'background 0.15s, opacity 0.15s, transform 0.1s, box-shadow 0.15s',
              background: canSend
                ? 'linear-gradient(135deg, #2563eb 0%, #3b82f6 100%)'
                : 'rgba(255,255,255,0.05)',
              color: canSend ? '#fff' : '#334155',
              opacity: canSend ? 1 : 0.45,
              boxShadow: canSend ? '0 2px 12px rgba(59,130,246,0.40)' : 'none',
            }}
            onMouseDown={(e) => {
              if (canSend) e.currentTarget.style.transform = 'scale(0.90)';
            }}
            onMouseUp={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'scale(1)';
            }}
          >
            {isSending ? (
              <div
                style={{
                  width: 14,
                  height: 14,
                  border: '2px solid rgba(255,255,255,0.30)',
                  borderTopColor: '#fff',
                  borderRadius: '50%',
                  animation: 'spin 0.7s linear infinite',
                }}
              />
            ) : (
              <SendHorizontal size={16} strokeWidth={2} />
            )}
          </button>
        </div>
      </div>

      {/* Helper hint */}
      <div style={{ fontSize: '0.67rem', color: '#1e293b', marginTop: 6, textAlign: 'right', userSelect: 'none' }}>
        Enter to send · Shift+Enter for new line
      </div>
    </div>
  );
}
