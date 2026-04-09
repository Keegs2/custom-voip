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
        'relative bg-[#1a1d27] border border-[#2a2f45] rounded-[10px] p-5 overflow-hidden',
        'shadow-[0_1px_4px_rgba(0,0,0,.4),0_1px_2px_rgba(0,0,0,.3)]',
        'transition-[border-color] duration-200 hover:border-[#363c57]',
        className,
      )}
    >
      {icon && (
        <span className="absolute top-4 right-[18px] text-[1.4rem] opacity-[0.18] leading-none select-none">
          {icon}
        </span>
      )}
      <p className="text-[0.72rem] font-bold text-[#718096] uppercase tracking-[0.7px] mb-2.5">
        {label}
      </p>
      <p className="text-[2rem] font-extrabold text-[#e2e8f0] tabular-nums leading-none">
        {value}
      </p>
    </div>
  );
}
