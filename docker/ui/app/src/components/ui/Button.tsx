import { type ButtonHTMLAttributes } from 'react';
import { cn } from '../../utils/cn';
import { Spinner } from './Spinner';

type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'success';
type ButtonSize = 'xs' | 'sm' | 'default';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Leading icon element */
  icon?: React.ReactNode;
}

// Every colour is a theme token (src/styles/theme.css) so each variant
// reads right on daylight paper and on granite. Arbitrary values carry an
// explicit `color:` type hint so Tailwind never guesses.
const variantClasses: Record<ButtonVariant, string> = {
  // The brand primary (index.css :root --brand-btn-*): azure → azure-deep
  // gradient with a 1px inner top highlight; the azure glow blooms on hover.
  // Same recipe in both themes (it is the landing page's primary).
  primary: [
    'bg-[image:var(--brand-btn-bg)] text-[color:var(--t-text-on-accent)] border border-[color:var(--brand-btn-edge)]',
    'shadow-[var(--brand-btn-shadow)]',
    'hover:bg-[image:var(--brand-btn-bg-hover)] hover:shadow-[var(--brand-btn-shadow-hover)] hover:scale-[1.02]',
    'disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:hover:scale-100',
  ].join(' '),

  // Quiet secondary — hairline border, no fill (the landing's ghost).
  ghost: [
    'bg-transparent text-[color:var(--t-text-soft)] border border-[color:var(--t-line-strong)]',
    'hover:bg-[color:var(--t-hover)] hover:text-[color:var(--t-text)] hover:border-[color:var(--t-field-border-hover)]',
    'disabled:opacity-40 disabled:cursor-not-allowed',
  ].join(' '),

  danger: [
    'bg-[color:var(--t-danger-bg)] text-[color:var(--t-danger-fg)] border border-[color:var(--t-danger-border)]',
    'hover:bg-[color:color-mix(in_srgb,var(--t-danger-solid)_18%,transparent)] hover:scale-[1.02]',
    'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100',
  ].join(' '),

  success: [
    'bg-[color:var(--t-ok-bg)] text-[color:var(--t-ok-fg)] border border-[color:var(--t-ok-border)]',
    'hover:bg-[color:color-mix(in_srgb,var(--t-ok-solid)_18%,transparent)] hover:scale-[1.02]',
    'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100',
  ].join(' '),
};

const sizeClasses: Record<ButtonSize, string> = {
  default: 'text-[0.8rem] font-semibold rounded-md',
  sm:      'text-[0.72rem] font-semibold rounded-md',
  xs:      'text-[0.68rem] font-semibold rounded-md',
};

const sizeStyles: Record<ButtonSize, React.CSSProperties> = {
  default: { padding: '7px 16px', minHeight: 34 },
  sm:      { padding: '5px 12px', minHeight: 30 },
  xs:      { padding: '4px 10px', minHeight: 24 },
};

export function Button({
  variant = 'primary',
  size = 'default',
  loading = false,
  icon,
  children,
  disabled,
  className,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      type="button"
      disabled={isDisabled}
      className={cn(
        'inline-flex items-center justify-center gap-1.5 whitespace-nowrap leading-none',
        'transition-all duration-150',
        'active:scale-[0.97] active:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
        'focus-visible:ring-[color:var(--t-focus)] focus-visible:ring-offset-[color:var(--t-surface)]',
        'disabled:active:scale-100',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      style={{ ...sizeStyles[size], ...props.style }}
      {...props}
    >
      {loading ? (
        <Spinner size={size === 'default' ? 'sm' : 'xs'} />
      ) : (
        icon && <span className="flex-shrink-0">{icon}</span>
      )}
      {children}
    </button>
  );
}
