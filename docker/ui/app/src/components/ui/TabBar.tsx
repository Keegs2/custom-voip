import { cn } from '../../utils/cn';

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
  // Segmented control on a raised panel — the active pill is an azure wash
  // with an accent edge (and the azure glow on dark). Theme tokens only.
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
            className={cn(
              'transition-[color,background,box-shadow] duration-200 ease-out',
              'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[color:var(--t-focus)]',
              isActive
                ? 'text-[color:var(--t-text-strong)]'
                : 'text-[color:var(--t-text-dim)] hover:text-[color:var(--t-text)] hover:bg-[color:var(--t-hover)]',
            )}
            style={{
              padding: '8px 16px',
              fontSize: '0.875rem',
              fontWeight: isActive ? 700 : 500,
              whiteSpace: 'nowrap',
              borderRadius: 9,
              background: isActive ? 'var(--t-accent-tint)' : undefined,
              boxShadow: isActive ? 'inset 0 0 0 1px var(--t-accent-border), var(--t-glow)' : 'none',
              cursor: 'pointer',
              border: 'none',
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
                  background: isActive ? 'var(--t-accent-tint)' : 'var(--t-tint)',
                  color: isActive ? 'var(--t-accent-text)' : 'var(--t-text-dim)',
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
