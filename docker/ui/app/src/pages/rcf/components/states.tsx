/**
 * Shared loading / empty / error presentational states for the RCF page, all
 * built on frosted glass panels from the kit. Driven by props.
 */

import { GlassPanel } from '../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../components/glass/glass';
import { Spinner } from '../../../components/ui/Spinner';
import { BLUE } from '../styles';

export function LoadingState({ label }: { label: string }) {
  return (
    <GlassPanel padding="48px 24px">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, justifyContent: 'center', color: GLASS.textMuted }}>
        <Spinner size="sm" />
        <span style={{ fontSize: '0.875rem' }}>{label}</span>
      </div>
    </GlassPanel>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <GlassPanel padding="16px 20px" accent={GLASS.danger}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, color: '#f87171', fontSize: '0.875rem' }}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={{ width: 16, height: 16, flexShrink: 0 }}>
          <circle cx="8" cy="8" r="7" />
          <path d="M8 5v3.5M8 10.5v.5" strokeLinecap="round" />
        </svg>
        {message}
      </div>
    </GlassPanel>
  );
}

export function EmptyState() {
  return (
    <GlassPanel padding="80px 24px">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 16, textAlign: 'center' }}>
        <div
          style={{
            width: 72,
            height: 72,
            borderRadius: 18,
            background: `linear-gradient(135deg, ${hexToRgba(BLUE, 0.14)} 0%, ${hexToRgba(BLUE, 0.06)} 100%)`,
            border: `1px solid ${hexToRgba(BLUE, 0.22)}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: 8,
            boxShadow: `0 0 24px ${hexToRgba(BLUE, 0.12)}`,
          }}
        >
          <img
            src="/shale_logo.png"
            alt="Shale"
            style={{ width: 44, height: 44, objectFit: 'contain', filter: `drop-shadow(0 0 8px ${hexToRgba(BLUE, 0.5)}) brightness(1.1)`, opacity: 0.7 }}
          />
        </div>
        <div>
          <p style={{ color: GLASS.textMuted, fontSize: '1rem', fontWeight: 600, margin: '0 0 6px' }}>No numbers configured yet</p>
          <p style={{ color: GLASS.textFaint, fontSize: '0.82rem', margin: 0, lineHeight: 1.6 }}>
            Contact support to provision Remote Call Forwarding numbers for your account.
          </p>
        </div>
      </div>
    </GlassPanel>
  );
}

export function SearchEmptyState({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <GlassPanel padding="60px 24px">
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12, textAlign: 'center' }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} style={{ width: 36, height: 36, color: '#3b4560', marginBottom: 4 }}>
          <path d="m21 21-5.197-5.197M15.803 15.803A7.5 7.5 0 1 0 4.197 4.197a7.5 7.5 0 0 0 11.606 11.606Z" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <p style={{ color: GLASS.textMuted, fontSize: '0.9rem', fontWeight: 500, margin: 0 }}>
          No numbers match &ldquo;{query}&rdquo;
        </p>
        <button
          type="button"
          onClick={onClear}
          style={{ background: 'transparent', border: 'none', color: BLUE, fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline', fontFamily: 'inherit', padding: 0 }}
        >
          Clear filter
        </button>
      </div>
    </GlassPanel>
  );
}
