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

const variantClasses: Record<ButtonVariant, string> = {
  primary: [
    'bg-[#3b82f6] text-white border border-transparent',
    'shadow-[0_0_12px_rgba(59,130,246,0.2)]',
    'hover:bg-[#2563eb] hover:shadow-[0_0_20px_rgba(59,130,246,0.35)] hover:scale-[1.02]',
    'disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:hover:scale-100',
  ].join(' '),

  ghost: [
    'bg-transparent text-[#718096] border border-[#2a2f45]',
    'hover:bg-white/[0.05] hover:text-[#e2e8f0] hover:border-[#363c57]',
    'disabled:opacity-40 disabled:cursor-not-allowed',
  ].join(' '),

  danger: [
    'bg-[#7f1d1d] text-[#fca5a5] border border-red-500/25',
    'hover:bg-[#991b1b] hover:shadow-[0_0_14px_rgba(239,68,68,0.2)] hover:scale-[1.02]',
    'disabled:opacity-40 disabled:cursor-not-allowed disabled:shadow-none disabled:hover:scale-100',
  ].join(' '),

  success: [
    'bg-[#065f46] text-[#6ee7b7] border border-emerald-300/20',
    'hover:bg-emerald-800/60 hover:scale-[1.02]',
    'disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100',
  ].join(' '),
};

const sizeClasses: Record<ButtonSize, string> = {
  default: 'text-[0.82rem] font-semibold px-4 py-2 rounded-lg h-9',
  sm:      'text-[0.75rem] font-semibold px-3.5 py-1.5 rounded-lg h-[34px]',
  xs:      'text-[0.7rem] font-semibold px-2.5 py-1 rounded-md h-6',
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
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#3b82f6]/50',
        'disabled:active:scale-100',
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
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
