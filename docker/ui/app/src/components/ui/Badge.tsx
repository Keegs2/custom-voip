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
  | 'inbound'
  | 'outbound'
  | 'premium'
  | 'standard'
  | 'economy'
  | 'pass'
  | 'warn'
  | 'fail';

interface BadgeProps {
  variant: BadgeVariant;
  children: React.ReactNode;
  className?: string;
}

const variantClasses: Record<BadgeVariant, string> = {
  active:    'bg-emerald-500/[0.12] text-emerald-400 border border-emerald-500/20 ring-1 ring-emerald-500/10',
  disabled:  'bg-red-500/[0.10] text-red-400 border border-red-500/20',
  suspended: 'bg-red-500/[0.10] text-red-400 border border-red-500/20',
  closed:    'bg-slate-500/[0.10] text-slate-400 border border-slate-500/20',
  rcf:       'bg-blue-500/[0.12] text-blue-300 border border-blue-500/25',
  api:       'bg-violet-500/[0.12] text-violet-300 border border-violet-500/25',
  trunk:     'bg-emerald-500/[0.10] text-emerald-300 border border-emerald-500/20',
  hybrid:    'bg-amber-500/[0.10] text-amber-300 border border-amber-500/25',
  inbound:   'bg-blue-500/[0.12] text-blue-300 border border-blue-500/25',
  outbound:  'bg-amber-500/[0.10] text-amber-300 border border-amber-500/25',
  premium:   'bg-blue-500/[0.12] text-blue-300 border border-blue-500/25',
  standard:  'bg-slate-500/[0.10] text-slate-400 border border-slate-500/20',
  economy:   'bg-amber-500/[0.10] text-amber-300 border border-amber-500/25',
  pass:      'bg-emerald-500/[0.12] text-emerald-300 border border-emerald-500/20',
  warn:      'bg-amber-500/[0.10] text-amber-300 border border-amber-500/25',
  fail:      'bg-red-500/[0.10] text-red-400 border border-red-500/20',
};

export function Badge({ variant, children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center text-[0.65rem] font-bold px-2 py-0.5',
        'rounded-full tracking-[0.4px] uppercase whitespace-nowrap',
        variantClasses[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
