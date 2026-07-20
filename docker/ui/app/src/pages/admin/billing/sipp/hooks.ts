/**
 * useSippRunner — encapsulates the SIPp load-test run lifecycle for the Testing
 * tab: the running flag, latest result, recent history (last 5), and the
 * preset/custom run entry points. Keeps SippTab purely compositional.
 *
 * The runner uses the plain `runSipp` API call (not React Query) because the
 * result is local UI state, not a cached server resource.
 */

import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { runSipp, listSippPresets } from '../../../../api/sipp';
import { useToast } from '../../../../components/ui/Toast';
import type { SippRunConfig, SippRunResponse } from '../../../../types/sipp';
import type { HistoryEntry } from '../../SippHistory';

export function useSippRunner() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
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

  const run = useCallback(
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

        const entry: HistoryEntry = { ...response, _timestamp: Date.now(), _presetName: presetName };
        setHistory((prev) => [entry, ...prev].slice(0, 5));

        const verdict = response.verdict ?? 'DONE';
        if (verdict === 'PASS') toastOk(`Test complete — ${verdict}`);
        else toastErr(`Test complete — ${verdict}`);
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

  const runPreset = useCallback(
    (config: Partial<SippRunConfig>, presetId: number) => { void run(config, presetId); },
    [run],
  );

  const runCustom = useCallback(
    (config: Partial<SippRunConfig>) => { void run(config); },
    [run],
  );

  return { isRunning, latestResult, history, runningTimeout, runPreset, runCustom };
}
