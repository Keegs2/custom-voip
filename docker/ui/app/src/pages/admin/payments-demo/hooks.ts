/**
 * Machine Payments Demo — query family + scenario runner + machine-rail hooks.
 *
 * One query root (`['payments-demo']`) so every mounted surface co-invalidates
 * after a scenario: the presenter clicks a card and the state pane, ledger,
 * revenue tiles, and MPP panel all visibly react.
 *
 * The scenario runner is deliberately smarter than a bare POST per endpoint —
 * two backend behaviors verified against the live demo API:
 *   • `POST /demo/seed` does NOT mint a card, and auto-recharge skips with
 *     `no_payment_method`; the Seed scenario therefore also creates a default
 *     demo Visa via `POST /methods`.
 *   • the call-drain default (220 min ≈ $4.40) never crosses the $50
 *     threshold from a $250 start; Call Drain computes the minutes needed to
 *     land ~$10 below the live threshold so auto-recharge genuinely fires.
 *
 * React #310: every hook is unconditional at the top of each custom hook.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useToast } from '../../../components/ui/Toast';
import { ApiError } from '../../../api/client';
import {
  chargeMppSession,
  createMppSession,
  createPaymentMethod,
  getComplianceStatus,
  getDemoState,
  getPaymentsSummary,
  probeMetered,
  resetDemo,
  seedDemo,
  simulateAgentUsage,
  simulateCallDrain,
  simulateDecline,
} from './api';
import { fmtDollars, fmtMicro, fmtRef } from './format';
import type { DemoScenario, DemoState, X402Challenge, X402Settlement } from './types';

// ── Query keys + read hooks ──────────────────────────────────────────────────

export const paymentsDemoKeys = {
  all: ['payments-demo'] as const,
  state: ['payments-demo', 'state'] as const,
  summary: ['payments-demo', 'summary'] as const,
  compliance: ['payments-demo', 'compliance'] as const,
};

/** The demo-state poll — also the "is demo mode on" probe (404 = flag off). */
export function useDemoState() {
  return useQuery({
    queryKey: paymentsDemoKeys.state,
    queryFn: getDemoState,
    refetchInterval: 5000,
    // A 404 means PAYMENTS_DEMO_MODE is off — surface it immediately, and
    // don't hammer a router that doesn't exist.
    retry: false,
    refetchOnWindowFocus: false,
  });
}

export function usePaymentsSummary(enabled: boolean) {
  return useQuery({
    queryKey: paymentsDemoKeys.summary,
    queryFn: getPaymentsSummary,
    refetchInterval: 8000,
    enabled,
  });
}

export function useComplianceStatus(enabled: boolean) {
  return useQuery({
    queryKey: paymentsDemoKeys.compliance,
    queryFn: getComplianceStatus,
    refetchInterval: 30000,
    enabled,
  });
}

export function usePaymentsInvalidate(): () => Promise<void> {
  const qc = useQueryClient();
  return useCallback(
    () => qc.invalidateQueries({ queryKey: paymentsDemoKeys.all }),
    [qc],
  );
}

// ── Scenario runner ──────────────────────────────────────────────────────────

export interface ScenarioResult {
  ok: boolean;
  text: string;
}

const CALL_DRAIN_RATE = 0.02; // $/min — matches the backend default

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Runs one scenario end-to-end, records a per-card result summary, and
 * co-invalidates the whole payments-demo query family. Multi-step scenarios
 * (seed + card mint, the MPP walkthrough) invalidate between steps so the
 * state pane streams while they run.
 */
