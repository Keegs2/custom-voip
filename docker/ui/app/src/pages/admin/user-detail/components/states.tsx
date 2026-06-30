/**
 * Shared loading / error / back presentational states for the User Detail page.
 * All frosted glass, driven by props.
 */

import { GlassPanel } from '../../../../components/glass/GlassCard';
import { GLASS, hexToRgba } from '../../../../components/glass/glass';
import { Spinner } from '../../../../components/ui/Spinner';
import { backButton } from '../styles';
import { IconChevronLeft } from './icons';

export function LoadingState({ label, inset = false }: { label: string; inset?: boolean }) {
  const body = (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, padding: '40px 0', color: GLASS.textMuted, fontSize: '0.875rem' }}>
      <Spinner size="md" />
      <span>{label}</span>
    </div>
  );
  return inset ? body : <GlassPanel padding="24px">{body}</GlassPanel>;
}

export function ErrorState({ title, message, inset = false }: { title: string; message: string; inset?: boolean }) {
  const body = (
    <div
      style={{
        padding: '16px 20px',
        borderRadius: 12,
        background: hexToRgba(GLASS.danger, 0.08),
        border: `1px solid ${hexToRgba(GLASS.danger, 0.22)}`,
        color: '#f87171',
        fontSize: '0.875rem',
      }}
    >
      <strong style={{ display: 'block', marginBottom: 4 }}>{title}</strong>
      {message}
    </div>
  );
  return inset ? body : <GlassPanel padding={0} style={{ background: 'transparent', border: 'none', boxShadow: 'none' }}>{body}</GlassPanel>;
}

export function BackButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={backButton}
      onMouseEnter={(e) => { e.currentTarget.style.color = '#93c5fd'; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = GLASS.accent; }}
    >
      <IconChevronLeft />
      {label}
    </button>
  );
}
