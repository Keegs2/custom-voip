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
  return (
    <div
      className={cn(
        'flex gap-1 border-b border-[#2a2f45] mb-5',
        className,
      )}
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
              'px-4 py-2.5 text-[0.88rem] font-semibold whitespace-nowrap',
              'border-b-2 -mb-px transition-[color,border-color] duration-150',
              isActive
                ? 'text-[#3b82f6] border-[#3b82f6]'
                : 'text-[#718096] border-transparent hover:text-[#e2e8f0] hover:border-[#2a2f45]',
            )}
          >
            {tab.label}
            {tab.count !== undefined && (
              <span className="ml-1.5 px-1.5 py-0.5 text-[0.65rem] font-bold rounded-full bg-[#1e2130] text-[#718096]">
                {tab.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
