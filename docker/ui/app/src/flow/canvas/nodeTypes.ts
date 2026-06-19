/**
 * NodeType → custom React component registry. Passed to <ReactFlow> as a
 * STABLE module-level object (React Flow re-renders hard if its identity
 * changes between renders — plan §8).
 *
 * The IVR telephony verbs render real nodes: `entry` (EntryFlowNode), `menu`
 * (MenuNode, per-digit handles), and every linear verb (StepNode). The UCaaS
 * find-me/follow-me verbs (`ringGroup`, `voicemail`) also render via StepNode.
 * The rich-RCF two-way branch verbs (`schedule`, `condition`) render via
 * BranchNode (two labelled source handles). Node types that belong to other
 * products (answer/queue/webhook/goto) keep the generic placeholder.
 */
import type { NodeTypes } from '@xyflow/react';
import { GenericFlowNode } from './nodes/GenericFlowNode';
import { EntryFlowNode } from './nodes/EntryFlowNode';
import { StepNode } from './nodes/StepNode';
import { MenuNode } from './nodes/MenuNode';
import { BranchNode } from './nodes/BranchNode';

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
  // SIP-trunk inbound delivery verb.
  route: StepNode,
  // IVR branching verb.
  menu: MenuNode,
  // Rich-RCF two-way branch verbs (time-of-day, caller-ID).
  schedule: BranchNode,
  condition: BranchNode,
  // Other products — placeholder for now.
  answer: GenericFlowNode,
  queue: GenericFlowNode,
  webhook: GenericFlowNode,
  goto: GenericFlowNode,
};
