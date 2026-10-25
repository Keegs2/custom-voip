/**
 * useAutosave — keeps the server draft in step with the builder, under the
 * contract's optimistic lock (§8.2: `PUT /ivr/flows/{id}` carries
 * `revision`; a stale one answers 409 `stale_revision` + `current_revision`).
 *
 *   edit ─(1.2 s quiet)─► PUT {draft_graph, name?, revision}
 *     200  → revision := response.revision; saved up to the edit's seq
 *     409  → CONFLICT: autosave stops; the customer chooses (see ConflictDialog):
 *            load the latest (drop mine) or keep mine (PUT at current_revision)
 *     else → retry 2 s / 5 s / 15 s / 30 s…, "Save now" retries at once
 *
 * The unsaved-changes guard: `beforeunload` asks before a reload / tab
 * close while anything is unsaved, saving or in conflict; leaving the
 * builder inside the app saves first (`flush`), and an edit still pending
 * at unmount is sent anyway.
 *
 * React #310: all hooks unconditional.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getFlow, updateFlow } from '../api/ivr';
import type { Flow } from '../types/ivr';
import { isIvrError, ivrErrorText, ivrKeys, readIvrError, type IvrScope } from '../pages/ivr/ivrData';
import type { FlowStore } from './store/flowStore';

export type SaveStatus =
  | { kind: 'saved'; at: number | null }
  | { kind: 'pending' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string; retryInMs: number | null }
  | { kind: 'conflict'; currentRevision: number | null }
  | { kind: 'readonly' };

export interface Autosave {
  status: SaveStatus;
  /** Saves now if anything is unsaved. Resolves true when the server holds the current draft. */
  flush: () => Promise<boolean>;
  /** Conflict: overwrite the other change with this draft. */
  keepMine: () => Promise<boolean>;
  /** Conflict: drop local edits and load the server's draft. */
  loadLatest: () => Promise<boolean>;
}

const QUIET_MS = 1200;
const RETRY_MS = [2000, 5000, 15000, 30000];

export function useAutosave(store: FlowStore, scope: IvrScope, readOnly: boolean): Autosave {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<SaveStatus>(readOnly ? { kind: 'readonly' } : { kind: 'saved', at: null });
  const statusRef = useRef(status);
  const inFlight = useRef<Promise<boolean> | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempt = useRef(0);
  const savedName = useRef(store.getState().name);

  const update = useCallback((next: SaveStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const clearTimer = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  /** One PUT of the current draft at `revision` (default: the store's). */
  const save = useCallback(
    (revisionOverride?: number): Promise<boolean> => {
      if (readOnly) return Promise.resolve(true);
      if (inFlight.current) return inFlight.current;
      const s = store.getState();
      const seq = s.changeSeq;
      const name = s.name.trim() || 'Untitled flow';
      const body = {
        draft_graph: s.graph(),
        revision: revisionOverride ?? s.revision,
        ...(name !== savedName.current ? { name } : {}),
      };
      update({ kind: 'saving' });
      const run = (async () => {
        try {
          const flow = await updateFlow(s.meta.id, body, scope.customerId);
          savedName.current = flow.name;
          store.getState().markSaved(seq, flow.revision);
          store.getState().setMeta({
            publishedVersion: flow.published_version,
            publishedAt: flow.published_at,
            numbers: flow.numbers,
          });
          queryClient.setQueryData<Flow>(ivrKeys.flow(scope, flow.id), flow);
          attempt.current = 0;
          const dirty = store.getState().changeSeq > store.getState().savedSeq;
          update(dirty ? { kind: 'pending' } : { kind: 'saved', at: Date.now() });
          return !dirty;
        } catch (err) {
          if (isIvrError(err, 409, 'stale_revision')) {
            update({ kind: 'conflict', currentRevision: readIvrError(err).currentRevision });
            return false;
          }
          const wait = RETRY_MS[Math.min(attempt.current, RETRY_MS.length - 1)];
          attempt.current += 1;
          update({ kind: 'error', message: ivrErrorText(err, 'Couldn’t save your changes.'), retryInMs: wait });
          clearTimer();
          timer.current = setTimeout(() => void saveRef.current(), wait);
          return false;
        } finally {
          inFlight.current = null;
        }
      })();
      inFlight.current = run;
      return run;
    },
    [readOnly, store, scope, queryClient, update],
  );
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  }, [save]);

  // Watch for edits: debounce, then save. Conflicts stop the loop until resolved.
  useEffect(() => {
    if (readOnly) return undefined;
    return store.subscribe((s, prev) => {
      if (s.changeSeq === prev.changeSeq && s.savedSeq === prev.savedSeq) return;
      const dirty = s.changeSeq > s.savedSeq;
      const current = statusRef.current.kind;
      if (!dirty || current === 'conflict') return;
      if (current !== 'saving' && current !== 'error') update({ kind: 'pending' });
      if (current === 'error') return; // the retry timer is already running
      clearTimer();
      timer.current = setTimeout(() => {
        // Still saving the previous edit: try again once it lands.
        if (inFlight.current) void inFlight.current.then(() => void saveRef.current());
        else void saveRef.current();
      }, QUIET_MS);
    });
  }, [store, readOnly, update]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (readOnly) return true;
    if (statusRef.current.kind === 'conflict') return false;
    clearTimer();
    if (inFlight.current) await inFlight.current;
    const s = store.getState();
    if (s.changeSeq <= s.savedSeq) return true;
    return save();
  }, [readOnly, store, save]);

  const keepMine = useCallback(async (): Promise<boolean> => {
    let rev = statusRef.current.kind === 'conflict' ? statusRef.current.currentRevision : null;
    if (rev === null) {
      try {
        rev = (await getFlow(store.getState().meta.id, scope.customerId)).revision;
      } catch (err) {
        update({ kind: 'error', message: ivrErrorText(err, 'Couldn’t reach the server.'), retryInMs: null });
        return false;
      }
    }
    store.getState().setRevision(rev);
    return save(rev);
  }, [store, scope, save, update]);

  const loadLatest = useCallback(async (): Promise<boolean> => {
    try {
      const flow = await getFlow(store.getState().meta.id, scope.customerId);
      clearTimer();
      savedName.current = flow.name;
      store.getState().load(flow);
      queryClient.setQueryData<Flow>(ivrKeys.flow(scope, flow.id), flow);
      update({ kind: 'saved', at: Date.now() });
      return true;
    } catch (err) {
      update({ kind: 'error', message: ivrErrorText(err, 'Couldn’t load the latest version.'), retryInMs: null });
      return false;
    }
  }, [store, scope, queryClient, update]);

  // beforeunload: reload / close / external navigation while anything is unsaved.
  useEffect(() => {
    if (readOnly) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = store.getState();
      const kind = statusRef.current.kind;
      if (s.changeSeq > s.savedSeq || kind === 'saving' || kind === 'conflict') {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [store, readOnly]);

  // Leaving the builder inside the app (sidebar link, Back): send what's pending.
  useEffect(
    () => () => {
      clearTimer();
      if (readOnly) return;
      const s = store.getState();
      if (s.changeSeq > s.savedSeq && statusRef.current.kind !== 'conflict' && !inFlight.current) void saveRef.current();
    },
    [store, readOnly],
  );

  return { status, flush, keepMine, loadLatest };
}
