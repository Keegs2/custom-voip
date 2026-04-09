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
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        gap: 2,
        borderBottom: '1px solid rgba(42,47,69,0.6)',
        marginBottom: 24,
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
              padding: '10px 18px',
              fontSize: '0.875rem',
              fontWeight: isActive ? 600 : 500,
              whiteSpace: 'nowrap',
              borderBottom: `2px solid ${isActive ? '#3b82f6' : 'transparent'}`,
              marginBottom: -1,
              color: isActive ? '#3b82f6' : '#718096',
              background: 'transparent',
              cursor: 'pointer',
              border: 'none',
              borderBottomWidth: 2,
              borderBottomStyle: 'solid',
              borderBottomColor: isActive ? '#3b82f6' : 'transparent',
              transition: 'color 0.15s, border-color 0.15s',
              outline: 'none',
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                (e.currentTarget as HTMLButtonElement).style.color = '#cbd5e0';
                (e.currentTarget as HTMLButtonElement).style.borderBottomColor = 'rgba(54,60,87,0.6)';
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                (e.currentTarget as HTMLButtonElement).style.color = '#718096';
                (e.currentTarget as HTMLButtonElement).style.borderBottomColor = 'transparent';
              }
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
                  background: 'rgba(30,33,48,0.8)',
                  color: '#4a5568',
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
