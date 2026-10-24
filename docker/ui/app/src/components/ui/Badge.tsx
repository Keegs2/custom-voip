import { cn } from '../../utils/cn';

type BadgeVariant =
  | 'active'
  | 'disabled'
  | 'suspended'
  | 'closed'
  | 'rcf'
  | 'api'
  | 'trunk'
  | 'hybrid'
  | 'ucaas'
  | 'inbound'
  | 'outbound'
  | 'premium'
  | 'standard'
  | 'economy'
  | 'pass'
  | 'warn'
  | 'fail'
  | 'sbc1'
  | 'sbc2'
  | 'pending'
  | 'billing_verified'
  | 'provisioning'
  | 'rejected';

interface BadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

/** The tone family each variant draws from (src/styles/theme.css). */
type BadgeTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'violet' | 'teal';

const VARIANT_TONE: Record<BadgeVariant, BadgeTone> = {
  active: 'ok',
  disabled: 'danger',
  suspended: 'danger',
  closed: 'neutral',
  rcf: 'info',
  api: 'violet',
  trunk: 'ok',
  hybrid: 'warn',
  ucaas: 'teal',
  inbound: 'info',
  outbound: 'warn',
  premium: 'info',
  standard: 'neutral',
  economy: 'warn',
  pass: 'ok',
  warn: 'warn',
  fail: 'danger',
  sbc1: 'info',
  sbc2: 'teal',
  pending: 'warn',
  billing_verified: 'info',
  provisioning: 'teal',
  rejected: 'danger',
};

/** fg / bg / border per tone — status tokens, or a categorical hue mixed. */
const TONE_STYLE: Record<BadgeTone, React.CSSProperties> = {
  ok: { color: 'var(--t-ok-fg)', background: 'var(--t-ok-bg)', borderColor: 'var(--t-ok-border)' },
  warn: { color: 'var(--t-warn-fg)', background: 'var(--t-warn-bg)', borderColor: 'var(--t-warn-border)' },
  danger: { color: 'var(--t-danger-fg)', background: 'var(--t-danger-bg)', borderColor: 'var(--t-danger-border)' },
  info: { color: 'var(--t-info-fg)', background: 'var(--t-info-bg)', borderColor: 'var(--t-info-border)' },
  neutral: { color: 'var(--t-neutral-fg)', background: 'var(--t-neutral-bg)', borderColor: 'var(--t-neutral-border)' },
  violet: {
    color: 'var(--t-violet)',
    background: 'color-mix(in srgb, var(--t-violet) 10%, transparent)',
    borderColor: 'color-mix(in srgb, var(--t-violet) 28%, transparent)',
  },
  teal: {
    color: 'var(--t-teal)',
    background: 'color-mix(in srgb, var(--t-teal) 10%, transparent)',
    borderColor: 'color-mix(in srgb, var(--t-teal) 28%, transparent)',
  },
};

export function Badge({ variant, children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center justify-center text-[0.65rem] font-semibold',
        'uppercase whitespace-nowrap border',
        className,
      )}
      style={{
        ...TONE_STYLE[VARIANT_TONE[variant]],
        padding: '4px 10px',
        borderRadius: 6,
        lineHeight: 1.4,
        letterSpacing: '0.05em',
        minWidth: 48,
      }}
    >
      {children}
    </span>
  );
}