export function useScenarioRunner() {
  const invalidate = usePaymentsInvalidate();
  const { toastOk, toastErr } = useToast();
  const [running, setRunning] = useState<DemoScenario | null>(null);
  const [results, setResults] = useState<Partial<Record<DemoScenario, ScenarioResult>>>({});
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const execute = useCallback(
    async (scenario: DemoScenario): Promise<ScenarioResult> => {
      switch (scenario) {
        case 'seed': {
          const seeded = await seedDemo();
          await invalidate();
          // The backend seed doesn't mint a card; auto-recharge needs one.
          const state: DemoState = await getDemoState();
          let cardNote = '';
          if ((state.payment_methods ?? []).length === 0) {
            const pm = await createPaymentMethod({ brand: 'visa', make_default: true });
            cardNote = ` · ${pm.brand ?? 'card'} ••••${pm.last4 ?? ''} on file`;
          }
          return {
            ok: true,
            text: `${seeded.name.replace('DEMO — ', '')} at ${fmtDollars(seeded.balance ?? 0)}${cardNote}`,
          };
        }

        case 'call-drain': {
          // Compute the minutes needed to land ~$10 below the live threshold.
          const state = await getDemoState();
          if (!state.seeded) throw new ApiError(400, 'Demo not seeded — run Seed first');
          const balance = state.balance ?? 0;
          const threshold = state.auto_recharge?.threshold ?? 50;
          const overshoot = balance - threshold + 10;
          const minutes = Math.max(220, Math.ceil(overshoot / CALL_DRAIN_RATE));
          const r = await simulateCallDrain(minutes);
          const ar = r.auto_recharge;
          const arNote =
            ar.action === 'charged'
              ? `auto-recharge fired +${fmtDollars(ar.amount ?? 0)}`
              : ar.action === 'declined'
                ? `auto-recharge DECLINED (${ar.reason ?? 'card error'})`
                : `auto-recharge skipped (${ar.reason ?? 'n/a'})`;
          return {
            ok: true,
            text: `Drained ${fmtDollars(r.drained)} over ${r.minutes.toLocaleString()} min · ${arNote} · balance ${fmtDollars(r.balance ?? 0)}`,
          };
        }

        case 'agent-usage': {
          const r = await simulateAgentUsage();
          return {
            ok: true,
            text: `${r.requests} metered requests · ${fmtMicro(r.total_charged)} ${r.currency} settled · tx ${fmtRef(r.tx_hash)}`,
          };
        }

        case 'mpp': {
          // Orchestrated walkthrough: open a $5 tab, stream charges, hit the
          // spend-limit wall (409 — enforcement is the point), then settle.
          const session = await createMppSession({
            spend_limit: 5,
            label: 'Walkthrough voicebot',
          });
          await invalidate();
          let total = 0;
          for (let i = 0; i < 6; i++) {
            const tick = await chargeMppSession(session.id, { amount: 0.75 });
            total = tick.total_charged;
            await invalidate();
            await sleep(350);
          }
          // Overrun attempt — the backend must refuse with 409.
          let overrunRefused = false;
          try {
            await chargeMppSession(session.id, { amount: 0.9 });
          } catch (err) {
            if (err instanceof ApiError && err.status === 409) overrunRefused = true;
            else throw err;
          }
          const settled = await chargeMppSession(session.id, { amount: 0.25, settle: true });
          return {
            ok: true,
            text: `Tab #${session.id}: streamed to ${fmtDollars(total)} · overrun ${overrunRefused ? 'refused (409)' : 'NOT refused'} · settled ${fmtDollars(settled.settlement?.amount ?? 0)}`,
          };
        }

        case 'decline': {
          const r = await simulateDecline();
          const failures = r.dunning?.consecutive_failures ?? r.auto_recharge.consecutive_failures;
          const note =
            r.auto_recharge.action === 'declined'
              ? `card declined (${r.reason}) · failures: ${failures}${r.auto_recharge.disabled ? ' · auto-recharge disabled' : ''}`
              : `no decline fired (${r.auto_recharge.reason ?? r.auto_recharge.action}) — seed a card first`;
          return { ok: r.auto_recharge.action === 'declined', text: note };
        }

        case 'reset': {
          const r = await resetDemo();
          return {
            ok: true,
            text: `Removed ${r.deleted_customers} demo customer${r.deleted_customers === 1 ? '' : 's'} · ledger wiped clean`,
          };
        }
      }
    },
    [invalidate],
  );

  const run = useCallback(
    async (scenario: DemoScenario) => {
      setRunning(scenario);
      try {
        const result = await execute(scenario);
        if (!mountedRef.current) return;
        setResults((r) => ({ ...r, [scenario]: result }));
        (result.ok ? toastOk : toastErr)(result.text);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Scenario failed';
        if (!mountedRef.current) return;
        setResults((r) => ({ ...r, [scenario]: { ok: false, text: msg } }));
        toastErr(msg);
      } finally {
        if (mountedRef.current) setRunning(null);
        await invalidate();
      }
    },
    [execute, invalidate, toastOk, toastErr],
  );

  return { run, running, results };
}

// ── x402 flow (the visualizer driver) ────────────────────────────────────────

export interface X402Step {
  id: string;
  kind: 'request' | 'challenge' | 'retry' | 'settle';
  label: string;
  detail?: string;
}

export interface X402FlowState {
  running: boolean;
  steps: X402Step[];
  challenge?: X402Challenge;
  settlement?: X402Settlement;
  charged?: number;
}

/**
 * Drives the full x402 loop for the visualizer:
 *   1. GET /demo/metered (no signature) → 402 + PAYMENT-REQUIRED challenge
 *   2. present a demo PAYMENT-SIGNATURE → GET again → 200 + settlement
 * Each transition is pushed as a timeline step with a stage-legible delay.
 * Co-invalidates the query family on settle so the ledger row appears live.
 */
