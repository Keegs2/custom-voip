/**
 * PublishPanel — review, then publish (contract §8.2):
 *
 *   1. save the draft (autosave flush) so the server holds exactly this;
 *   2. ask the server to check it (`/validate`); its errors are pinned to
 *      blocks (click one to jump there) and BLOCK publishing;
 *   3. show what callers will hear (the transcript of the compiled plan),
 *      what changed since the live version, and who hears it;
 *   4. Publish sends `{ revision }` only — the server compiles the stored
 *      draft. 422 → its errors are shown; 409 → the conflict dialog.
 */
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, CircleCheck, Rocket, TriangleAlert } from 'lucide-react';
import { publishFlow, validateFlow } from '../../api/ivr';
import type { IvrGraph, Issue, ValidateResult } from '../../types/ivr';
import { useToast } from '../../components/ui/ToastContext';
import { fmt } from '../../utils/format';
import { invalidateIvr, isIvrError, ivrErrorText, readIvrError, useFlowVersion } from '../../pages/ivr/ivrData';
import { useIvrWorkspace } from '../../pages/ivr/IvrContext';
import { describePlan } from '../compile/ivr';
import { useFlow, useFlowStoreApi } from '../store/flowStore';
import { useAnalysis } from '../useFlowAnalysis';
import { useBuilderData } from '../BuilderData';
import { BlockIcon } from '../canvas/BlockIcon';
import { SideSheet } from './SideSheet';

type Phase =
  | { kind: 'saving' }
  | { kind: 'save-failed' }
  | { kind: 'checking' }
  | { kind: 'checked'; result: ValidateResult | null };

export interface PublishPanelProps {
  flush: () => Promise<boolean>;
  onClose: () => void;
  onConflict: () => void;
}

interface Diff {
  added: number;
  removed: number;
  changed: number;
}

function diffGraphs(before: IvrGraph, after: IvrGraph): Diff {
  const old = new Map(before.nodes.map((n) => [n.id, n]));
  const now = new Map(after.nodes.map((n) => [n.id, n]));
  const outOf = (g: IvrGraph, id: string) =>
    JSON.stringify(g.edges.filter((e) => e.source === id).map((e) => [e.sourceHandle, e.target]).sort());
  let changed = 0;
  for (const [id, n] of now) {
    const o = old.get(id);
    if (o && (JSON.stringify(o.data) !== JSON.stringify(n.data) || outOf(before, id) !== outOf(after, id))) changed += 1;
  }
  return {
    added: [...now.keys()].filter((id) => !old.has(id)).length,
    removed: [...old.keys()].filter((id) => !now.has(id)).length,
    changed,
  };
}

