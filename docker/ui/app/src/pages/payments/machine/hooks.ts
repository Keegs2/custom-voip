/**
 * Machine-payments hooks: the x402 402→pay→settle handshake driver and the
 * Stripe MPP agent-tab controller. These own the local, animated "wow" state
 * (the challenge, the streaming micro-charges) while delegating persistence to
 * the API and co-invalidating the shared payments family so the ledger + balance
 * react live.
 *
 * React #310: every hook is unconditional at the top of each custom hook.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { useToast } from '../../../components/ui/useToast';
import { usePaymentsInvalidate } from '../../../components/payments/queries';
import { fmtMicro } from '../../../components/payments/format';
import { chargeMppSession, createMppSession, probeMetered } from '../../../api/payments';
import type {
  MeteredResponse,
  MppChargeResult,
  MppSession,
  MppSessionCreateRequest,
  X402Challenge,
  X402Settlement,
} from '../../../types/payments';

/** The per-tick micro-charge an agent streams onto an MPP tab (dollars). */
const MPP_TICK_AMOUNT = 0.05;

/** Plausible "what the agent paid for" labels for a streamed tick. */
const MPP_TICK_REASONS = ['1 min transcription', '1 request', '1 min TTS', '1 completion'];

/** One step in the x402 handshake timeline, for the animated visualizer. */
export interface X402Step {
  id: string;
  kind: 'request' | 'challenge' | 'retry' | 'settle';
  label: string;
  detail?: string;
  at: number;
}

export interface X402State {
  running: boolean;
  steps: X402Step[];
  challenge?: X402Challenge;
  settlement?: X402Settlement;
}

/**
 * Drives the full x402 loop for the visualizer:
 *   1. GET /demo/metered (no signature) → expect 402 + challenge
 *   2. present the demo PAYMENT-SIGNATURE → GET again → expect 200 + settlement
 * Each transition is pushed as a timeline step with a small delay so the
 * handshake is legible on stage. Co-invalidates the ledger on settle.
 */
export function useX402Flow() {
  const invalidate = usePaymentsInvalidate();
  const { toastErr } = useToast();
  const [state, setState] = useState<X402State>({ running: false, steps: [] });
  const timersRef = useRef<Array<ReturnType<typeof setTimeout>>>([]);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  useEffect(() => () => clearTimers(), [clearTimers]);

  const push = useCallback((step: Omit<X402Step, 'id' | 'at'>) => {
    setState((s) => ({
      ...s,
      steps: [...s.steps, { ...step, id: `${step.kind}-${Date.now()}-${s.steps.length}`, at: Date.now() }],
    }));
  }, []);

  const delay = (ms: number) => new Promise<void>((res) => {
    const t = setTimeout(res, ms);
    timersRef.current.push(t);
  });

  const run = useCallback(async () => {
    clearTimers();
    setState({ running: true, steps: [] });
    try {
      push({ kind: 'request', label: 'Agent requests metered resource', detail: 'GET /demo/metered' });
      await delay(500);

      const challengeResp: MeteredResponse = await probeMetered();
      const challenge = challengeResp.challenge;
      push({
        kind: 'challenge',
        label: '402 Payment Required',
        detail: challenge
          ? `${challenge.asset} on ${challenge.network} · pay ${fmtMicro(challenge.amount)} to ${challenge.pay_to.slice(0, 10)}…`
          : 'PAYMENT-REQUIRED challenge received',
      });
      setState((s) => ({ ...s, challenge }));
      await delay(750);

      push({ kind: 'retry', label: 'Agent signs & retries (EIP-3009)', detail: 'PAYMENT-SIGNATURE presented' });
      await delay(650);

      // The demo verifies any non-empty PAYMENT-SIGNATURE → 200 + settlement.
      const settleResp = await probeMetered('0xdemo-signed-eip3009-auth');
      const settlement = settleResp.settlement;
      push({
        kind: 'settle',
        label: '200 OK · settled to ledger',
        detail: settlement
          ? `tx ${settlement.tx_hash.slice(0, 10)}… · ${fmtMicro(settlement.charged)} ${settlement.currency} · CDP verified`
          : 'Resource unlocked',
      });
      setState((s) => ({ ...s, settlement, running: false }));
      await invalidate();
    } catch (err) {
      toastErr(err instanceof Error ? err.message : 'x402 flow failed');
      setState((s) => ({ ...s, running: false }));
    }
  }, [clearTimers, push, invalidate, toastErr]);

  const reset = useCallback(() => {
    clearTimers();
    setState({ running: false, steps: [] });
  }, [clearTimers]);

  return { state, run, reset };
}

/** Create a new MPP agent tab (spend-limited session). */
export function useCreateMppSession(onDone?: (s: MppSession) => void) {
  const invalidate = usePaymentsInvalidate();
  const { toastOk, toastErr } = useToast();
  return useMutation({
    mutationFn: (body: MppSessionCreateRequest) => createMppSession(body),
    onSuccess: async (s) => {
      toastOk(`Agent tab opened · ${s.label ?? `#${s.id}`}`);
      await invalidate();
      onDone?.(s);
    },
    onError: (err: Error) => toastErr(err.message || 'Could not open agent tab'),
  });
}

/** A streamed tick, rendered as a chip in the agent-tab card. */
export interface StreamedTick {
  amount: number;
  reason: string;
}

/**
 * Streams micro-charges onto an MPP tab. `start(id)` begins an interval that
 * appends a charge every ~1.1s until `stop()`, the spend limit is hit (backend
 * refuses with 409), or the tab settles; each accepted charge invalidates the
 * ledger so the balance and history move live. The backend REQUIRES an explicit
 * amount per tick, so each call supplies one. All state is local + cleaned up on
 * unmount.
 */
export function useMppStreamer() {
  const invalidate = usePaymentsInvalidate();
  const { toastErr } = useToast();
  const [streamingId, setStreamingId] = useState<number | string | null>(null);
  const [recent, setRecent] = useState<StreamedTick[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const inFlightRef = useRef(false);

  const stop = useCallback(() => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;
    setStreamingId(null);
  }, []);

  useEffect(() => () => { if (intervalRef.current) clearInterval(intervalRef.current); }, []);

  const tick = useCallback(
    async (id: number | string) => {
      if (inFlightRef.current) return;
      inFlightRef.current = true;
      const reason = MPP_TICK_REASONS[Math.floor(Math.random() * MPP_TICK_REASONS.length)];
      try {
        const result: MppChargeResult = await chargeMppSession(id, { amount: MPP_TICK_AMOUNT });
        setRecent((r) => [{ amount: result.amount, reason }, ...r].slice(0, 8));
        await invalidate();
        // Auto-stop when the tab is no longer open (settled) or the remaining
        // budget can't fund another tick.
        if (result.status !== 'open' || result.settled || result.remaining < MPP_TICK_AMOUNT) {
          stop();
        }
      } catch (err) {
        // A 409 means the spend limit was reached — expected end of stream, not
        // an error to shout about; anything else surfaces a toast.
        const status = (err as { status?: number }).status;
        if (status !== 409) {
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
    (id: number | string) => {
      stop();
      setRecent([]);
      setStreamingId(id);
      // Fire one immediately, then stream.
      void tick(id);
      intervalRef.current = setInterval(() => void tick(id), 1100);
    },
    [stop, tick],
  );

  return { streamingId, recent, start, stop };
}
