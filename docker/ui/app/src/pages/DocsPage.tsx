import { useState } from 'react';
import { PageHeader } from '../components/layout/PageHeader';
import { cn } from '../utils/cn';

type DocView = 'swagger' | 'redoc';

export function DocsPage() {
  const [activeView, setActiveView] = useState<DocView>('swagger');

  const iframeSrc = activeView === 'swagger' ? '/docs' : '/redoc';

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="API"
        titleAccent="Documentation"
        subtitle="Interactive REST API reference — explore and test all platform endpoints"
        actions={
          <div className="flex items-center gap-1 bg-[#1e2130] border border-[#2a2f45] rounded-lg p-1">
            <ViewToggleButton
              label="Swagger UI"
              active={activeView === 'swagger'}
              onClick={() => setActiveView('swagger')}
            />
            <ViewToggleButton
              label="ReDoc"
              active={activeView === 'redoc'}
              onClick={() => setActiveView('redoc')}
            />
          </div>
        }
      />

      {/* Full-height iframe */}
      <div className="flex-1 rounded-[10px] border border-[#2a2f45] overflow-hidden">
        <iframe
          key={activeView}
          src={iframeSrc}
          title={activeView === 'swagger' ? 'Swagger UI' : 'ReDoc API Documentation'}
          style={{
            width: '100%',
            height: 'calc(100vh - 180px)',
            border: 'none',
            background: '#1a1d27',
          }}
        />
      </div>
    </div>
  );
}

interface ViewToggleButtonProps {
  label: string;
  active: boolean;
  onClick: () => void;
}

function ViewToggleButton({ label, active, onClick }: ViewToggleButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 rounded-md text-[0.82rem] font-semibold whitespace-nowrap',
        'transition-[background,color] duration-150',
        active
          ? 'bg-[#3b82f6] text-white shadow-[0_0_10px_rgba(59,130,246,0.3)]'
          : 'text-[#718096] hover:text-[#e2e8f0]',
      )}
    >
      {label}
    </button>
  );
}
