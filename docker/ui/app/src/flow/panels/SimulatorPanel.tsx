/**
 * SimulatorPanel — "Test call": pick who calls, when, and which keys they
 * press, then step through what happens (contract §8.2 `/simulate`, run by
 * the server on the CURRENT draft — sent with the request, so unsaved edits
 * count). The canvas highlights the block each step is on.
 *
 * With a `target` it tests a Flow assistant PROPOSAL instead (assist
 * contract §5: `assist_job_id`, no `draft_graph` — the server stands its new
 * messages in by name). The proposal is on the canvas, so the steps follow
 * its blocks; nothing touches the draft.
 *
 * Times are wall-clock times in the flow's business-hours time zone (the
 * first Business hours block's), so "Saturday 11 AM" means what the
 * customer means by it.
 */
import { useEffect, useId, useMemo, useState, type CSSProperties } from 'react';
import { useMutation } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, Delete, FlaskConical, Phone } from 'lucide-react';
import { simulateFlow } from '../../api/ivr';
import type { IvrConfigMap, SimStep, SimulateResult } from '../../types/ivr';
import { ivrErrorText } from '../../pages/ivr/ivrData';
import { useIvrWorkspace } from '../../pages/ivr/IvrContext';
import { DIGIT_ORDER, isIvrNodeType, timezoneLabel } from '../model/blocks';
import { checkExternalNumber, toUsE164 } from '../compile/policy';
import { useFlow, useFlowStoreApi, type FlowNode } from '../store/flowStore';
import { useBuilderData } from '../BuilderData';
import { useAnalysis } from '../useFlowAnalysis';
import { BlockIcon } from '../canvas/BlockIcon';
import { SideSheet } from './SideSheet';

/* ─── Time-zone wall clock ⇄ instant ──────────────────────── */

function zoneParts(ms: number, tz: string) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), h: Number(p.hour), min: Number(p.minute), wd: p.weekday };
}

/** Wall time in `tz` → epoch ms (two passes settle DST edges). */
function zonedToMs(y: number, m: number, d: number, h: number, min: number, tz: string): number {
  let guess = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 2; i++) {
    const p = zoneParts(guess, tz);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    guess += Date.UTC(y, m - 1, d, h, min) - asUtc;
  }
  return guess;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** epoch ms → "YYYY-MM-DDTHH:MM" wall time in `tz` (a datetime-local value). */
