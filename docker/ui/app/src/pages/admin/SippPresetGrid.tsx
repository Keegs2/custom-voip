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
    return <p className="text-red-400 text-sm py-4">Failed to load SIPp presets.</p>;
  }

  if (!presets || presets.length === 0) {
    return <p className="text-[#718096] text-sm py-4">No presets available.</p>;
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {presets.map((preset) => {
        const d = (preset.defaults ?? {}) as PresetDefaults;

        return (
          <div
            key={preset.id}
            className="bg-[#1e2130] border border-[#2a2f45] rounded-xl p-5 flex flex-col gap-4 hover:border-[#363c57] transition-all duration-200"
          >
            <div>
              <div className="text-sm font-bold text-[#e2e8f0]">{preset.name}</div>
              {preset.description && (
                <p className="text-xs text-[#718096] mt-1 leading-relaxed">{preset.description}</p>
              )}
            </div>

            {/* Default params grid */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs bg-[#0f1117] rounded-lg p-3">
              <ParamRow label="Target" value={String(d.target ?? '--')} />
              <ParamRow label="Rate" value={`${d.rate ?? '--'} CPS`} />
              <ParamRow label="Calls" value={String(d.calls ?? '--')} />
              <ParamRow label="Timeout" value={`${d.timeout ?? '--'}s`} />
            </div>

            <div className="mt-auto">
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
      <span className="text-[#4a5568]">{label}</span>
      <span className="font-semibold text-[#e2e8f0] tabular-nums">{value}</span>
    </>
  );
}
