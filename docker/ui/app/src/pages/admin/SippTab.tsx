import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { runSipp, listSippPresets } from '../../api/sipp';
import { useToast } from '../../components/ui/Toast';
import { SippPresetGrid } from './SippPresetGrid';
import { SippCustomForm } from './SippCustomForm';
import { SippResults } from './SippResults';
import { SippHistory, type HistoryEntry } from './SippHistory';
import type { SippRunConfig, SippRunResponse } from '../../types/sipp';

export function SippTab() {
  const { toastOk, toastErr } = useToast();

  const [isRunning, setIsRunning] = useState(false);
  const [latestResult, setLatestResult] = useState<SippRunResponse | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [runningTimeout, setRunningTimeout] = useState(60);

  const { data: presets } = useQuery({
    queryKey: ['sipp', 'presets'],
    queryFn: listSippPresets,
    staleTime: 5 * 60 * 1000,
  });

  const handleRun = useCallback(
    async (config: Partial<SippRunConfig>, presetId?: number) => {
      if (isRunning) return;

      const fullConfig: SippRunConfig = {
        remote_host: config.remote_host ?? '9196',
        call_rate: config.call_rate ?? 100,
        call_limit: config.call_limit ?? 1000,
        duration_seconds: config.duration_seconds ?? 60,
        preset_id: presetId ?? null,
        ...config,
      };

      setRunningTimeout(fullConfig.duration_seconds ?? 60);
      setIsRunning(true);

      try {
        const response = await runSipp(fullConfig);
        setLatestResult(response);

        const presetName = presetId
          ? (presets?.find((p) => p.id === presetId)?.name ?? String(presetId))
          : undefined;

        const entry: HistoryEntry = {
          ...response,
          _timestamp: Date.now(),
          _presetName: presetName,
        };

        setHistory((prev) => [entry, ...prev].slice(0, 5));

        const verdict = response.verdict ?? 'DONE';
        if (verdict === 'PASS') {
          toastOk(`Test complete — ${verdict}`);
        } else {
          toastErr(`Test complete — ${verdict}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        toastErr(`Test error: ${msg}`);
        setLatestResult(null);
      } finally {
        setIsRunning(false);
      }
    },
    [isRunning, presets, toastOk, toastErr],
  );

  const handlePresetRun = useCallback(
    (config: Partial<SippRunConfig>, presetId: number) => {
      void handleRun(config, presetId);
    },
    [handleRun],
  );

  const handleCustomRun = useCallback(
    (config: Partial<SippRunConfig>) => {
      void handleRun(config);
    },
    [handleRun],
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      {/* Preset grid section */}
      <div>
        <div
          style={{
            marginBottom: 16,
            paddingBottom: 16,
            borderBottom: '1px solid rgba(42,47,69,0.4)',
          }}
        >
          <h2
            style={{
              fontSize: '1rem',
              fontWeight: 700,
              color: '#e2e8f0',
              margin: 0,
              letterSpacing: '-0.01em',
            }}
          >
            SIPp Load Test Presets
          </h2>
          <p style={{ fontSize: '0.875rem', color: '#718096', marginTop: 4 }}>
            Select a preset to run a pre-configured SIP load test against the platform.
          </p>
        </div>
        <SippPresetGrid isRunning={isRunning} onRun={handlePresetRun} />
      </div>

      {/* Custom test */}
      <SippCustomForm isRunning={isRunning} onRun={handleCustomRun} />

      {/* Results */}
      <SippResults
        response={latestResult}
        isRunning={isRunning}
        runningTimeout={runningTimeout}
      />

      {/* History */}
      {history.length > 0 && !isRunning && (
        <SippHistory history={history} />
      )}
    </div>
  );
}
