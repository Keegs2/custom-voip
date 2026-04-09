import { cn } from '../../utils/cn';

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  /** Emoji or icon rendered faintly in the top-right corner */
  icon?: string;
  className?: string;
}

export function StatCard({ label, value, icon, className }: StatCardProps) {
  return (
    <div
      className={cn(
        'relative bg-[#1a1d27] border border-[#2a2f45] rounded-xl p-5 overflow-hidden',
        'shadow-[0_1px_3px_rgba(0,0,0,.4)]',
        'transition-[border-color] duration-200 hover:border-[#363c57]',
        className,
      )}
    >
      {icon && (
        <span className="absolute top-4 right-4 text-2xl opacity-[0.15] leading-none select-none pointer-events-none">
          {icon}
        </span>
      )}
      <p className="text-[0.68rem] font-bold text-[#4a5568] uppercase tracking-[1px] mb-2">
        {label}
      </p>
      <p className="text-[1.9rem] font-extrabold text-[#e2e8f0] tabular-nums leading-none">
        {value}
      </p>
    </div>
  );
}
