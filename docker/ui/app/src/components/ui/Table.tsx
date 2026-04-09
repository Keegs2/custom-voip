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
        'overflow-x-auto rounded-xl',
        className,
      )}
      style={{
        border: '1px solid rgba(42,47,69,0.6)',
        boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
        borderRadius: 12,
      }}
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
    <thead
      className={cn(className)}
      style={{
        background: 'rgba(19,21,29,0.9)',
      }}
    >
      {children}
    </thead>
  );
}

export function Th({ children, className }: ThProps) {
  return (
    <th
      className={cn(
        'text-left px-4 py-3 text-[0.65rem] font-bold uppercase tracking-[0.8px]',
        'whitespace-nowrap',
        className,
      )}
      style={{
        color: '#4a5568',
        borderBottom: '1px solid rgba(42,47,69,0.6)',
      }}
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
        'px-4 py-3 align-middle text-sm',
        'last:border-b-0',
        className,
      )}
      style={{
        borderBottom: '1px solid rgba(42,47,69,0.35)',
      }}
    >
      {children}
    </td>
  );
}
