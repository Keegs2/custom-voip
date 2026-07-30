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

/** Scrollable table wrapper — borderless liquid-glass panel */
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
 * Table row with a cheap, smooth per-row hover glow (blue background tint +
 * inset accent leading-edge + soft shadow). No backdrop-filter — safe for long
 * lists. Behaviour lives in the .glass-row-hover CSS class.
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
  // Quiet, refined header band — a whisper of tint + a hairline accent underline
  // instead of a hard border.
  return (
    <thead
      className={cn(className)}
      style={{
        background: 'rgba(59,130,246,0.035)',
        boxShadow: 'inset 0 -1px 0 0 rgba(59,130,246,0.12)',
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
        color: '#64748b',
      }}
    >
      {children}
    </th>
  );
}

export function Td({ children, className, colSpan }: TdProps) {
  // Borderless — row separation comes from the hover tint + generous padding,
  // not a hard rule. A near-invisible inset hairline keeps rows legible at rest.
  return (
    <td
      colSpan={colSpan}
      className={cn(
        'align-middle text-sm',
        className,
      )}
      style={{
        padding: '14px 20px',
        boxShadow: 'inset 0 -1px 0 0 rgba(255,255,255,0.025)',
      }}
    >
      {children}
    </td>
  );
}
