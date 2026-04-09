/**
 * IVR Builder — Gather Branch Tabs
 *
 * Shown below a Gather node. Displays one tab per branch key (digit / "timeout" / "default"),
 * an "Add Branch" button, and a sub-canvas for the active branch's nodes.
 */

import { useState } from 'react';
import { cn } from '../../utils/cn';
import { type BuilderNode } from './ivrUtils';
import type { IvrAction } from './useIvrFlow';

// Lazy import to avoid circular dep — IvrCanvas imports IvrGatherBranches, so we
// import IvrCanvas at call time. React handles this fine at runtime.
// We use a dynamic approach via the renderCanvas prop instead.

interface IvrGatherBranchesProps {
  node: BuilderNode;
  nodePath: string;
  nodeIndex: number;
  dispatch: React.Dispatch<IvrAction>;
  /** Render prop to render a sub-canvas. Avoids circular import. */
  renderCanvas: (nodes: BuilderNode[], path: string) => React.ReactNode;
}

export function IvrGatherBranches({
  node,
  nodePath,
  nodeIndex,
  dispatch,
  renderCanvas,
}: IvrGatherBranchesProps) {
  const [addingBranch, setAddingBranch] = useState(false);
  const [branchKeyInput, setBranchKeyInput] = useState('');
  const [branchError, setBranchError] = useState('');

  const branches = node.branches ?? {};
  const branchKeys = Object.keys(branches);

  // Determine active branch — use node's _activeBranch, fall back to first key
  const activeBranch = node._activeBranch && branches[node._activeBranch] !== undefined
    ? node._activeBranch
    : (branchKeys.length > 0 ? branchKeys[0] : null);

  function handleTabClick(key: string) {
    dispatch({ type: 'SET_ACTIVE_BRANCH', nodeId: node.id, key });
  }

  function handleRemoveBranch(e: React.MouseEvent, key: string) {
    e.stopPropagation();
    dispatch({ type: 'REMOVE_BRANCH', nodeId: node.id, key });
  }

  function handleAddBranch() {
    const k = branchKeyInput.trim();
    if (!k) {
      setBranchError('Branch key cannot be empty.');
      return;
    }
    if (branches[k] !== undefined) {
      setBranchError(`Branch "${k}" already exists.`);
      return;
    }
    dispatch({ type: 'ADD_BRANCH', nodeId: node.id, key: k });
    setBranchKeyInput('');
    setBranchError('');
    setAddingBranch(false);
  }

  function labelFor(key: string): string {
    if (key === 'timeout') return 'Timeout';
    if (key === 'default') return 'Default';
    return `Digit ${key}`;
  }

  // Build the branch content path: e.g. "nodes[2].branches.1"
  const branchContentPath = activeBranch
    ? `${nodePath}[${nodeIndex}].branches.${activeBranch}`
    : null;

  const activeNodes = activeBranch ? (branches[activeBranch] ?? []) : null;

  return (
    <div className="w-full max-w-[560px] mx-auto mt-0.5">
      {/* Container with left indent to show nesting under the gather node */}
      <div className="ml-[4px] border-l-2 border-[#2a2f45] pl-4 pb-1">
        {/* Tab bar */}
        <div className="flex items-center gap-1 flex-wrap py-2">
          {branchKeys.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => handleTabClick(key)}
              className={cn(
                'inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-semibold',
                'border transition-all duration-100',
                key === activeBranch
                  ? 'bg-[#3b82f6]/20 border-[#3b82f6]/60 text-[#93c5fd]'
                  : 'bg-transparent border-[#2a2f45] text-[#718096] hover:border-[#3d4460] hover:text-[#e2e8f0]',
              )}
            >
              {labelFor(key)}
              <span
                role="button"
                aria-label={`Remove branch ${key}`}
                onClick={(e) => handleRemoveBranch(e, key)}
                className="opacity-50 hover:opacity-100 transition-opacity cursor-pointer leading-none"
              >
                ✕
              </span>
            </button>
          ))}

          {/* Add branch input or button */}
          {addingBranch ? (
            <div className="flex items-center gap-1">
              <input
                type="text"
                value={branchKeyInput}
                onChange={(e) => { setBranchKeyInput(e.target.value); setBranchError(''); }}
                placeholder="0-9, *, #, timeout, default"
                className={cn(
                  'text-xs px-2 py-1 rounded-md border bg-[#1e2130] text-[#e2e8f0] outline-none',
                  'w-[160px] transition-colors',
                  branchError ? 'border-red-500' : 'border-[#2a2f45] focus:border-[#3b82f6]',
                )}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddBranch();
                  if (e.key === 'Escape') { setAddingBranch(false); setBranchKeyInput(''); setBranchError(''); }
                }}
              />
              <button
                type="button"
                onClick={handleAddBranch}
                className="text-xs px-2 py-1 rounded-md bg-[#3b82f6] text-white font-semibold hover:bg-[#2563eb] transition-colors"
              >
                Add
              </button>
              <button
                type="button"
                onClick={() => { setAddingBranch(false); setBranchKeyInput(''); setBranchError(''); }}
                className="text-xs px-2 py-1 rounded-md border border-[#2a2f45] text-[#718096] hover:text-[#e2e8f0] transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setAddingBranch(true)}
              className={cn(
                'inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-semibold',
                'border border-dashed border-[#2a2f45] text-[#4a5568]',
                'hover:border-[#3b82f6]/60 hover:text-[#3b82f6] transition-all duration-100',
              )}
            >
              + Branch
            </button>
          )}
        </div>

        {/* Error message */}
        {branchError && (
          <p className="text-xs text-red-400 mb-1 ml-1">{branchError}</p>
        )}

        {/* Active branch canvas */}
        {branchKeys.length === 0 ? (
          <div className="text-xs text-[#4a5568] italic py-2">
            No branches yet. Click "+ Branch" to add one (e.g. digit "1", "timeout", "default").
          </div>
        ) : activeBranch && branchContentPath && activeNodes !== null ? (
          <div className="py-1">
            {renderCanvas(activeNodes, branchContentPath)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

