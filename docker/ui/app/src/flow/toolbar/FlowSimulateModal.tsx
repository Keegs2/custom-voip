/**
 * Simulate panel for the Call Flow Builder.
 *
 * Dry-runs the flow's *stored* `compiled` artifact against a synthetic inbound
 * call: the admin supplies a test caller ID and an instant (datetime-local),
 * hits Run, and we render the backend's `trace` (the "why") plus a readable
 * view of the `result` keyed on its `kind`:
 *   • twiml  → escaped XML in a <pre>            (ivr / api / conference)
 *   • route  → matched rule + ordered targets    (rcf / trunk)
 *   • ring   → strategy + ordered legs + fallback (ucaas)
 *
 * Because it reads the *saved* compiled artifact, a never-saved flow (or stale
 * compiled) returns 404 — we detect that and tell the admin to Save/Publish.
 *
 * React #310: ALL hooks (store-free here, but mutation + local state + effect)
 * are declared unconditionally at the top, before any early return. The Modal's
 * body branches on render-time values only.
 */
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { simulateFlow } from '../../api/callFlows';
import type {
  SimulateResult,
  SimulateResultBody,
  SimulateRing,
  SimulateRoute,
  SimulateTwiml,
} from '../../types/callFlow';
import { Modal } from '../../components/ui/Modal';
import { Button } from '../../components/ui/Button';
import { CenteredSpinner } from '../../components/ui/Spinner';
import { useToast } from '../../components/ui/ToastContext';
import { ApiError } from '../../api/client';

interface FlowSimulateModalProps {
  open: boolean;
  onClose: () => void;
  /** Saved flow id. Null when the current flow has never been saved. */
  flowId: number | null;
}

/** `YYYY-MM-DDTHH:mm` for `<input type="datetime-local">`, in local time. */
function nowLocalInput(): string {
  const d = new Date();
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** datetime-local string (local) → ISO-8601 (UTC). Empty → undefined (= now). */
function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function FlowSimulateModal({ open, onClose, flowId }: FlowSimulateModalProps) {
  // ── Hooks (all unconditional, top of component) ──────────────────────────
  const { toastErr } = useToast();
  const [callerId, setCallerId] = useState('+16175551234');
  const [when, setWhen] = useState<string>(() => nowLocalInput());

  const simulateMutation = useMutation({
    mutationFn: (): Promise<SimulateResult> =>
      simulateFlow(flowId as number, {
        caller_id: callerId.trim() || undefined,
        now: localInputToIso(when),
      }),
    onError: (e) =>
      toastErr(e instanceof ApiError ? e.message : 'Simulation failed'),
  });

  // Reset the time field to "now" and clear stale results each time the modal
  // opens, so a re-open always presents a fresh starting state.
  const { reset } = simulateMutation;
  useEffect(() => {
    if (open) {
      setWhen(nowLocalInput());
      reset();
    }
  }, [open, reset]);

  // Derived (no hooks) — safe after the hooks above.
  const data = simulateMutation.data;
  const error = simulateMutation.error;
  const is404 = error instanceof ApiError && error.status === 404;

  return (
    <Modal open={open} onClose={onClose} title="Simulate call flow" maxWidth="max-w-2xl">
      {flowId == null ? (
        <EmptyHint text="Save this flow before you can simulate it." />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Inputs */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <Field label="Test caller ID">
              <input
                style={{ ...inputStyle, width: 170 }}
                value={callerId}
                onChange={(e) => setCallerId(e.target.value)}
                placeholder="+16175551234"
              />
            </Field>
            <Field label="Date / time">
              <input
                type="datetime-local"
                style={{ ...inputStyle, width: 210 }}
                value={when}
                onChange={(e) => setWhen(e.target.value)}
              />
            </Field>
            <Button
              variant="primary"
              size="sm"
              loading={simulateMutation.isPending}
              onClick={() => simulateMutation.mutate()}
            >
              Run
            </Button>
          </div>

          <p style={{ margin: 0, fontSize: '0.7rem', color: '#64748b', lineHeight: 1.5 }}>
            Simulates the last <strong style={{ color: '#94a3b8' }}>saved / published</strong> compiled
            artifact. If you see a 404, Save or Publish the flow first.
          </p>

          {/* Result region */}
          {simulateMutation.isPending ? (
            <CenteredSpinner label="Running simulation…" />
          ) : error ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <p style={{ margin: 0, fontSize: '0.8rem', color: '#fca5a5' }}>
                {error instanceof ApiError ? error.message : 'Simulation failed.'}
              </p>
              {is404 && (
                <p style={{ margin: 0, fontSize: '0.74rem', color: '#fbbf24', lineHeight: 1.5 }}>
                  No compiled artifact found for this flow yet — click <strong>Save</strong> (or{' '}
                  <strong>Publish</strong>) in the toolbar, then run the simulation again.
                </p>
              )}
              <Button variant="ghost" size="sm" onClick={() => simulateMutation.mutate()}>
                Retry
              </Button>
            </div>
          ) : data ? (
            <SimulationOutput data={data} />
          ) : (
            <EmptyHint text="Enter a caller and time, then Run." />
          )}
        </div>
      )}
    </Modal>
  );
}

