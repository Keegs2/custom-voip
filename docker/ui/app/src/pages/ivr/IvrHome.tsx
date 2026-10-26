/**
 * IvrHome — /ivr: the customer's IVR numbers (which flow each answers with,
 * whether callers hear it, when it was last published), their flows, and
 * their messages. Three states (plan §6.1):
 *
 *   not entitled            → IvrIntro (what IVR is, how to get it)
 *   entitled, no numbers    → "no IVR number yet" + flows + messages
 *   otherwise               → numbers + flows + messages
 *
 * Layout (docker/ui/CLAUDE.md §20 — balanced, compact, expandable):
 *
 *   ┌ CompactHeader: crumb · IVR   [Customer ▾]  Numbers | Flows | Live  [+ New flow] ┐
 *   ┌ Your IVR numbers ─────────────┐ ┌ Flows ──────────────────────────┐   one row,
 *   │ number · name     [Change] ✎ │ │ Main menu       [Open builder] … │   one height
 *   │ ● Live · answers with …      │ │ ● Published · used by · edited   │
 *   └───────────────────────────────┘ └──────────────────────────────────┘
 *   ┌ Messages (first 4, then "Show all N messages") ──────────────── [+ New message] ┐
 *
 * Each list shows 6 rows, then "Show all N" opens the rest inside a capped
 * scroll (the cards sit side by side, so neither pushes its row taller).
 *
 * Writers (tenant 'user', staff) get New flow, Choose flow, Rename and
 * Delete; a 'readonly' user sees the same page with view-only actions.
 *
 * React #310: every hook is unconditional, above the state branches; the
 * lists' "show all" hooks live in their own card components.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, PencilLine, Plus, Trash2, Workflow } from 'lucide-react';
import { createFlow, deleteFlow, updateFlow, updateIvrNumber } from '../../api/ivr';
import { useToast } from '../../components/ui/ToastContext';
import { Spinner } from '../../components/ui/Spinner';
import { BalancedGrid, CompactHeader, ShowMoreButton, useShowMore, type HeaderStat } from '../../components/layout/kit';
import type { FlowSummary, IvrNumber } from '../../types/ivr';
import { fmt } from '../../utils/format';
import { ConfirmDialog } from '../voicemail/VmDialog';
import { useIvrWorkspace } from './IvrContext';
import { BindFlowDialog, NameDialog } from './IvrDialogs';
import { IvrIntro } from './IvrIntro';
import { PromptManager } from './prompts/PromptManager';
import { formatWhen, hasUnpublishedChanges, plural } from './format';
import { invalidateIvr, isIvrError, ivrErrorText, useIvrSummary } from './ivrData';

/** Rows a card shows before "Show all N" (§20.3: short lists 4–6). */
const LIST_LIMIT = 6;

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
  const entitled = summary.data?.enabled === true;

  const stats: HeaderStat[] | undefined = entitled && summary.data
    ? [
        { label: 'IVR numbers', value: summary.data.numbers.length },
        { label: 'Flows', value: summary.data.flows.length },
        {
          label: 'Live',
          value: summary.data.numbers.filter((n) => n.enabled && n.published).length,
          title: 'Numbers whose callers hear a published flow',
        },
      ]
    : undefined;

  const header = (
    <CompactHeader
      className="ivr-header fx-load"
      crumb={
        <>
          <span className="vm-crumb-tail">{ws.customerName}</span>
          <span className="dl-crumb-sep" aria-hidden="true">/</span>
          <span>IVR</span>
          {ws.staff && <span className="vm-staff-tag">{ws.viewer === 'admin' ? 'Staff' : 'Staff preview'}</span>}
        </>
      }
      title="IVR"
      subtitle="Design what callers hear when they dial your IVR numbers — menus, business hours and transfers."
      tools={staffPicker}
      stats={stats}
      statsLabel="IVR totals"
      actions={
        entitled && ws.canEdit ? (
          <button type="button" className="dl-btn dl-btn-primary vm-btn-sm" onClick={() => setDialog({ kind: 'new-flow' })}>
            <Plus size={14} aria-hidden="true" /> New flow
          </button>
        ) : undefined
      }
    />
  );

  if (summary.isLoading) {
    return (
      <div className="dl-shell ivr-shell">
        {header}
        <div className="ivr-state" role="status">
          <Spinner /> Loading your IVR…
        </div>
      </div>
    );
  }
  if (notEntitled) {
    return (
      <div className="dl-shell ivr-shell">
        {header}
        <div className="ivr-intro-host fx-load fx-load-d1">
          <IvrIntro staff={ws.staff} />
        </div>
      </div>
    );
  }
  if (summary.isError || !summary.data) {
    return (
      <div className="dl-shell ivr-shell">
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
    <div className="dl-shell ivr-shell">
      {header}

      <div className="ivr-sections fx-load fx-load-d1">
        <BalancedGrid columns="minmax(0, 1fr) minmax(0, 1fr)" stackBelow="lg" className="ivr-row1">
          <NumbersCard
            numbers={numbers}
            flowsById={flowsById}
            onBind={(number) => setDialog({ kind: 'bind', number })}
            onRename={(number) => setDialog({ kind: 'rename-number', number })}
          />
          <FlowsCard
            flows={flows}
            onRename={(flow) => setDialog({ kind: 'rename-flow', flow })}
            onDelete={(flow) => setDialog({ kind: 'delete-flow', flow })}
          />
        </BalancedGrid>

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

/* ─── Numbers ─────────────────────────────────────────────── */

function NumbersCard({
  numbers,
  flowsById,
  onBind,
  onRename,
}: {
  numbers: readonly IvrNumber[];
  flowsById: ReadonlyMap<number, FlowSummary>;
  onBind: (n: IvrNumber) => void;
  onRename: (n: IvrNumber) => void;
}) {
  // ── Hooks first (React #310) ──
  const ws = useIvrWorkspace();
  const more = useShowMore(numbers, LIST_LIMIT);

  return (
    <section className="dl-panel ivr-panel ivr-card" aria-labelledby="ivr-numbers-title">
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
        <div className={more.expanded ? 'ivr-list-wrap lk-cap' : 'ivr-list-wrap'}>
          <ul className="ivr-items" id={more.listId}>
            {more.visible.map((n) => {
              const flow = n.flow_id !== null ? flowsById.get(n.flow_id) ?? null : null;
              return (
                <li key={n.id} className="ivr-item">
                  <span className="ivr-item-id">
                    <span className="ivr-number">{fmt(n.did)}</span>
                    <span className="ivr-item-name">{n.name ?? 'No name'}</span>
                  </span>
                  <span className="ivr-item-actions">
                    {ws.canEdit && (
                      <>
                        <button type="button" className="dl-btn dl-btn-ghost ivr-btn-sm" onClick={() => onBind(n)}>
                          {n.flow_id === null ? 'Choose a flow' : 'Change flow'}
                        </button>
                        <button
                          type="button"
                          className="vm-iconbtn"
                          aria-label={`Rename ${fmt(n.did)}`}
                          title="Rename"
                          onClick={() => onRename(n)}
                        >
                          <PencilLine size={15} aria-hidden="true" />
                        </button>
                      </>
                    )}
                  </span>
                  <span className="ivr-item-meta">
                    <NumberStatus number={n} flow={flow} />
                    <span className="ivr-item-fact">
                      Answers with{' '}
                      {flow ? (
                        <Link className="ivr-link" to={ws.href(`/ivr/flows/${flow.id}`)}>
                          {flow.name}
                        </Link>
                      ) : (
                        <span className="ivr-muted">{n.flow_name ?? 'no flow'}</span>
                      )}
                    </span>
                    {flow?.published_at && (
                      <span className="ivr-item-fact ivr-item-when">Published {formatWhen(flow.published_at)}</span>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      {more.needed && <ShowMoreButton {...more.buttonProps} noun="numbers" variant="bar" />}
      <p className="ivr-card-foot">
        {ws.staff
          ? 'IVR numbers are assigned in TED (Customer 360 → Products).'
          : 'Your Granite account team assigns IVR numbers.'}
      </p>
    </section>
  );
}

/* ─── Flows ───────────────────────────────────────────────── */

function FlowsCard({
  flows,
  onRename,
  onDelete,
}: {
  flows: readonly FlowSummary[];
  onRename: (f: FlowSummary) => void;
  onDelete: (f: FlowSummary) => void;
}) {
  // ── Hooks first (React #310) ──
  const ws = useIvrWorkspace();
  const more = useShowMore(flows, LIST_LIMIT);

  return (
    <section className="dl-panel ivr-panel ivr-card" aria-labelledby="ivr-flows-title">
      <div className="ivr-panel-head">
        <div>
          <h2 id="ivr-flows-title" className="ivr-panel-title">
            Flows
          </h2>
          <p className="ivr-panel-sub">A flow is the menu and routing you design. Edits stay a draft until you publish.</p>
        </div>
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
        <div className={more.expanded ? 'ivr-list-wrap lk-cap' : 'ivr-list-wrap'}>
          <ul className="ivr-items" id={more.listId}>
            {more.visible.map((f) => (
              <li key={f.id} className="ivr-item">
                <span className="ivr-item-id">
                  <Link className="ivr-flow-name" to={ws.href(`/ivr/flows/${f.id}`)}>
                    {f.name}
                  </Link>
                  <span className="ivr-item-name ivr-item-when">Edited {formatWhen(f.updated_at)}</span>
                </span>
                <span className="ivr-item-actions">
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
                        onClick={() => onRename(f)}
                      >
                        <PencilLine size={15} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className="vm-iconbtn vm-iconbtn-danger"
                        aria-label={`Delete ${f.name}`}
                        title="Delete"
                        onClick={() => onDelete(f)}
                      >
                        <Trash2 size={15} aria-hidden="true" />
                      </button>
                    </>
                  )}
                </span>
                <span className="ivr-item-meta">
                  <FlowStatus flow={f} />
                  <span className="ivr-item-fact">
                    {f.numbers.length ? (
                      <>
                        Used by <span className="ivr-numlist">{f.numbers.map(fmt).join(', ')}</span>
                      </>
                    ) : (
                      <span className="ivr-muted">No number</span>
                    )}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {more.needed && <ShowMoreButton {...more.buttonProps} noun="flows" variant="bar" />}
    </section>
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
    <>
      <StatusWord tone="ok">Published · version {flow.published_version}</StatusWord>
      {hasUnpublishedChanges(flow) && <span className="ivr-item-fact ivr-item-pending">Draft has unpublished changes</span>}
    </>
  );
}