function toLocalInput(ms: number, tz: string): string {
  const p = zoneParts(ms, tz);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.min)}`;
}

function fromLocalInput(value: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  return zonedToMs(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), tz);
}

/** The next given weekday (0 = Sun) at hh:mm wall time, from `now`. */
function nextWeekday(now: number, tz: string, weekday: number, h: number, min = 0): number {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const p = zoneParts(now, tz);
  const today = names.indexOf(p.wd ?? 'Mon');
  const add = ((weekday - today + 7) % 7) || 7;
  const base = new Date(Date.UTC(p.y, p.m - 1, p.d + add));
  return zonedToMs(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, min, tz);
}

/** "2026-10-27T10:00" → "Tue, Oct 27, 10:00 AM" (already a wall time; no zone maths). */
function whenLabel(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return value;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
  return d.toLocaleString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Server outcome (a sentence or an object) → one readable line. */
function describeOutcome(outcome: unknown): string {
  if (typeof outcome === 'string') return outcome;
  if (outcome && typeof outcome === 'object') {
    const o = outcome as Record<string, unknown>;
    for (const k of ['summary', 'description', 'message', 'text']) if (typeof o[k] === 'string') return o[k] as string;
    const exit = typeof o.exit === 'string' ? o.exit : null;
    const to = typeof o.transfer_to === 'string' ? o.transfer_to : typeof o.to === 'string' ? o.to : null;
    if (exit) return `Ends with: ${exit.replace(/_/g, ' ')}${to ? ` (${to})` : ''}.`;
  }
  return 'The call ends.';
}

/* ─── Panel ───────────────────────────────────────────────── */

/** A Flow assistant proposal to test instead of the draft. */
export interface SimulatorTarget {
  assistJobId: string;
  nodes: readonly FlowNode[];
  titleOf: (id: string) => string;
}

export interface SimulatorPanelProps {
  onClose: () => void;
  target?: SimulatorTarget | null;
  /** Phone width: the sheet covers the screen. */
  fullscreen?: boolean;
}

export function SimulatorPanel({ onClose, target = null, fullscreen = false }: SimulatorPanelProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const ws = useIvrWorkspace();
  const store = useFlowStoreApi();
  const builder = useBuilderData();
  const analysis = useAnalysis();
  const draftNodes = useFlow((s) => s.nodes);
  const nodes = target?.nodes ?? draftNodes;
  const ids = { mode: useId(), number: useId(), when: useId(), keys: useId() };
  const tz = useMemo(() => {
    const hours = nodes.find((n) => n.type === 'schedule');
    return hours ? (hours.data.config as IvrConfigMap['schedule']).tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
  }, [nodes]);
  const [now] = useState(() => Date.now());
  const [callerMode, setCallerMode] = useState<'number' | 'anonymous'>('number');
  const [number, setNumber] = useState('(508) 555-0177');
  const [when, setWhen] = useState(() => toLocalInput(now, tz));
  const [keys, setKeys] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);
  const [result, setResult] = useState<SimulateResult | null>(null);
  const [setupOpen, setSetupOpen] = useState(true);

  const run = useMutation({
    mutationFn: () => {
      const at = fromLocalInput(when, tz) ?? now;
      const caller = callerMode === 'anonymous' ? 'anonymous' : (toUsE164(number) ?? number.trim());
      const call = { caller, at: new Date(at).toISOString(), digits: keys };
      return simulateFlow(
        store.getState().meta.id,
        target ? { assist_job_id: target.assistJobId, ...call } : { draft_graph: store.getState().graph(), ...call },
        ws.scope.customerId,
      );
    },
    onSuccess: (r) => {
      setResult(r);
      setCursor(0);
      setSetupOpen(false);
    },
  });

  const steps: SimStep[] = result?.steps ?? [];
  const current = steps[Math.min(cursor, steps.length - 1)];

  // Highlight the block the current step is on and bring it into view; clear on close.
  useEffect(() => {
    store.getState().setSimNode(current?.node_id ?? null);
    if (current?.node_id) store.getState().revealBlock(current.node_id);
  }, [store, current?.node_id]);
  useEffect(() => () => store.getState().setSimNode(null), [store]);

  // ── Derived (after all hooks) ──
  // A proposal is read-only on screen, but anyone who can edit may test it.
  const readOnly = target ? !ws.canEdit : builder.readOnly;
  const titleOf = target?.titleOf ?? analysis.titleOf;
  const numberOk = callerMode === 'anonymous' || checkExternalNumber(number).e164 !== null;
  const presets: { label: string; ms: number }[] = [
    { label: 'Now', ms: now },
    { label: 'Tuesday 10 AM', ms: nextWeekday(now, tz, 2, 10) },
    { label: 'Tuesday 8 PM', ms: nextWeekday(now, tz, 2, 20) },
    { label: 'Saturday 11 AM', ms: nextWeekday(now, tz, 6, 11) },
  ];
  const shown = steps.slice(0, cursor + 1);

  return (
    <SideSheet
      title={target ? 'Test call: proposal' : 'Test call'}
      sub={
        target
          ? 'Walk a pretend call through the proposed flow — nothing is dialed and your draft is unchanged.'
          : 'Walk a pretend call through your current draft — nothing is dialed.'
      }
      icon={<FlaskConical size={16} aria-hidden="true" />}
      onClose={onClose}
      fullscreen={fullscreen}
      footer={
        <>
          <button type="button" className="dl-btn dl-btn-ghost" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="dl-btn dl-btn-primary"
            disabled={readOnly || !numberOk || run.isPending}
            onClick={() => run.mutate()}
          >
            {run.isPending ? <span className="vm-spin vm-spin-light" aria-hidden="true" /> : <Phone size={14} aria-hidden="true" />}
            {result ? 'Run again' : 'Start test call'}
          </button>
        </>
      }
    >
      {readOnly && <div className="dl-banner dl-banner-warn">Test calls are available to people who can edit this flow.</div>}

      {!setupOpen && result ? (
        <div className="ivr-sim-setup">
          <dl className="ivr-sim-facts">
            <div>
              <dt>Caller</dt>
              <dd>{callerMode === 'anonymous' ? 'Withheld' : number}</dd>
            </div>
            <div>
              <dt>When</dt>
              <dd>{whenLabel(when)}</dd>
            </div>
            <div>
              <dt>Keys</dt>
              <dd>{keys.length ? keys.join(' ') : 'none'}</dd>
            </div>
          </dl>
          <button type="button" className="dl-btn dl-btn-ghost ivr-btn-sm" onClick={() => setSetupOpen(true)}>
            Change
          </button>
        </div>
      ) : (
      <>
      <fieldset className="ivr-field ivr-fieldset">
        <legend className="ivr-label">Who calls</legend>
        <div className="ivr-sim-caller">
          <label className={`ivr-radio${callerMode === 'number' ? ' ivr-radio-on' : ''}`}>
            <input type="radio" name={ids.mode} checked={callerMode === 'number'} onChange={() => setCallerMode('number')} />
            From
          </label>
          <label className="ivr-sr" htmlFor={ids.number}>
            Caller’s number
          </label>
          <input
            id={ids.number}
            className="dl-input ivr-grow"
            inputMode="tel"
            value={number}
            disabled={callerMode !== 'number'}
            onChange={(e) => setNumber(e.target.value)}
            aria-invalid={!numberOk || undefined}
          />
        </div>
        <label className={`ivr-radio${callerMode === 'anonymous' ? ' ivr-radio-on' : ''}`}>
          <input type="radio" name={ids.mode} checked={callerMode === 'anonymous'} onChange={() => setCallerMode('anonymous')} />
          With caller ID withheld
        </label>
      </fieldset>

      <div className="ivr-field">
        <label className="ivr-label" htmlFor={ids.when}>
          When ({timezoneLabel(tz).replace(/ \(.*$/, '')} time)
        </label>
        <input id={ids.when} type="datetime-local" className="dl-input vm-input-full" value={when} onChange={(e) => setWhen(e.target.value)} />
        <div className="ivr-presets" role="group" aria-label="Quick times">
          {presets.map((p) => (
            <button key={p.label} type="button" className="ivr-preset" onClick={() => setWhen(toLocalInput(p.ms, tz))}>
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="ivr-field">
        <span className="ivr-label" id={ids.keys}>
          Keys the caller presses
        </span>
        <div className="ivr-sim-keys" aria-live="polite">
          {keys.length === 0 ? (
            <span className="ivr-muted">None yet — each menu will wait, then follow “No key pressed”.</span>
          ) : (
            keys.map((k, i) => (
              <span key={i} className="ivr-key ivr-key-lg">
                {k}
              </span>
            ))
          )}
        </div>
        <div className="ivr-keypad ivr-keypad-sim" role="group" aria-labelledby={ids.keys}>
          {DIGIT_ORDER.map((d) => (
            <button
              key={d}
              type="button"
              className="ivr-keycap"
              onClick={() => setKeys((k) => (k.length < 20 ? [...k, d] : k))}
              aria-label={`Press ${d === '*' ? 'star' : d === '#' ? 'pound' : d}`}
            >
              {d}
            </button>
          ))}
        </div>
        <div className="ivr-sim-keytools">
          <button type="button" className="vm-linkbtn ivr-linkbtn" onClick={() => setKeys((k) => k.slice(0, -1))} disabled={!keys.length}>
            <Delete size={13} aria-hidden="true" /> Remove last
          </button>
          <button type="button" className="vm-linkbtn ivr-linkbtn" onClick={() => setKeys([])} disabled={!keys.length}>
            Clear
          </button>
        </div>
        <p className="dl-help">Each key answers the next menu the call reaches.</p>
      </div>
      </>
      )}

      {run.isError && (
        <div className="dl-banner dl-banner-err" role="alert">
          {ivrErrorText(run.error, 'The test call couldn’t run. Try again.')}
        </div>
      )}

      {result && (
        <section className="ivr-sim-result" aria-label="Test call result">
          <div className="ivr-sim-head">
            <h3 className="ivr-insp-h">What happens</h3>
            {steps.length > 1 && (
              <div className="ivr-sim-step-tools">
                <button
                  type="button"
                  className="ivr-mini-btn"
                  onClick={() => setCursor((c) => Math.max(0, c - 1))}
                  disabled={cursor === 0}
                  aria-label="Previous step"
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                </button>
                <span className="ivr-sim-count">
                  Step {Math.min(cursor + 1, steps.length)} of {steps.length}
                </span>
                <button
                  type="button"
                  className="ivr-mini-btn"
                  onClick={() => setCursor((c) => Math.min(steps.length - 1, c + 1))}
                  disabled={cursor >= steps.length - 1}
                  aria-label="Next step"
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
                <button type="button" className="vm-linkbtn ivr-linkbtn" onClick={() => setCursor(steps.length - 1)} disabled={cursor >= steps.length - 1}>
                  Show all
                </button>
              </div>
            )}
          </div>
          <ol className="ivr-transcript ivr-sim-steps">
            {shown.map((s, i) => {
              const kind = isIvrNodeType(s.kind) ? s.kind : null;
              return (
                <li
                  key={`${s.node_id}-${i}`}
                  className={`ivr-tx-step${i === cursor ? ' ivr-tx-step-on' : ''}`}
                  style={kind ? ({ '--ivr-hue': `var(--ivr-${kind})` } as CSSProperties) : undefined}
                >
                  <span className="ivr-tx-n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <div className="ivr-tx-main">
                    <button
                      type="button"
                      className="ivr-tx-title"
                      onClick={() => (target ? store.getState().revealBlock(s.node_id) : store.getState().focusBlock(s.node_id))}
                    >
                      {kind && <BlockIcon type={kind} size={13} />} {titleOf(s.node_id)}
                    </button>
                    {s.says.length > 0 && (
                      <p className="ivr-tx-says">
                        Hears {s.says.map((n) => `“${n}”`).join(', ')}
                      </p>
                    )}
                    {s.note && <p className="ivr-tx-note">{s.note}</p>}
                  </div>
                </li>
              );
            })}
          </ol>
          {cursor >= steps.length - 1 && <p className="ivr-sim-outcome">{describeOutcome(result.outcome)}</p>}
        </section>
      )}
    </SideSheet>
  );
}