export function useX402Flow() {
  const invalidate = usePaymentsInvalidate();
  const { toastErr } = useToast();
  const [state, setState] = useState<X402FlowState>({ running: false, steps: [] });
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const push = useCallback((step: Omit<X402Step, 'id'>) => {
    setState((s) => ({
      ...s,
      steps: [...s.steps, { ...step, id: `${step.kind}-${s.steps.length}-${Date.now()}` }],
    }));
  }, []);

  const delay = useCallback((ms: number) => {
    return new Promise<void>((res) => {
      const t = setTimeout(res, ms);
      timersRef.current.push(t);
    });
  }, []);

  const run = useCallback(async () => {
    clearTimers();
    setState({ running: true, steps: [] });
    try {
      push({ kind: 'request', label: 'Agent requests metered resource', detail: 'GET /v1/payments/demo/metered' });
      await delay(500);

      const first = await probeMetered();
      const challenge = first.challenge;
      push({
        kind: 'challenge',
        label: '402 Payment Required',
        detail: challenge
          ? `PAYMENT-REQUIRED: ${challenge.asset} on ${challenge.network} · ${fmtMicro(challenge.amount)} → ${fmtRef(challenge.pay_to)} · nonce ${challenge.nonce.slice(0, 10)}…`
          : 'PAYMENT-REQUIRED challenge received',
      });
      setState((s) => ({ ...s, challenge }));
      await delay(750);

      push({
        kind: 'retry',
        label: 'Agent signs and retries',
        detail: 'PAYMENT-SIGNATURE: EIP-3009 transfer authorization (gasless)',
      });
      await delay(650);

      // The demo verifies any non-empty PAYMENT-SIGNATURE → 200 + settlement.
      const paid = await probeMetered('0xdemo-signed-eip3009-authorization');
      const settlement = paid.settlement;
      push({
        kind: 'settle',
        label: '200 OK · micro-charge settled to ledger',
        detail: settlement
          ? `tx ${fmtRef(settlement.tx_hash)} · ${fmtMicro(paid.charged ?? 0)} ${paid.currency ?? 'USDC'} · facilitator verified`
          : 'Resource unlocked',
      });
      setState((s) => ({ ...s, settlement, charged: paid.charged, running: false }));
      await invalidate();
    } catch (err) {
      toastErr(err instanceof Error ? err.message : 'x402 flow failed');
      setState((s) => ({ ...s, running: false }));
    }
  }, [clearTimers, push, delay, invalidate, toastErr]);

  const reset = useCallback(() => {
    clearTimers();
    setState({ running: false, steps: [] });
  }, [clearTimers]);

  return { state, run, reset };
}

// ── MPP interactive streamer ─────────────────────────────────────────────────

/** One streamed tick chip. */
export interface StreamedTick {
  amount: number;
  reason: string;
}

const MPP_TICK_AMOUNT = 0.35;
const MPP_TICK_REASONS = ['1 min transcription', '1 completion', '1 min TTS', '1 request'];

/**
 * Streams micro-charges onto an open tab: `start(id)` fires a charge every
 * ~900ms until `stop()`, the tab settles, or the spend limit refuses a tick
 * (409 → recorded as the overrun note, not an error). Cleaned up on unmount.
 */
export function useMppStreamer() {
  const invalidate = usePaymentsInvalidate();
  const { toastErr } = useToast();
  const [streamingId, setStreamingId] = useState<number | null>(null);
  const [recent, setRecent] = useState<StreamedTick[]>([]);
  const [overrunId, setOverrunId] = useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);

  const stop = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    setStreamingId(null);
  }, []);

  useEffect(
    () => () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    },
    [],
  );

  const tick = useCallback(
    async (id: number) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const reason = MPP_TICK_REASONS[Math.floor(Math.random() * MPP_TICK_REASONS.length)];
      try {
        const result = await chargeMppSession(id, { amount: MPP_TICK_AMOUNT });
        setRecent((r) => [{ amount: result.amount, reason }, ...r].slice(0, 6));
        await invalidate();
        // Stop when the tab closes. Deliberately DON'T stop early when the
        // remaining budget can't fund another tick — the next tick's 409
        // refusal is the server-side enforcement moment worth showing.
        if (result.status !== 'open' || result.settled) {
          stop();
        }
      } catch (err) {
        // 409 = spend limit refused the charge — the expected end of stream
        // (and the enforcement moment worth showing), not an error toast.
        if (err instanceof ApiError && err.status === 409) {
          setOverrunId(id);
        } else {
          toastErr(err instanceof Error ? err.message : 'Charge failed');
        }
        stop();
      } finally {
        inFlightRef.current = false;
      }
    },
    [invalidate, stop, toastErr],
  );

  const start = useCallback(
    (id: number) => {
      stop();
      setRecent([]);
      setOverrunId(null);
      setStreamingId(id);
      void tick(id);
      intervalRef.current = setInterval(() => void tick(id), 900);
    },
    [stop, tick],
  );

  return { streamingId, recent, overrunId, start, stop };
}
