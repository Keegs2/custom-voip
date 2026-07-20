/**
 * Admin payments-demo hooks: the scenario runner behind the Exec Demo Control
 * Panel. Each scenario POSTs to `/v1/payments/demo/*`, then invalidates the whole
 * payments query family so every mounted dashboard (revenue, compliance, the
 * customer page in another tab) visibly reacts. Tracks which scenario is
 * in-flight so the panel can show a per-button busy state.
 *
 * React #310: plain custom hooks; every hook is unconditional at the top.
 */

import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useToast } from '../../../components/ui/useToast';
import { usePaymentsInvalidate } from '../../../components/payments/queries';
import { runDemoScenario } from '../../../api/payments';
import type { DemoScenario } from '../../../types/payments';

/** Friendly toast copy per scenario (the control endpoints return varied bodies). */
const SCENARIO_DONE: Record<DemoScenario, string> = {
  seed: 'Demo seeded',
  'call-drain': 'Call-drain simulated — watch auto-recharge fire',
  'agent-usage': 'Agent usage simulated — micro-charges posted',
  decline: 'Decline simulated — dunning updated',
  reset: 'Demo reset to a clean slate',
};

export function useDemoScenarioRunner() {
  const invalidate = usePaymentsInvalidate();
  const { toastOk, toastErr } = useToast();
  const [lastRun, setLastRun] = useState<DemoScenario | null>(null);

  const mutation = useMutation({
    mutationFn: (scenario: DemoScenario) => runDemoScenario(scenario),
    onSuccess: async (_result, scenario) => {
      setLastRun(scenario);
      toastOk(SCENARIO_DONE[scenario] ?? `${scenario} complete`);
      await invalidate();
    },
    onError: (err: Error) => toastErr(err.message || 'Scenario failed'),
  });

  return {
    run: (scenario: DemoScenario) => mutation.mutate(scenario),
    runningScenario: mutation.isPending ? (mutation.variables ?? null) : null,
    lastRun,
  };
}
