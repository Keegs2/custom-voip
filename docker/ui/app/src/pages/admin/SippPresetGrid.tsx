import { useQuery } from '@tanstack/react-query';
import { listSippPresets } from '../../api/sipp';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import type { SippRunConfig } from '../../types/sipp';

interface SippPresetGridProps {
  isRunning: boolean;
  onRun: (config: Partial<SippRunConfig>, presetId: number) => void;
}

interface PresetDefaults {
  target?: string;
  rate?: number;
  calls?: number;
  timeout?: number;
  duration?: number;
  [key: string]: unknown;
}

const PRESET_ACCENT = '#06b6d4';

export function SippPresetGrid({ isRunning, onRun }: SippPresetGridProps) {
  const { data: presets, isLoading, isError } = useQuery({
    queryKey: ['sipp', 'presets'],
    queryFn: listSippPresets,
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2.5 text-[#718096] py-8">
        <Spinner /> Loading presets…
      </div>
    );
  }

  if (isError) {
    return (
      <div
        style={{
          padding: '12px 16px',
          borderRadius: 10,
          background: 'rgba(239,68,68,0.08)',
          border: '1px solid rgba(239,68,68,0.2)',
          color: '#f87171',
          fontSize: '0.875rem',
        }}
      >
        Failed to load SIPp presets.
      </div>
    );
  }

  if (!presets || presets.length === 0) {
    return <p style={{ color: '#718096', fontSize: '0.875rem', padding: '16px 0' }}>No presets available.</p>;
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {presets.map((preset) => {
        const d = (preset.defaults ?? {}) as PresetDefaults;

        return (
          <div
            key={preset.id}
            style={{
              background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
              border: '1px solid rgba(42,47,69,0.6)',
              borderRadius: 16,
              padding: '20px',
              display: 'flex',
              flexDirection: 'column',
              gap: 16,
              boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
              transition: 'border-color 0.2s, box-shadow 0.2s',
              position: 'relative',
              overflow: 'hidden',
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.borderColor = `${PRESET_ACCENT}40`;
              (e.currentTarget as HTMLDivElement).style.boxShadow = `0 0 0 1px ${PRESET_ACCENT}20, 0 8px 30px rgba(0,0,0,0.4)`;
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.borderColor = 'rgba(42,47,69,0.6)';
              (e.currentTarget as HTMLDivElement).style.boxShadow = '0 4px 20px rgba(0,0,0,0.3)';
            }}
          >
            {/* Top accent line */}
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 24,
                right: 24,
                height: 2,
                background: `linear-gradient(90deg, transparent, ${PRESET_ACCENT}80, transparent)`,
                opacity: 0.4,
              }}
            />

            <div>
              <div
                style={{
                  fontSize: '0.9rem',
                  fontWeight: 700,
                  color: '#e2e8f0',
                  letterSpacing: '-0.01em',
                }}
              >
                {preset.name}
              </div>
              {preset.description && (
                <p
                  style={{
                    fontSize: '0.78rem',
                    color: '#718096',
                    marginTop: 6,
                    lineHeight: 1.55,
                  }}
                >
                  {preset.description}
                </p>
              )}
            </div>

            {/* Default params grid */}
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '6px 16px',
                fontSize: '0.78rem',
                background: 'rgba(15,17,23,0.6)',
                borderRadius: 10,
                padding: '12px',
                border: '1px solid rgba(42,47,69,0.4)',
              }}
            >
              <ParamRow label="Target" value={String(d.target ?? '--')} />
              <ParamRow label="Rate" value={`${d.rate ?? '--'} CPS`} />
              <ParamRow label="Calls" value={String(d.calls ?? '--')} />
              <ParamRow label="Timeout" value={`${d.timeout ?? '--'}s`} />
            </div>

            <div style={{ marginTop: 'auto' }}>
              <Button
                size="sm"
                disabled={isRunning}
                onClick={() =>
                  onRun(
                    {
                      preset_id: preset.id,
                      remote_host: String(d.target ?? '9196'),
                      call_rate: Number(d.rate ?? 100),
                      call_limit: Number(d.calls ?? 1000),
                      duration_seconds: Number(d.timeout ?? 60),
                    },
                    preset.id,
                  )
                }
              >
                {isRunning ? 'Running…' : 'Run Test'}
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ParamRow({ label, value }: { label: string; value: string }) {
  return (
    <>
      <span style={{ color: '#4a5568' }}>{label}</span>
      <span
        style={{
          fontWeight: 600,
          color: '#e2e8f0',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {value}
      </span>
    </>
  );
}
