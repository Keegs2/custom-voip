import { useState } from 'react';
import { PageHeader } from '../components/layout/PageHeader';

type DocView = 'swagger' | 'redoc';

export function DocsPage() {
  const [activeView, setActiveView] = useState<DocView>('swagger');

  const iframeSrc = activeView === 'swagger' ? '/docs' : '/redoc';

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={<>API <span style={{ color: '#3b82f6' }}>Documentation</span></>}
        subtitle="Interactive REST API reference — explore and test all platform endpoints"
        actions={
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 4,
              background: 'rgba(19,21,29,0.9)',
              border: '1px solid rgba(42,47,69,0.6)',
              borderRadius: 10,
              padding: 4,
            }}
          >
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
      <div
        style={{
          flex: 1,
          borderRadius: 16,
          border: '1px solid rgba(42,47,69,0.6)',
          overflow: 'hidden',
          boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        }}
      >
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
      style={{
        padding: '6px 14px',
        borderRadius: 7,
        fontSize: '0.82rem',
        fontWeight: 600,
        whiteSpace: 'nowrap',
        transition: 'background 0.15s, color 0.15s',
        background: active
          ? '#3b82f6'
          : 'transparent',
        color: active ? '#ffffff' : '#718096',
        boxShadow: active ? '0 0 10px rgba(59,130,246,0.3)' : 'none',
        cursor: 'pointer',
        border: 'none',
      }}
    >
      {label}
    </button>
  );
}
