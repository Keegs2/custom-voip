/**
 * IVR Builder — flow state management via useReducer
 *
 * All mutations to the node tree go through a typed action dispatch,
 * keeping the canvas render logic strictly separated from state logic.
 */

import { useReducer, useCallback } from 'react';
import type { IvrVerbType } from '../../types/ivr';
import {
  makeNode,
  getNodeList,
  findNode,
  type BuilderNode,
} from './ivrUtils';

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface IvrFlowState {
  /** Persisted flow id (null = unsaved) */
  id: number | null;
  name: string;
  customerId: number | null;
  did: string | null;
  nodes: BuilderNode[];
  selectedNodeId: string | null;
}

const INITIAL_STATE: IvrFlowState = {
  id: null,
  name: 'New IVR Flow',
  customerId: null,
  did: null,
  nodes: [],
  selectedNodeId: null,
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type IvrAction =
  | { type: 'SET_NAME'; name: string }
  | { type: 'SET_CUSTOMER'; customerId: number | null }
  | { type: 'SET_DID'; did: string | null }
  | { type: 'ADD_NODE'; verb: IvrVerbType; path: string; position: number }
  | { type: 'REMOVE_NODE'; nodeId: string }
  | { type: 'MOVE_NODE'; nodeId: string; targetPath: string; targetPosition: number }
  | { type: 'SELECT_NODE'; nodeId: string | null }
  | { type: 'UPDATE_CONFIG'; nodeId: string; key: string; value: string }
  | { type: 'ADD_BRANCH'; nodeId: string; key: string }
  | { type: 'REMOVE_BRANCH'; nodeId: string; key: string }
  | { type: 'SET_ACTIVE_BRANCH'; nodeId: string; key: string | null }
  | { type: 'LOAD_FLOW'; state: IvrFlowState }
  | { type: 'RESET' };

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

function ivrReducer(state: IvrFlowState, action: IvrAction): IvrFlowState {
  // Helper: find a node in the current state
  const find = (id: string) => findNode(state.nodes, id);
  // Helper: get the array at a path from the root node list
  const getList = (path: string) => getNodeList({ nodes: state.nodes }, path);

  switch (action.type) {
    case 'SET_NAME':
      return { ...state, name: action.name };

    case 'SET_CUSTOMER':
      return { ...state, customerId: action.customerId, did: null };

    case 'SET_DID':
      return { ...state, did: action.did };

    case 'ADD_NODE': {
      // Deep-clone entire tree so React detects the state change
      const cloned = deepCloneNodes(state.nodes);
      const list = getNodeList({ nodes: cloned }, action.path);
      if (!list) return state;

      const newNode = makeNode(action.verb);
      list.splice(action.position, 0, newNode);

      return { ...state, nodes: cloned, selectedNodeId: newNode.id };
    }

    case 'REMOVE_NODE': {
      const cloned = deepCloneNodes(state.nodes);
      const found = findNode(cloned, action.nodeId);
      if (!found) return state;
      found.list.splice(found.index, 1);

      return {
        ...state,
        nodes: cloned,
        selectedNodeId: state.selectedNodeId === action.nodeId ? null : state.selectedNodeId,
      };
    }

    case 'MOVE_NODE': {
      const cloned = deepCloneNodes(state.nodes);
      const found = findNode(cloned, action.nodeId);
      if (!found) return state;

      const nodeCopy = found.node;
      // Remove from original location
      found.list.splice(found.index, 1);

      // Get target list (after removal — same list may have shifted)
      const targetList = getNodeList({ nodes: cloned }, action.targetPath);
      if (!targetList) return state;

      // Adjust index if we removed from the same array before the target position
      let insertAt = action.targetPosition;
      if (targetList === found.list && found.index < action.targetPosition) {
        insertAt = Math.max(0, action.targetPosition - 1);
      }

      targetList.splice(insertAt, 0, nodeCopy);
      return { ...state, nodes: cloned };
    }

    case 'SELECT_NODE':
      return { ...state, selectedNodeId: action.nodeId };

    case 'UPDATE_CONFIG': {
      const cloned = deepCloneNodes(state.nodes);
      const found = findNode(cloned, action.nodeId);
      if (!found) return state;
      found.node.config = { ...found.node.config, [action.key]: action.value };
      return { ...state, nodes: cloned };
    }

    case 'ADD_BRANCH': {
      const cloned = deepCloneNodes(state.nodes);
      const found = findNode(cloned, action.nodeId);
      if (!found || found.node.type !== 'gather') return state;

      // Don't add if key already exists
      if (found.node.branches[action.key] !== undefined) return state;

      found.node.branches = { ...found.node.branches, [action.key]: [] };
      found.node._activeBranch = action.key;
      return { ...state, nodes: cloned };
    }

    case 'REMOVE_BRANCH': {
      const cloned = deepCloneNodes(state.nodes);
      const found = findNode(cloned, action.nodeId);
      if (!found) return state;

      const newBranches = { ...found.node.branches };
      delete newBranches[action.key];
      found.node.branches = newBranches;

      // Switch active branch if we removed the current one
      if (found.node._activeBranch === action.key) {
        const remaining = Object.keys(newBranches);
        found.node._activeBranch = remaining.length > 0 ? remaining[0] : null;
      }

      return { ...state, nodes: cloned };
    }

    case 'SET_ACTIVE_BRANCH': {
      const cloned = deepCloneNodes(state.nodes);
      const found = findNode(cloned, action.nodeId);
      if (!found) return state;
      found.node._activeBranch = action.key;
      return { ...state, nodes: cloned };
    }

    case 'LOAD_FLOW':
      return { ...action.state };

    case 'RESET':
      return { ...INITIAL_STATE };

    default:
      return state;
  }

  // TypeScript exhaustiveness guard — unreachable at runtime
  void find;
  void getList;
}

// ---------------------------------------------------------------------------
// Deep clone helpers
// Needed so React detects changes (the tree is mutable during traversal ops)
// ---------------------------------------------------------------------------

function deepCloneNode(node: BuilderNode): BuilderNode {
  const clonedBranches: Record<string, BuilderNode[]> = {};
  for (const [key, childNodes] of Object.entries(node.branches)) {
    clonedBranches[key] = childNodes.map(deepCloneNode);
  }

  return {
    ...node,
    config: { ...node.config },
    prompt: node.prompt.map(deepCloneNode),
    branches: clonedBranches,
  };
}

function deepCloneNodes(nodes: BuilderNode[]): BuilderNode[] {
  return nodes.map(deepCloneNode);
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface IvrFlowHook {
  state: IvrFlowState;
  dispatch: React.Dispatch<IvrAction>;
  /** Convenience: returns the currently selected node, or null */
  selectedNode: BuilderNode | null;
}

export function useIvrFlow(): IvrFlowHook {
  const [state, dispatch] = useReducer(ivrReducer, INITIAL_STATE);

  const selectedNode = useCallback((): BuilderNode | null => {
    if (!state.selectedNodeId) return null;
    const found = findNode(state.nodes, state.selectedNodeId);
    return found ? found.node : null;
  }, [state.nodes, state.selectedNodeId]);

  return {
    state,
    dispatch,
    selectedNode: selectedNode(),
  };
}
