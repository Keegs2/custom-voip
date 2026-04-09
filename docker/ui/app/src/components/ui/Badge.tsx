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
  active:   'bg-green-500/[0.12] text-green-400 border border-green-500/25',
  disabled: 'bg-red-500/[0.10] text-red-400 border border-red-500/22',
  suspended:'bg-red-500/[0.10] text-red-400 border border-red-500/22',
  closed:   'bg-[#718096]/[0.10] text-[#718096] border border-[#718096]/25',
  rcf:      'bg-blue-500/[0.12] text-blue-300 border border-blue-500/30',
  api:      'bg-violet-500/[0.12] text-violet-300 border border-violet-500/30',
  trunk:    'bg-green-500/[0.10] text-green-300 border border-green-500/25',
  hybrid:   'bg-amber-500/[0.10] text-amber-300 border border-amber-500/30',
  inbound:  'bg-blue-500/[0.12] text-blue-300 border border-blue-500/30',
  outbound: 'bg-amber-500/[0.10] text-amber-300 border border-amber-500/30',
  premium:  'bg-blue-500/[0.12] text-blue-300 border border-blue-500/30',
  standard: 'bg-[#718096]/[0.10] text-slate-400 border border-[#718096]/25',
  economy:  'bg-amber-500/[0.10] text-amber-300 border border-amber-500/30',
  pass:     'bg-green-500/[0.12] text-green-300 border border-green-500/25',
  warn:     'bg-amber-500/[0.10] text-amber-300 border border-amber-500/30',
  fail:     'bg-red-500/[0.10] text-red-400 border border-red-500/22',
};

export function Badge({ variant, children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center text-[0.68rem] font-bold px-[9px] py-[2px]',
        'rounded-full tracking-[0.5px] uppercase whitespace-nowrap',
        variantClasses[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
