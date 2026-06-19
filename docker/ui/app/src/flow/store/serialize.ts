/**
 * Pure mappers between the persisted `CallFlowDoc` graph and React Flow's
 * runtime `nodes`/`edges`. Positions and viewport round-trip losslessly, so a
 * doc loaded into the canvas and read back out is structurally identical.
 *
 * React Flow's `Node`/`Edge` second generic is the node `type` string — we set
 * it to our domain `NodeType` so the `nodeTypes` registry can resolve a custom
 * component directly, and deserialize is a clean inverse.
 */
import type { Edge, Node } from '@xyflow/react';
import type {
  CallFlowDoc,
  EdgeCondition,
  FlowEdge,
  FlowNode,
  NodeConfig,
  NodeType,
} from '../model/types';

/** Data carried on a React Flow node — identical to `FlowNode['data']`. */
export type FlowNodeData = { label?: string; config: NodeConfig };

/** Data carried on a React Flow edge — identical to `FlowEdge['data']`. */
export type FlowEdgeData = { label?: string; condition?: EdgeCondition };

/** React Flow node/edge aliases specialised to our model. */
export type RFNode = Node<FlowNodeData, NodeType>;
export type RFEdge = Edge<FlowEdgeData>;

/* ─── Doc → React Flow ─────────────────────────────────────────────────── */

export function toRFNode(node: FlowNode): RFNode {
  return {
    id: node.id,
    type: node.type,
    position: node.position,
    data: node.data,
  };
}

export function toRFEdge(edge: FlowEdge): RFEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
    data: edge.data,
    label: edge.data?.label,
  };
}

export function serialize(doc: CallFlowDoc): { nodes: RFNode[]; edges: RFEdge[] } {
  return {
    nodes: doc.nodes.map(toRFNode),
    edges: doc.edges.map(toRFEdge),
  };
}

/* ─── React Flow → Doc ─────────────────────────────────────────────────── */

export function fromRFNode(node: RFNode): FlowNode {
  return {
    id: node.id,
    // `type` is always set by `toRFNode`; fall back defensively.
    type: (node.type ?? 'entry') as NodeType,
    position: node.position,
    data: node.data,
  };
}

export function fromRFEdge(edge: RFEdge): FlowEdge {
  return {
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
    data: edge.data,
  };
}

/**
 * Rebuild a `CallFlowDoc` from a base doc plus the live React Flow graph.
 * The base supplies the non-graph metadata (id, product, name, …); the graph
 * supplies positions/edges.
 */
export function deserialize(
  base: CallFlowDoc,
  graph: { nodes: RFNode[]; edges: RFEdge[]; viewport?: CallFlowDoc['viewport'] },
): CallFlowDoc {
  return {
    ...base,
    nodes: graph.nodes.map(fromRFNode),
    edges: graph.edges.map(fromRFEdge),
    viewport: graph.viewport ?? base.viewport,
  };
}