/* ── Output rendering ──────────────────────────────────────────────────────── */

function SimulationOutput({ data }: { data: SimulateResult }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <SectionLabel>Product</SectionLabel>
        <span
          style={{
            padding: '2px 8px',
            borderRadius: 6,
            fontSize: '0.7rem',
            fontWeight: 700,
            color: '#22d3ee',
            background: 'rgba(34,211,238,0.12)',
            border: '1px solid rgba(34,211,238,0.4)',
          }}
        >
          {data.product}
        </span>
      </div>

      {/* Result */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <SectionLabel>Result</SectionLabel>
        <ResultView result={data.result} />
      </div>

      {/* Trace — the "why" */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <SectionLabel>Trace</SectionLabel>
        {data.trace.length === 0 ? (
          <span style={{ fontSize: '0.76rem', color: '#718096' }}>No trace lines returned.</span>
        ) : (
          <ol
            style={{
              margin: 0,
              padding: '10px 12px 10px 30px',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              listStylePosition: 'outside',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '0.72rem',
              lineHeight: 1.5,
              color: '#cbd5e1',
              background: '#0f1117',
              borderRadius: 10,
              border: '1px solid rgba(42,47,69,0.6)',
              maxHeight: '30vh',
              overflow: 'auto',
            }}
          >
            {data.trace.map((line, i) => (
              <li key={i} style={{ color: '#64748b' }}>
                <span style={{ color: '#cbd5e1' }}>{line}</span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

function ResultView({ result }: { result: SimulateResultBody }) {
  const kind = (result as { kind?: string }).kind;

  if (kind === 'twiml') {
    return <TwimlView result={result as SimulateTwiml} />;
  }
  if (kind === 'route') {
    return <RouteView result={result as SimulateRoute} />;
  }
  if (kind === 'ring') {
    return <RingView result={result as SimulateRing} />;
  }
  // Unknown / future shape — never crash, just show the raw JSON.
  return <CodeBlock text={JSON.stringify(result, null, 2)} />;
}

function TwimlView({ result }: { result: SimulateTwiml }) {
  // JSX text content is HTML-escaped by React, so the XML renders verbatim.
  return <CodeBlock text={result.xml ?? ''} accent="#a5d6a7" />;
}

function RouteView({ result }: { result: SimulateRoute }) {
  const targets =
    result.endpoints && result.endpoints.length > 0
      ? result.endpoints
      : result.forward_to != null
        ? [result.forward_to]
        : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SummaryGrid
        rows={[
          ['Matched rule', formatMatchedRule(result.matched_rule)],
          ...(result.strategy != null ? [['Strategy', String(result.strategy)] as Row] : []),
          ...(result.timeout != null ? [['Timeout', `${result.timeout}s`] as Row] : []),
        ]}
      />
      {targets.length > 0 && (
        <OrderedTargets
          label={result.endpoints && result.endpoints.length > 0 ? 'Endpoints (in order)' : 'Forward to'}
          items={targets}
        />
      )}
      {result.ring && Object.keys(result.ring).length > 0 && (
        <LabeledBlock label="Ring">
          <SummaryGrid rows={objectRows(result.ring)} />
        </LabeledBlock>
      )}
      {result.fallback && Object.keys(result.fallback).length > 0 && (
        <LabeledBlock label="Fallback">
          <SummaryGrid rows={objectRows(result.fallback)} />
        </LabeledBlock>
      )}
    </div>
  );
}

function RingView({ result }: { result: SimulateRing }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <SummaryGrid rows={[['Strategy', result.strategy ?? '—']]} />
      <OrderedTargets label="Legs (in order)" items={result.legs ?? []} />
      {result.fallback && Object.keys(result.fallback).length > 0 && (
        <LabeledBlock label="Fallback">
          <SummaryGrid rows={objectRows(result.fallback)} />
        </LabeledBlock>
      )}
    </div>
  );
}

/* ── Small presentational helpers ───────────────────────────────────────────── */

type Row = [string, string];

function OrderedTargets({ label, items }: { label: string; items: unknown[] }) {
  return (
    <LabeledBlock label={label}>
      <ol
        style={{
          margin: 0,
          padding: '0 0 0 20px',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          fontSize: '0.78rem',
          color: '#e2e8f0',
        }}
      >
        {items.map((item, i) => (
          <li key={i} style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
            {describeTarget(item)}
          </li>
        ))}
      </ol>
    </LabeledBlock>
  );
}

function SummaryGrid({ rows }: { rows: Row[] }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'max-content 1fr',
        gap: '4px 14px',
        fontSize: '0.78rem',
      }}
    >
      {rows.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <span style={{ color: '#718096' }}>{k}</span>
          <span style={{ color: '#e2e8f0', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}>
            {v}
          </span>
        </div>
      ))}
    </div>
  );
}

function LabeledBlock({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '10px 12px',
        borderRadius: 10,
        background: 'rgba(26,29,39,0.9)',
        border: '1px solid rgba(42,47,69,0.8)',
      }}
    >
      <span style={{ fontSize: '0.66rem', fontWeight: 800, letterSpacing: '0.05em', textTransform: 'uppercase', color: '#64748b' }}>
        {label}
      </span>
      {children}
    </div>
  );
}

