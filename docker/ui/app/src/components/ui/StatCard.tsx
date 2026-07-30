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
      className={['glass-surface', 'glass-hover', className].filter(Boolean).join(' ')}
      style={{
        position: 'relative',
        padding: '20px 24px',
        overflow: 'hidden',
      }}
    >
      {icon && (
        <span
          style={{
            position: 'absolute',
            top: 16,
            right: 16,
            fontSize: '1.5rem',
            opacity: 0.1,
            lineHeight: 1,
            userSelect: 'none',
            pointerEvents: 'none',
          }}
        >
          {icon}
        </span>
      )}
      <p
        style={{
          fontSize: '0.68rem',
          fontWeight: 600,
          color: '#4a5568',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          marginBottom: 10,
        }}
      >
        {label}
      </p>
      <p
        style={{
          fontSize: '1.9rem',
          fontWeight: 800,
          color: '#e2e8f0',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1,
        }}
      >
        {value}
      </p>
    </div>
  );
}
