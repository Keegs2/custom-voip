import { cn } from '../../utils/cn';

interface TableProps {
  children: React.ReactNode;
  className?: string;
}

interface ThProps {
  children?: React.ReactNode;
  className?: string;
}

interface TdProps {
  children: React.ReactNode;
  className?: string;
  colSpan?: number;
}

/** Scrollable table wrapper with rounded border */
export function TableWrap({ children, className }: TableProps) {
  return (
    <div
      className={cn(
        'overflow-x-auto rounded-xl border border-[#2a2f45]',
        'shadow-[0_1px_3px_rgba(0,0,0,.3)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Table({ children, className }: TableProps) {
  return (
    <table
      className={cn('w-full border-collapse text-sm', className)}
    >
      {children}
    </table>
  );
}

export function Thead({ children, className }: TableProps) {
  return (
    <thead className={cn('bg-[#1e2130]', className)}>
      {children}
    </thead>
  );
}

export function Th({ children, className }: ThProps) {
  return (
    <th
      className={cn(
        'text-left px-4 py-3 text-[0.65rem] font-bold uppercase tracking-[0.8px]',
        'text-[#4a5568] whitespace-nowrap border-b border-[#2a2f45]',
        className,
      )}
    >
      {children}
    </th>
  );
}

export function Td({ children, className, colSpan }: TdProps) {
  return (
    <td
      colSpan={colSpan}
      className={cn(
        'px-4 py-3 border-b border-[#2a2f45]/50 align-middle text-sm',
        'last:border-b-0',
        className,
      )}
    >
      {children}
    </td>
  );
}
