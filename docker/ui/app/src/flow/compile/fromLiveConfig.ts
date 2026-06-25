/**
 * Live-config hydrators — the REVERSE of the per-product `compile()`s, but
 * sourced from the product's *current live row* (not a saved `call_flows` doc).
 *
 * When an operator picks a line in the guided setup and there is no saved flow
 * yet, we still don't want to drop them on a blank canvas: the line already has a
 * live routing config (an `rcf_numbers` row, an `extensions.ring_plan`, a
 * `trunk_dids.route_plan`). These functions rebuild that flat config back into an
 * editable `CallFlowDoc` graph so the canvas opens pre-populated with what is
 * currently in production — the operator reviews, tweaks, and re-publishes.
 *
 * Each hydrator is pure + fully typed: no React, no store, no network. It returns
 * an unsaved draft (`id: null`, `status: 'draft'`) so saving creates a fresh
 * `call_flows` row rather than mutating the live product row. Auto-layout reuses
 * the shared top-down dagre helper (`./layout`).
 *
 * Only RCF is implemented now. `fromLiveUcaas` / `fromLiveTrunk` slot in here
 * later using the same `newDraft` / node-builder scaffolding.
 */
import type { CallFlowDoc, FlowEdge, FlowNode, NodeConfig, NodeType } from '../model/types';
import { defaultLabel, newId } from '../model/defaults';
import { IN_HANDLE, NEXT_HANDLE } from '../canvas/handles';
import { layoutTopDown } from './layout';
import type { RcfEntry } from '../../types/rcf';

/* ─── Graph-builder scaffolding (shared by every live hydrator) ──────────── */

/** A tiny mutable graph builder: append nodes, wire sequential `next` edges. */
interface GraphBuilder {
  nodes: FlowNode[];
  edges: FlowEdge[];
  /** Append a node (placeholder position — dagre lays it out later). */
  add: (type: NodeType, config: NodeConfig) => FlowNode;
  /** Wire a sequential `next` → `in` edge between two node ids. */
  wire: (sourceId: string, targetId: string) => void;
}

function newBuilder(): GraphBuilder {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  return {
    nodes,
    edges,
    add(type, config) {
      const node: FlowNode = {
        id: newId(),
        type,
        position: { x: 0, y: 0 },
        data: { label: defaultLabel(type), config },
      };
      nodes.push(node);
      return node;
    },
    wire(sourceId, targetId) {
      edges.push({ id: newId(), source: sourceId, sourceHandle: NEXT_HANDLE, target: targetId, targetHandle: IN_HANDLE });
    },
  };
}

/** Identity stamped on a hydrated draft. */
interface DraftMeta {
  product: CallFlowDoc['product'];
  name: string;
  customerId: number | null;
  entry: CallFlowDoc['entry'];
}

/** Assemble a built graph + identity into a laid-out, unsaved draft document. */
function newDraft(b: GraphBuilder, meta: DraftMeta): CallFlowDoc {
  layoutTopDown(b.nodes, b.edges);
  return {
    schemaVersion: 1,
    id: null,
    product: meta.product,
    name: meta.name,
    customerId: meta.customerId,
    entry: meta.entry,
    nodes: b.nodes,
    edges: b.edges,
    viewport: { x: 0, y: 0, zoom: 1 },
    status: 'draft',
    version: 1,
  };
}

/* ─── RCF ────────────────────────────────────────────────────────────────── */

/**
 * Rebuild a live `rcf_numbers` row into a flat `entry → dial → hangup` graph —
 * the inverse of the simple-mode RCF compiler. Returns `null` when the line has
 * no `forward_to` yet (nothing to hydrate → the caller starts fresh).
 */
export function fromLiveRcf(rcf: RcfEntry): CallFlowDoc | null {
  if (!rcf.forward_to || rcf.forward_to.trim() === '') return null;

  const b = newBuilder();
  const entry = b.add('entry', { type: 'entry' });
  const dial = b.add('dial', {
    type: 'dial',
    number: rcf.forward_to,
    timeout: rcf.ring_timeout ?? 30,
    passCallerId: rcf.pass_caller_id,
    maxChannels: rcf.max_channels,
  });
  const hangup = b.add('hangup', { type: 'hangup' });

  b.wire(entry.id, dial.id);
  b.wire(dial.id, hangup.id);

  return newDraft(b, {
    product: 'rcf',
    name: `${rcf.did} flow`,
    customerId: rcf.customer_id ?? null,
    entry: { kind: 'did', did: rcf.did },
  });
}
