/**
 * NodeType → custom React component registry. Passed to <ReactFlow> as a
 * STABLE module-level object (React Flow re-renders hard if its identity
 * changes between renders — plan §8).
 *
 * P0 wires every domain node type to one of two generic placeholder components
 * (entry → EntryFlowNode, everything else → GenericFlowNode). P1 replaces these
 * with the real per-type telephony nodes (SayNode, MenuNode, DialNode, …).
 */
import type { NodeTypes } from '@xyflow/react';
import { GenericFlowNode } from './nodes/GenericFlowNode';
import { EntryFlowNode } from './nodes/EntryFlowNode';

export const nodeTypes: NodeTypes = {
  entry: EntryFlowNode,
  answer: GenericFlowNode,
  say: GenericFlowNode,
  play: GenericFlowNode,
  pause: GenericFlowNode,
  menu: GenericFlowNode,
  dial: GenericFlowNode,
  ringGroup: GenericFlowNode,
  schedule: GenericFlowNode,
  condition: GenericFlowNode,
  record: GenericFlowNode,
  voicemail: GenericFlowNode,
  conference: GenericFlowNode,
  queue: GenericFlowNode,
  webhook: GenericFlowNode,
  goto: GenericFlowNode,
  reject: GenericFlowNode,
  hangup: GenericFlowNode,
};