export function PublishPanel({ flush, onClose, onConflict }: PublishPanelProps) {
  // ── ALL hooks unconditionally at the top (React #310) ──
  const ws = useIvrWorkspace();
  const store = useFlowStoreApi();
  const queryClient = useQueryClient();
  const { toastOk } = useToast();
  const analysis = useAnalysis();
  const data = useBuilderData();
  const meta = useFlow((s) => s.meta);
  const name = useFlow((s) => s.name);
  const contentSeq = useFlow((s) => s.contentSeq);
  const [phase, setPhase] = useState<Phase>({ kind: 'saving' });
  const [publishErrors, setPublishErrors] = useState<Issue[] | null>(null);
  const live = useFlowVersion(ws.scope, meta.id, meta.publishedVersion);

  // Save, then check — once per open (and again if the draft changes while open).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const saved = await flush();
      if (!alive) return;
      if (!saved) {
        setPhase({ kind: 'save-failed' });
        return;
      }
      setPhase({ kind: 'checking' });
      try {
        const result = await validateFlow(meta.id, store.getState().graph(), ws.scope.customerId);
        if (alive) setPhase({ kind: 'checked', result });
      } catch {
        if (alive) setPhase({ kind: 'checked', result: null });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentSeq]);

  const publish = useMutation({
    mutationFn: () => publishFlow(meta.id, store.getState().revision, ws.scope.customerId),
    onSuccess: (r) => {
      store.getState().setMeta({ publishedVersion: r.version, publishedAt: r.published_at });
      void invalidateIvr(queryClient, ws.scope);
      toastOk(
        meta.numbers.length
          ? `Published version ${r.version}. Callers hear it now.`
          : `Published version ${r.version}. Choose this flow for a number to put it live.`,
      );
      onClose();
    },
    onError: (err) => {
      if (isIvrError(err, 409, 'stale_revision')) onConflict();
      else if (isIvrError(err, 422, 'invalid_flow')) setPublishErrors(readIvrError(err).errors);
    },
  });

  const graph = useFlow((s) => s.contentGraph());
  const transcript = useMemo(
    () => describePlan(graph, analysis.compiled.plan, { promptName: analysis.summary.promptName, destinations: data.destinations ?? null }),
    [graph, analysis.compiled.plan, analysis.summary.promptName, data.destinations],
  );
  const diff = useMemo(() => (live.data ? diffGraphs(live.data.graph, graph) : null), [live.data, graph]);

  // ── Derived (after all hooks) ──
  const result = phase.kind === 'checked' ? phase.result : null;
  const serverErrors = publishErrors ?? result?.errors ?? [];
  const serverWarnings = result?.warnings ?? [];
  const serverDown = phase.kind === 'checked' && result === null;
  const clientErrors = analysis.compiled.issues.filter((i) => i.severity === 'error');
  const errors: { message: string; nodeId?: string | null }[] = serverDown
    ? clientErrors.map((i) => ({ message: i.message, nodeId: i.nodeId }))
    : serverErrors.map((i) => ({ message: i.message, nodeId: i.node_id }));
  const nextVersion = (meta.publishedVersion ?? 0) + 1;
  const canPublish = phase.kind === 'checked' && errors.length === 0 && !publish.isPending;
  const jump = (id: string | null | undefined) => {
    if (!id) return;
    store.getState().focusBlock(id);
    onClose();
  };

  return (
    <SideSheet
      title={`Publish “${name}”`}
      sub={
        meta.publishedVersion
          ? `Callers hear version ${meta.publishedVersion} now. This becomes version ${nextVersion}.`
          : 'Nothing is published yet. This becomes version 1.'
      }
      icon={<Rocket size={16} aria-hidden="true" />}
      onClose={onClose}
      busy={publish.isPending}
      footer={
        <>
          <button type="button" className="dl-btn dl-btn-ghost" onClick={onClose} disabled={publish.isPending}>
            Keep editing
          </button>
          <button
            type="button"
            className="dl-btn dl-btn-primary"
            disabled={!canPublish}
            onClick={() => {
              setPublishErrors(null);
              publish.mutate();
            }}
            data-autofocus={canPublish ? true : undefined}
          >
            {publish.isPending && <span className="vm-spin vm-spin-light" aria-hidden="true" />}
            {publish.isPending ? 'Publishing…' : `Publish version ${nextVersion}`}
          </button>
        </>
      }
    >
      {/* Check */}
      <section className="ivr-pub-block" aria-live="polite">
        {phase.kind === 'saving' || phase.kind === 'checking' ? (
          <div className="ivr-verdict ivr-verdict-checking">
            <span className="vm-spin" aria-hidden="true" />
            <div>
              <p className="ivr-verdict-title">{phase.kind === 'saving' ? 'Saving your draft…' : 'Checking the flow…'}</p>
              <p className="ivr-verdict-sub">Granite checks every block, number and message before anything goes live.</p>
            </div>
          </div>
        ) : phase.kind === 'save-failed' ? (
          <div className="ivr-verdict ivr-verdict-error">
            <CircleAlert size={18} aria-hidden="true" />
            <div>
              <p className="ivr-verdict-title">Your latest changes aren’t saved</p>
              <p className="ivr-verdict-sub">Publishing uses the saved draft. Wait for it to save (see the top bar), then try again.</p>
            </div>
          </div>
        ) : errors.length > 0 ? (
          <div className="ivr-verdict ivr-verdict-error">
            <CircleAlert size={18} aria-hidden="true" />
            <div>
              <p className="ivr-verdict-title">
                Fix {errors.length === 1 ? 'this' : `these ${errors.length} things`} before publishing
              </p>
              <p className="ivr-verdict-sub">Select one to jump to its block.</p>
            </div>
          </div>
        ) : (
          <div className="ivr-verdict ivr-verdict-ok">
            <CircleCheck size={18} aria-hidden="true" />
            <div>
              <p className="ivr-verdict-title">Ready to publish</p>
              <p className="ivr-verdict-sub">
                {serverDown ? 'Checked in your browser — Granite checks again as it publishes.' : 'Checked by Granite.'}
              </p>
            </div>
          </div>
        )}
        {errors.length > 0 && (
          <ul className="ivr-issues">
            {errors.map((e, i) => (
              <li key={i} className="ivr-issue ivr-issue-error">
                <button type="button" className="ivr-issue-btn" onClick={() => jump(e.nodeId)} disabled={!e.nodeId}>
                  <CircleAlert size={14} className="ivr-issue-ic" aria-hidden="true" />
                  <span>
                    {e.nodeId && <strong className="ivr-issue-where">{analysis.titleOf(e.nodeId)}: </strong>}
                    {e.message}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {serverWarnings.length > 0 && errors.length === 0 && (
          <ul className="ivr-issues">
            {serverWarnings.map((w, i) => (
              <li key={i} className="ivr-issue ivr-issue-warning">
                <button type="button" className="ivr-issue-btn" onClick={() => jump(w.node_id)} disabled={!w.node_id}>
                  <TriangleAlert size={14} className="ivr-issue-ic" aria-hidden="true" />
                  <span>
                    {w.node_id && <strong className="ivr-issue-where">{analysis.titleOf(w.node_id)}: </strong>}
                    {w.message}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {publish.isError && !isIvrError(publish.error, 422, 'invalid_flow') && !isIvrError(publish.error, 409, 'stale_revision') && (
          <div className="dl-banner dl-banner-err vm-gap-top" role="alert">
            {ivrErrorText(publish.error, 'The flow couldn’t be published. Try again.')}
          </div>
        )}
      </section>

      {/* Who hears it */}
      <section className="ivr-pub-block">
        <h3 className="ivr-insp-h">Who hears it</h3>
        {meta.numbers.length ? (
          <p className="ivr-insp-copy">
            Callers to <strong>{meta.numbers.map(fmt).join(', ')}</strong> hear the new version as soon as you publish.
            Calls already in progress finish on the old one.
          </p>
        ) : (
          <p className="ivr-insp-copy">No number answers with this flow yet. Publish now and choose it for a number on the IVR page.</p>
        )}
        {diff && (
          <p className="ivr-pub-diff">
            Since version {meta.publishedVersion}:{' '}
            {diff.added + diff.removed + diff.changed === 0
              ? 'no changes to call logic (layout only).'
              : [
                  diff.added && `${diff.added} block${diff.added === 1 ? '' : 's'} added`,
                  diff.changed && `${diff.changed} changed`,
                  diff.removed && `${diff.removed} removed`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </p>
        )}
      </section>

      {/* What callers hear */}
      <section className="ivr-pub-block">
        <h3 className="ivr-insp-h">What callers hear</h3>
        {transcript.length === 0 ? (
          <p className="ivr-insp-copy">Nothing yet — connect Start to a block.</p>
        ) : (
          <ol className="ivr-transcript">
            {transcript.map((t, i) => (
              <li key={t.nodeId} className="ivr-tx-step" style={{ '--ivr-hue': `var(--ivr-${t.type})` } as CSSProperties}>
                <span className="ivr-tx-n" aria-hidden="true">
                  {i + 1}
                </span>
                <div className="ivr-tx-main">
                  <button type="button" className="ivr-tx-title" onClick={() => jump(t.nodeId)}>
                    <BlockIcon type={t.type} size={13} /> {t.title}
                  </button>
                  <p className="ivr-tx-says">{t.says}</p>
                  {t.branches.length > 0 && (
                    <ul className="ivr-tx-branches">
                      {t.branches.map((b) => (
                        <li key={b.label}>
                          <span className="ivr-tx-branch">{b.label}</span> →{' '}
                          {b.toId === null ? (
                            <span className="ivr-muted">the call ends</span>
                          ) : (
                            <>
                              {b.toTitle}
                              {b.earlier && <span className="ivr-muted"> (again)</span>}
                            </>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </SideSheet>
  );
}