function CodeBlock({ text, accent = '#cbd5e1' }: { text: string; accent?: string }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: 14,
        fontSize: '0.72rem',
        lineHeight: 1.5,
        color: accent,
        background: '#0f1117',
        borderRadius: 10,
        border: '1px solid rgba(42,47,69,0.6)',
        overflow: 'auto',
        maxHeight: '46vh',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {text}
    </pre>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#4a5568' }}>
      {children}
    </span>
  );
}

function EmptyHint({ text }: { text: string }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px 16px',
        textAlign: 'center',
        fontSize: '0.8rem',
        color: '#718096',
      }}
    >
      {text}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: '0.6rem', fontWeight: 800, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#4a5568' }}>
        {label}
      </span>
      {children}
    </label>
  );
}

/* ── Pure formatting ────────────────────────────────────────────────────────── */

function formatMatchedRule(rule: number | null | undefined): string {
  if (rule == null) return 'none (fallback / default)';
  return `#${rule}`;
}

/** Turn one endpoint/leg into a readable single line. */
function describeTarget(item: unknown): string {
  if (item == null) return '—';
  if (typeof item === 'string' || typeof item === 'number') return String(item);
  if (typeof item === 'object') {
    const o = item as Record<string, unknown>;
    const dest =
      o.destination ?? o.forward_to ?? o.number ?? o.uri ?? o.endpoint ?? o.address ?? o.target ?? o.did ?? o.extension;
    const extras: string[] = [];
    if (o.timeout != null) extras.push(`timeout ${String(o.timeout)}s`);
    if (o.priority != null) extras.push(`priority ${String(o.priority)}`);
    if (o.transport != null) extras.push(String(o.transport));
    if (dest != null) {
      return `${String(dest)}${extras.length ? ` — ${extras.join(', ')}` : ''}`;
    }
    return JSON.stringify(item);
  }
  return String(item);
}

/** Flatten a loose object into label/value rows for SummaryGrid. */
function objectRows(obj: Record<string, unknown>): Row[] {
  return Object.entries(obj).map(([k, v]) => [
    k,
    v != null && typeof v === 'object' ? JSON.stringify(v) : String(v),
  ]);
}

const inputStyle: React.CSSProperties = {
  height: 34,
  padding: '0 10px',
  borderRadius: 8,
  fontSize: '0.8rem',
  color: '#e2e8f0',
  background: '#1e2130',
  border: '1px solid #2a2f45',
  outline: 'none',
};
