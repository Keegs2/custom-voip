/**
 * IvrHome — /ivr: the customer's IVR numbers (which flow each answers with,
 * whether callers hear it, when it was last published), their flows, and
 * their messages. Three states (plan §6.1):
 *
 *   not entitled            → IvrIntro (what IVR is, how to get it)
 *   entitled, no numbers    → "no IVR number yet" + flows + messages
 *   otherwise               → numbers + flows + messages
 *
 * Writers (tenant 'user', staff) get New flow, Choose flow, Rename and
 * Delete; a 'readonly' user sees the same page with view-only actions.
 *
 * React #310: every hook is unconditional, above the state branches.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, PencilLine, Plus, Trash2, Workflow } from 'lucide-react';
import { createFlow, deleteFlow, updateFlow, updateIvrNumber } from '../../api/ivr';
import { useToast } from '../../components/ui/ToastContext';
import { Spinner } from '../../components/ui/Spinner';
import type { FlowSummary, IvrNumber } from '../../types/ivr';
import { fmt } from '../../utils/format';
import { ConfirmDialog } from '../voicemail/VmDialog';
import { useIvrWorkspace } from './IvrContext';
import { BindFlowDialog, NameDialog } from './IvrDialogs';
import { IvrIntro } from './IvrIntro';
import { PromptManager } from './prompts/PromptManager';
import { formatWhen, hasUnpublishedChanges, plural } from './format';
import { invalidateIvr, isIvrError, ivrErrorText, useIvrSummary } from './ivrData';

type DialogState =
  | { kind: 'none' }
  | { kind: 'new-flow' }
  | { kind: 'rename-flow'; flow: FlowSummary }
  | { kind: 'delete-flow'; flow: FlowSummary }
  | { kind: 'bind'; number: IvrNumber }
  | { kind: 'rename-number'; number: IvrNumber };

export function IvrHome({ staffPicker }: { staffPicker?: ReactNode }) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const ws = useIvrWorkspace();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toastOk } = useToast();
  const summary = useIvrSummary(ws.scope);
  const [dialog, setDialog] = useState<DialogState>({ kind: 'none' });
  const close = () => setDialog({ kind: 'none' });

  const refresh = () => invalidateIvr(queryClient, ws.scope);

  const create = useMutation({
    mutationFn: (name: string) => createFlow({ name }, ws.scope.customerId),
    onSuccess: (flow) => {
      void refresh();
      close();
      navigate(ws.href(`/ivr/flows/${flow.id}`));
    },
  });
  const renameFlow = useMutation({
    mutationFn: ({ flow, name }: { flow: FlowSummary; name: string }) =>
      updateFlow(flow.id, { name, revision: flow.revision }, ws.scope.customerId),
    onSuccess: (flow) => {
      void refresh();
      close();
      toastOk(`Renamed to “${flow.name}”.`);
    },
    onError: (err) => {
      // Someone saved the flow meanwhile: refresh so the next try carries the new revision.
      if (isIvrError(err, 409, 'stale_revision')) void refresh();
    },
  });
  const removeFlow = useMutation({
    mutationFn: (flow: FlowSummary) => deleteFlow(flow.id, ws.scope.customerId),
    onSuccess: (_v, flow) => {
      void refresh();
      close();
      toastOk(`Deleted “${flow.name}”.`);
    },
  });
  const updateNumber = useMutation({
    mutationFn: ({ number, body }: { number: IvrNumber; body: { name?: string | null; flow_id?: number | null } }) =>
      updateIvrNumber(number.id, body, ws.scope.customerId),
    onSuccess: (n) => {
      void refresh();
      close();
      toastOk(n.flow_name ? `${fmt(n.did)} now answers with “${n.flow_name}”.` : `Saved ${fmt(n.did)}.`);
    },
  });

  const flowsById = useMemo(() => new Map((summary.data?.flows ?? []).map((f) => [f.id, f])), [summary.data]);

  // ── Derived (after all hooks) ──
  const notEntitled =
    (summary.data && !summary.data.enabled) || isIvrError(summary.error, 403, 'ivr_not_enabled');

  const header = (
    <header className="dl-header ivr-header">
      <div className="dl-header-id">
        <div className="dl-crumb">
          <span>{ws.customerName}</span>
          <span className="dl-crumb-sep" aria-hidden="true">/</span>
          <span>IVR</span>
          {ws.staff && <span className="vm-staff-tag">{ws.viewer === 'admin' ? 'Staff' : 'Staff preview'}</span>}
        </div>
        <h1 className="dl-title">IVR</h1>
        <p className="dl-sub">Design what callers hear when they dial your IVR numbers — menus, business hours and transfers.</p>
      </div>
      <div className="ivr-header-side">
        {staffPicker}
        {summary.data?.enabled && (
          <div className="dl-metrics dl-metrics-wrap">
            <Metric value={summary.data.numbers.length} label="IVR numbers" />
            <Metric value={summary.data.flows.length} label="Flows" />
            <Metric value={summary.data.numbers.filter((n) => n.enabled && n.published).length} label="Live" />
          </div>
        )}
      </div>
    </header>
  );

  if (summary.isLoading) {
    return (
      <div className="dl-shell">
        {header}
        <div className="ivr-state" role="status">
          <Spinner /> Loading your IVR…
        </div>
      </div>
    );
  }
  if (notEntitled) {
    return (
      <div className="dl-shell">
        {header}
        <IvrIntro staff={ws.staff} />
      </div>
    );
  }
  if (summary.isError || !summary.data) {
    return (
      <div className="dl-shell">
        {header}
        <div className="dl-banner dl-banner-err ivr-gap" role="alert">
          {ivrErrorText(summary.error, 'Your IVR couldn’t be loaded.')}{' '}
          <button type="button" className="vm-linkbtn" onClick={() => void summary.refetch()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const { numbers, flows } = summary.data;
  const errorOf = (m: { error: unknown }, fallback: string) =>
    m.error ? ivrErrorText(m.error, fallback) : null;

  return (
    <div className="dl-shell">
      {header}

      <div className="ivr-sections">
        {/* ── Numbers ─────────────────────────────────────── */}
        <section className="dl-panel ivr-panel" aria-labelledby="ivr-numbers-title">
          <div className="ivr-panel-head">
            <div>
              <h2 id="ivr-numbers-title" className="ivr-panel-title">
                Your IVR numbers
              </h2>
              <p className="ivr-panel-sub">Each number answers with one flow. Callers hear its published version.</p>
            </div>
          </div>
          {numbers.length === 0 ? (
            <div className="ivr-empty">
              <span className="ivr-empty-icon" aria-hidden="true">
                <Workflow size={20} strokeWidth={1.8} />
              </span>
              <div>
                <p className="ivr-empty-title">No IVR number yet</p>
                <p className="ivr-empty-copy">
                  {ws.staff
                    ? 'Assign an IVR number to this customer in TED (Customer 360 → Products). Flows can be built and tested now.'
                    : 'You can build and test flows now. Ask your Granite account team for an IVR number; once it’s assigned, choose the flow it answers with here.'}
                </p>
              </div>
            </div>
          ) : (
            <ul className="ivr-rows ivr-rows-numbers">
              <li className="ivr-row ivr-row-head" aria-hidden="true">
                <span>Number</span>
                <span>Answers with</span>
                <span>Callers hear</span>
                <span>Last published</span>
                <span />
              </li>
              {numbers.map((n) => {
                const flow = n.flow_id !== null ? flowsById.get(n.flow_id) ?? null : null;
                return (
                  <li key={n.id} className="ivr-row">
                    <span className="ivr-cell ivr-cell-id">
                      <span className="ivr-number">{fmt(n.did)}</span>
                      <span className="ivr-cell-sub">{n.name ?? 'No name'}</span>
                    </span>
                    <span className="ivr-cell" data-label="Answers with">
                      {flow ? (
                        <Link className="ivr-link" to={ws.href(`/ivr/flows/${flow.id}`)}>
                          {flow.name}
                        </Link>
                      ) : (
                        <span className="ivr-muted">{n.flow_name ?? 'No flow'}</span>
                      )}
                    </span>
                    <span className="ivr-cell" data-label="Callers hear">
                      <NumberStatus number={n} flow={flow} />
                    </span>
                    <span className="ivr-cell ivr-cell-when" data-label="Last published">
                      {formatWhen(flow?.published_at)}
                    </span>
                    <span className="ivr-cell ivr-cell-actions">
                      {ws.canEdit && (
                        <>
                          <button type="button" className="dl-btn dl-btn-ghost ivr-btn-sm" onClick={() => setDialog({ kind: 'bind', number: n })}>
                            {n.flow_id === null ? 'Choose a flow' : 'Change flow'}
                          </button>
                          <button
                            type="button"
                            className="vm-iconbtn"
                            aria-label={`Rename ${fmt(n.did)}`}
                            title="Rename"
                            onClick={() => setDialog({ kind: 'rename-number', number: n })}
                          >
                            <PencilLine size={15} aria-hidden="true" />
                          </button>
                        </>
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* ── Flows ───────────────────────────────────────── */}
        <section className="dl-panel ivr-panel" aria-labelledby="ivr-flows-title">
          <div className="ivr-panel-head">
            <div>
              <h2 id="ivr-flows-title" className="ivr-panel-title">
                Flows
              </h2>
              <p className="ivr-panel-sub">A flow is the menu and routing you design. Edits stay a draft until you publish.</p>
            </div>
            {ws.canEdit && (
              <button type="button" className="dl-btn dl-btn-primary" onClick={() => setDialog({ kind: 'new-flow' })}>
                <Plus size={15} aria-hidden="true" /> New flow
              </button>
            )}
          </div>
          {flows.length === 0 ? (
            <div className="ivr-empty">
              <span className="ivr-empty-icon" aria-hidden="true">
                <Workflow size={20} strokeWidth={1.8} />
              </span>
              <div>
                <p className="ivr-empty-title">No flows yet</p>
                <p className="ivr-empty-copy">
                  {ws.canEdit
                    ? 'Start one with New flow: drag blocks onto the canvas, connect them, then publish.'
                    : 'Nobody has built a flow on this account yet.'}
                </p>
              </div>
            </div>
          ) : (
            <ul className="ivr-rows ivr-rows-flows">
              <li className="ivr-row ivr-row-head" aria-hidden="true">
                <span>Flow</span>
                <span>Status</span>
                <span>Used by</span>
                <span>Last edited</span>
                <span />
              </li>
              {flows.map((f) => (
                <li key={f.id} className="ivr-row">
                  <span className="ivr-cell ivr-cell-id">
                    <Link className="ivr-flow-name" to={ws.href(`/ivr/flows/${f.id}`)}>
                      {f.name}
                    </Link>
                  </span>
                  <span className="ivr-cell" data-label="Status">
                    <FlowStatus flow={f} />
                  </span>
                  <span className="ivr-cell" data-label="Used by">
                    {f.numbers.length ? (
                      <span className="ivr-numlist">{f.numbers.map(fmt).join(', ')}</span>
                    ) : (
                      <span className="ivr-muted">No number</span>
                    )}
                  </span>
                  <span className="ivr-cell ivr-cell-when" data-label="Last edited">
                    {formatWhen(f.updated_at)}
                  </span>
                  <span className="ivr-cell ivr-cell-actions">
                    <Link className="dl-btn dl-btn-ghost ivr-btn-sm" to={ws.href(`/ivr/flows/${f.id}`)}>
                      {ws.canEdit ? 'Open builder' : 'View'} <ArrowUpRight size={13} aria-hidden="true" />
                    </Link>
                    {ws.canEdit && (
                      <>
                        <button
                          type="button"
                          className="vm-iconbtn"
                          aria-label={`Rename ${f.name}`}
                          title="Rename"
                          onClick={() => setDialog({ kind: 'rename-flow', flow: f })}
                        >
                          <PencilLine size={15} aria-hidden="true" />
                        </button>
                        <button
                          type="button"
                          className="vm-iconbtn vm-iconbtn-danger"
                          aria-label={`Delete ${f.name}`}
                          title="Delete"
                          onClick={() => setDialog({ kind: 'delete-flow', flow: f })}
                        >
                          <Trash2 size={15} aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Messages ────────────────────────────────────── */}
        <PromptManager />
      </div>

      {dialog.kind === 'new-flow' && (
        <NameDialog
          title="New flow"
          sub="You can rename it any time."
          label="Flow name"
          initial={flows.length === 0 ? 'Main menu' : ''}
          placeholder="e.g. Main menu"
          confirmLabel="Create and open"
          pendingLabel="Creating…"
          requireChange={false}
          pending={create.isPending}
          error={errorOf(create, 'The flow couldn’t be created. Try again.')}
          onSubmit={(name) => create.mutate(name)}
          onClose={() => {
            create.reset();
            close();
          }}
        />
      )}
      {dialog.kind === 'rename-flow' && (
        <NameDialog
          title="Rename flow"
          label="Flow name"
          initial={dialog.flow.name}
          confirmLabel="Rename"
          pendingLabel="Saving…"
          pending={renameFlow.isPending}
          error={errorOf(renameFlow, 'The flow couldn’t be renamed. Try again.')}
          onSubmit={(name) => renameFlow.mutate({ flow: flowsById.get(dialog.flow.id) ?? dialog.flow, name })}
          onClose={() => {
            renameFlow.reset();
            close();
          }}
        />
      )}
      {dialog.kind === 'delete-flow' && (
        <ConfirmDialog
          title={`Delete “${dialog.flow.name}”?`}
          body={
            dialog.flow.numbers.length ? (
              <p>
                {fmt(dialog.flow.numbers[0])}
                {dialog.flow.numbers.length > 1 ? ` and ${plural(dialog.flow.numbers.length - 1, 'other number')}` : ''} still
                answer with this flow. Choose another flow for{' '}
                {dialog.flow.numbers.length === 1 ? 'it' : 'them'} first.
              </p>
            ) : (
              <p>The flow, its draft and its published versions are removed. This can’t be undone.</p>
            )
          }
          confirmLabel="Delete flow"
          danger
          pending={removeFlow.isPending}
          error={errorOf(removeFlow, 'The flow couldn’t be deleted. Try again.')}
          onConfirm={() => removeFlow.mutate(dialog.flow)}
          onCancel={() => {
            removeFlow.reset();
            close();
          }}
        />
      )}
      {dialog.kind === 'bind' && (
        <BindFlowDialog
          number={dialog.number}
          flows={flows}
          pending={updateNumber.isPending}
          error={errorOf(updateNumber, 'The number couldn’t be updated. Try again.')}
          onSubmit={(flowId) => updateNumber.mutate({ number: dialog.number, body: { flow_id: flowId } })}
          onClose={() => {
            updateNumber.reset();
            close();
          }}
        />
      )}
      {dialog.kind === 'rename-number' && (
        <NameDialog
          title="Name this number"
          sub={<>A name helps you tell your numbers apart. Callers never hear it.</>}
          label="Name"
          initial={dialog.number.name ?? ''}
          placeholder="e.g. Main line"
          confirmLabel="Save"
          pendingLabel="Saving…"
          allowEmpty
          pending={updateNumber.isPending}
          error={errorOf(updateNumber, 'The number couldn’t be renamed. Try again.')}
          onSubmit={(name) => updateNumber.mutate({ number: dialog.number, body: { name: name || null } })}
          onClose={() => {
            updateNumber.reset();
            close();
          }}
        />
      )}
    </div>
  );
}

function Metric({ value, label }: { value: number; label: string }) {
  return (
    <div className="dl-metric">
      <div className="dl-metric-value">{value.toLocaleString()}</div>
      <div className="dl-metric-label">{label}</div>
    </div>
  );
}

type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

function StatusWord({ tone, children, hint }: { tone: Tone; children: ReactNode; hint?: string }) {
  return (
    <span className={`ivr-status ivr-status-${tone}`} title={hint}>
      <span className="ivr-status-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

function NumberStatus({ number, flow }: { number: IvrNumber; flow: FlowSummary | null }) {
  if (!number.enabled) return <StatusWord tone="danger" hint="Switched off by Granite — calls are turned away.">Switched off</StatusWord>;
  if (number.flow_id === null) return <StatusWord tone="warn" hint="Calls are turned away until a flow is chosen.">No flow — calls turned away</StatusWord>;
  if (!number.published) return <StatusWord tone="warn" hint="Publish the flow so callers hear it.">Not published yet</StatusWord>;
  return <StatusWord tone="ok">Live{flow?.published_version ? ` · version ${flow.published_version}` : ''}</StatusWord>;
}

function FlowStatus({ flow }: { flow: FlowSummary }) {
  if (!flow.published_version) return <StatusWord tone="neutral">Draft, never published</StatusWord>;
  return (
    <span className="ivr-status-stack">
      <StatusWord tone="ok">Published · version {flow.published_version}</StatusWord>
      {hasUnpublishedChanges(flow) && <span className="ivr-cell-sub">Draft has unpublished changes</span>}
    </span>
  );
}
