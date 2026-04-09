import { cn } from '../../utils/cn';

interface CardProps {
  children: React.ReactNode;
  className?: string;
  /** Tighter padding variant */
  compact?: boolean;
}

interface CardTitleProps {
  children: React.ReactNode;
  className?: string;
}

export function Card({ children, className, compact = false }: CardProps) {
  return (
    <div
      className={cn(
        'bg-[#1a1d27] border border-[#2a2f45]/50 rounded-xl',
        'shadow-[0_1px_4px_rgba(0,0,0,.4)]',
        'transition-all duration-200',
        'hover:border-[#363c57] hover:shadow-[0_4px_16px_rgba(0,0,0,.35)]',
        compact ? 'p-4' : 'p-5 md:p-6',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: CardTitleProps) {
  return (
    <h3 className={cn('text-[0.95rem] font-semibold text-[#e2e8f0] mb-3', className)}>
      {children}
    </h3>
  );
}
