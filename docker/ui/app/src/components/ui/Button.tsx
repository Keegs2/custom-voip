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
    'bg-[#3b82f6] text-white',
    'shadow-[0_0_12px_rgba(59,130,246,0.25)]',
    'hover:bg-[#2563eb] hover:shadow-[0_0_20px_rgba(59,130,246,0.45)]',
    'disabled:opacity-35 disabled:cursor-not-allowed disabled:shadow-none',
  ].join(' '),

  ghost: [
    'bg-transparent text-[#718096] border border-[#2a2f45]',
    'hover:bg-white/[0.04] hover:text-[#e2e8f0] hover:border-[#3d4460]',
    'disabled:opacity-35 disabled:cursor-not-allowed',
  ].join(' '),

  danger: [
    'bg-[#7f1d1d] text-[#fca5a5] border border-red-500/30',
    'hover:bg-[#991b1b] hover:shadow-[0_0_14px_rgba(239,68,68,0.18)]',
    'disabled:opacity-35 disabled:cursor-not-allowed disabled:shadow-none',
  ].join(' '),

  success: [
    'bg-[#065f46] text-[#6ee7b7] border border-emerald-300/20',
    'hover:brightness-110',
    'disabled:opacity-35 disabled:cursor-not-allowed',
  ].join(' '),
};

const sizeClasses: Record<ButtonSize, string> = {
  default: 'text-[0.88rem] font-semibold px-4 py-[9px] rounded-lg',
  sm: 'text-[0.78rem] font-semibold px-[10px] py-[5px] rounded-lg',
  xs: 'text-[0.72rem] font-semibold px-2 py-[3px] rounded-md',
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
        'inline-flex items-center gap-1.5 whitespace-nowrap leading-none',
        'transition-[background,box-shadow,opacity] duration-150',
        'active:scale-[0.97] active:transition-none',
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
