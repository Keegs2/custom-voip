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
        'bg-[#1a1d27] border border-[#2a2f45] rounded-xl',
        'shadow-[0_1px_3px_rgba(0,0,0,.4)]',
        'transition-[border-color] duration-200 hover:border-[#363c57]',
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
    <h3 className={cn('text-[0.95rem] font-bold text-[#e2e8f0] mb-3', className)}>
      {children}
    </h3>
  );
}
