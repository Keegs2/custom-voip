interface Tab {
  id: string;
  label: string;
  /** Optional badge count */
  count?: number;
}

interface TabBarProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  className?: string;
}

export function TabBar({ tabs, activeTab, onTabChange, className }: TabBarProps) {
  // Glass segmented control — a frosted track with a glowing active pill.
  return (
    <div
      className={['glass-surface', className].filter(Boolean).join(' ')}
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 4,
        borderRadius: 12,
        marginBottom: 24,
        maxWidth: '100%',
        overflowX: 'auto',
      }}
      role="tablist"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onTabChange(tab.id)}
            style={{
              padding: '8px 16px',
              fontSize: '0.875rem',
              fontWeight: isActive ? 700 : 500,
              whiteSpace: 'nowrap',
              borderRadius: 9,
              color: isActive ? '#e2e8f0' : '#718096',
              background: isActive
                ? 'linear-gradient(135deg, rgba(59,130,246,0.24) 0%, rgba(59,130,246,0.12) 100%)'
                : 'transparent',
              boxShadow: isActive
                ? 'inset 0 1px 0 rgba(255,255,255,0.08), 0 0 16px rgba(59,130,246,0.22)'
                : 'none',
              cursor: 'pointer',
              border: 'none',
              transition: 'color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease',
              outline: 'none',
            }}
            onMouseEnter={(e) => {
              if (!isActive) (e.currentTarget as HTMLButtonElement).style.color = '#cbd5e0';
            }}
            onMouseLeave={(e) => {
              if (!isActive) (e.currentTarget as HTMLButtonElement).style.color = '#718096';
            }}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span
                style={{
                  marginLeft: 6,
                  padding: '2px 6px',
                  fontSize: '0.62rem',
                  fontWeight: 700,
                  borderRadius: 20,
                  background: isActive ? 'rgba(59,130,246,0.2)' : 'rgba(30,33,48,0.8)',
                  color: isActive ? '#93c5fd' : '#4a5568',
                }}
              >
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
