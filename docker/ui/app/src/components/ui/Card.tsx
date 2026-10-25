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
  // Raised panel (theme tokens) with the azure lift on hover — behaviour
  // lives in the .glass-surface / .glass-hover classes in index.css.
  return (
    <div
      className={['glass-surface', 'glass-hover', className].filter(Boolean).join(' ')}
      style={{ padding: compact ? 16 : 24 }}
    >
      {children}
    </div>
  );
}

export function CardTitle({ children, className }: CardTitleProps) {
  return (
    <h3
      className={className}
      style={{
        fontSize: '0.95rem',
        fontWeight: 700,
        color: 'var(--t-text-strong)',
        marginBottom: 16,
        letterSpacing: '-0.01em',
      }}
    >
      {children}
    </h3>
  );
}
