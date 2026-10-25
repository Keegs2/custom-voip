/**
 * useFlowAnalysis — everything the builder derives from the draft:
 *
 *  - the CLIENT compile mirror (compile/ivr.ts): instant, re-run when the
 *    store's `contentSeq` moves (never on a pure move — positions don't
 *    change call logic);
 *  - the SERVER check (`POST /ivr/flows/{id}/validate` with the current
 *    draft), debounced; its findings are authoritative and pinned to the
 *    same blocks and exits. Shown = server findings ∪ client findings at
 *    places the server said nothing about. Publishing is gated by the
 *    server alone (PublishPanel).
 *
 * Plus the shared wording context for block summaries and titles.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { validateFlow } from '../api/ivr';
import type { Destinations, IvrConfigMap, Issue, Prompt } from '../types/ivr';
import { compileIvr, type ClientIssue, type CompileResult } from './compile/ivr';
import { blockTitle, type SummaryContext } from './model/summary';
import { useFlow, type FlowNode } from './store/flowStore';
import type { IvrScope } from '../pages/ivr/ivrData';

export type ShownIssue = ClientIssue & { source: 'client' | 'server' };

export interface FlowAnalysis {
  compiled: CompileResult;
  issues: ShownIssue[];
  issuesByNode: ReadonlyMap<string, ShownIssue[]>;
  errorCount: number;
  warningCount: number;
  /** Server check state for the CURRENT content. */
  server: 'off' | 'checking' | 'current' | 'unavailable';
  summary: SummaryContext;
  /** "source\0handle" → target block id. */
  targets: ReadonlyMap<string, string>;
  titleOf: (id: string) => string;
}

const SERVER_DEBOUNCE_MS = 2500;

function locationKey(i: { nodeId?: string; handle?: string }): string {
  return `${i.nodeId ?? ''}\u0000${i.handle ?? ''}`;
}

function fromServer(list: readonly Issue[], severity: 'error' | 'warning'): ShownIssue[] {
  return list.map((i) => ({
    severity,
    code: i.code,
    message: i.message,
    ...(i.node_id ? { nodeId: i.node_id } : {}),
    ...(i.handle ? { handle: i.handle } : {}),
    source: 'server' as const,
  }));
}

export interface AnalysisInput {
  flowId: number;
  scope: IvrScope;
  ownDids: readonly string[];
  prompts: readonly Prompt[] | undefined;
  destinations: Destinations | undefined;
  maxBlocks?: number;
  /** Ask the server too (writers only — validate is a POST). */
  serverCheck: boolean;
}

export function useFlowAnalysis(input: AnalysisInput): FlowAnalysis {
  const { flowId, scope, ownDids, prompts, destinations, maxBlocks, serverCheck } = input;
  const contentSeq = useFlow((s) => s.contentSeq);
  const edges = useFlow((s) => s.edges);
  const [server, setServer] = useState<{ seq: number; errors: Issue[]; warnings: Issue[] } | null>(null);
  const [serverFailed, setServerFailed] = useState<number | null>(null);
  const latest = useRef(contentSeq);

  // The draft's §2 JSON, rebuilt only when call logic may have changed.
  const graph = useFlow((s) => s.contentGraph());

  const promptMap = useMemo(
    () => (prompts ? new Map(prompts.map((p) => [p.id, { id: p.id, name: p.name }])) : null),
    [prompts],
  );

  const compiled = useMemo(
    () => compileIvr(graph, { prompts: promptMap, destinations: destinations ?? null, ownDids, maxBlocks }),
    [graph, promptMap, destinations, ownDids, maxBlocks],
  );

  // Server check, debounced; an answer for older content is ignored.
  useEffect(() => {
    latest.current = contentSeq;
    if (!serverCheck) return undefined;
    const seq = contentSeq;
    const t = setTimeout(() => {
      validateFlow(flowId, graph, scope.customerId).then(
        (r) => {
          if (latest.current !== seq) return;
          setServer({ seq, errors: r.errors ?? [], warnings: r.warnings ?? [] });
          setServerFailed(null);
        },
        () => {
          if (latest.current === seq) setServerFailed(seq);
        },
      );
    }, SERVER_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [contentSeq, graph, serverCheck, flowId, scope.customerId]);

  return useMemo(() => {
    // From the content-keyed graph, not the live nodes: a drag must not re-render every block.
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const serverCurrent = server !== null && server.seq === contentSeq;
    const serverIssues = serverCurrent
      ? [...fromServer(server.errors, 'error'), ...fromServer(server.warnings, 'warning')]
      : [];
    const taken = new Set(serverIssues.map(locationKey));
    const issues: ShownIssue[] = [
      ...serverIssues,
      ...compiled.issues.filter((i) => !taken.has(locationKey(i))).map((i) => ({ ...i, source: 'client' as const })),
    ];
    const issuesByNode = new Map<string, ShownIssue[]>();
    for (const i of issues) {
      if (!i.nodeId) continue;
      issuesByNode.set(i.nodeId, [...(issuesByNode.get(i.nodeId) ?? []), i]);
    }
    const targets = new Map(edges.map((e) => [`${e.source}\u0000${e.sourceHandle ?? 'next'}`, e.target]));
    const titleOf = (id: string) => {
      const n = byId.get(id);
      return n ? blockTitle(n) : 'a deleted block';
    };
    return {
      compiled,
      issues,
      issuesByNode,
      errorCount: issues.filter((i) => i.severity === 'error').length,
      warningCount: issues.filter((i) => i.severity === 'warning').length,
      server: !serverCheck ? 'off' : serverCurrent ? 'current' : serverFailed === contentSeq ? 'unavailable' : 'checking',
      summary: {
        promptName: (id: number) => promptMap?.get(id)?.name ?? null,
        destinations: destinations ?? null,
        titleOf: (id: string) => (byId.has(id) ? titleOf(id) : null),
      },
      targets,
      titleOf,
    };
  }, [compiled, server, serverFailed, contentSeq, graph, edges, promptMap, destinations, serverCheck]);
}

/* ─── Context for canvas nodes and panels ─────────────────── */

export const FlowAnalysisContext = createContext<FlowAnalysis | null>(null);

export function useAnalysis(): FlowAnalysis {
  const a = useContext(FlowAnalysisContext);
  if (!a) throw new Error('useAnalysis outside FlowAnalysisContext');
  return a;
}

/** Go to blocks' targets, drawn as dashed jump lines (never stored as edges). */
export function gotoJumps(nodes: readonly FlowNode[]): { id: string; source: string; target: string }[] {
  const ids = new Set(nodes.map((n) => n.id));
  return nodes
    .filter((n) => n.type === 'goto')
    .map((n) => ({ n, t: (n.data.config as IvrConfigMap['goto']).targetNodeId }))
    .filter(({ n, t }) => t !== '' && t !== n.id && ids.has(t))
    .map(({ n, t }) => ({ id: `jump:${n.id}`, source: n.id, target: t }));
}
