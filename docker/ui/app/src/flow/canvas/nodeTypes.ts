/**
 * NodeType → custom React component registry. Passed to <ReactFlow> as a
 * STABLE module-level object (React Flow re-renders hard if its identity
 * changes between renders — plan §8).
 *
 * The IVR telephony verbs render real nodes: `entry` (EntryFlowNode), `menu`
 * (MenuNode, per-digit handles), and every linear verb (StepNode). The UCaaS
 * find-me/follow-me verbs (`ringGroup`, `voicemail`) also render via StepNode.
 * Node types that belong to other products (answer/schedule/condition/queue/
 * webhook/goto) keep the generic placeholder until their product ships.
 */
import type { NodeTypes } from '@xyflow/react';
import { GenericFlowNode } from './nodes/GenericFlowNode';
import { EntryFlowNode } from './nodes/EntryFlowNode';
import { StepNode } from './nodes/StepNode';
import { MenuNode } from './nodes/MenuNode';

export const nodeTypes: NodeTypes = {
  entry: EntryFlowNode,
  // IVR linear verbs.
  say: StepNode,
  play: StepNode,
  pause: StepNode,
  dial: StepNode,
  record: StepNode,
  redirect: StepNode,
  reject: StepNode,
  hangup: StepNode,
  conference: StepNode,
  // UCaaS find-me/follow-me verbs.
  ringGroup: StepNode,
  voicemail: StepNode,
  // IVR branching verb.
  menu: MenuNode,
  // Other products — placeholder for now.
  answer: GenericFlowNode,
  schedule: GenericFlowNode,
  condition: GenericFlowNode,
  queue: GenericFlowNode,
  webhook: GenericFlowNode,
  goto: GenericFlowNode,
};
