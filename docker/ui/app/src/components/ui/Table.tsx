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

interface TrProps {
  children: React.ReactNode;
  className?: string;
}

/** Scrollable table wrapper — a raised panel (theme tokens, .glass-surface) */
export function TableWrap({ children, className }: TableProps) {
  return (
    <div
      className={cn('glass-surface overflow-x-auto', className)}
      style={{ borderRadius: 14 }}
    >
      {children}
    </div>
  );
}

/**
 * Table row with a cheap per-row hover (tint + azure leading edge). Safe for
 * long lists. Behaviour lives in the .glass-row-hover CSS class.
 */
export function Tr({ children, className }: TrProps) {
  return <tr className={cn('glass-row-hover', className)}>{children}</tr>;
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
  // Quiet header band — the panel tint + a hairline underline.
  return (
    <thead
      className={cn(className)}
      style={{
        background: 'var(--t-tint)',
        boxShadow: 'inset 0 -1px 0 0 var(--t-line)',
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
        'text-left whitespace-nowrap',
        className,
      )}
      style={{
        padding: '14px 20px',
        fontSize: '0.68rem',
        fontWeight: 600,
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        color: 'var(--t-text-dim)',
      }}
    >
      {children}
    </th>
  );
}

export function Td({ children, className, colSpan }: TdProps) {
  // Row separation is a soft inset hairline + the hover tint.
  return (
    <td
      colSpan={colSpan}
      className={cn(
        'align-middle text-sm',
        className,
      )}
      style={{
        padding: '14px 20px',
        boxShadow: 'inset 0 -1px 0 0 var(--t-line-soft)',
      }}
    >
      {children}
    </td>
  );
}
