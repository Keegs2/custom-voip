/**
 * IVR Builder — Flow Node Card
 *
 * Represents a single verb in the flow. Clicking selects it (shows config panel).
 * The drag handle on the left lets users reorder nodes within the canvas.
 */

import { useDraggable } from '@dnd-kit/core';
import { cn } from '../../utils/cn';
import { verbIcon, verbColor, verbTextClass, nodeSummary, type BuilderNode } from './ivrUtils';
import type { IvrAction } from './useIvrFlow';

interface IvrNodeProps {
  node: BuilderNode;
  isSelected: boolean;
  dispatch: React.Dispatch<IvrAction>;
}

export function IvrNode({ node, isSelected, dispatch }: IvrNodeProps) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `node:${node.id}`,
    data: { nodeId: node.id, type: 'node' },
  });

  const accentColor = verbColor(node.type);
  const textClass = verbTextClass(node.type);
  const summary = nodeSummary(node);
  const icon = verbIcon(node.type);

  function handleSelect(e: React.MouseEvent) {
    e.stopPropagation();
    dispatch({ type: 'SELECT_NODE', nodeId: node.id });
  }

  function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    dispatch({ type: 'REMOVE_NODE', nodeId: node.id });
  }

  return (
    <div
      ref={setNodeRef}
      className={cn(
        'relative flex items-stretch w-full max-w-[560px] mx-auto',
        'bg-[#1a1d27] border border-[#2a2f45] rounded-lg overflow-hidden',
        'transition-all duration-150 cursor-pointer select-none',
        isSelected && 'ring-2 ring-[#3b82f6] shadow-[0_0_16px_rgba(59,130,246,0.22)]',
        isDragging && 'opacity-40',
      )}
      onClick={handleSelect}
      role="button"
      aria-label={`${node.type} node — ${summary}`}
      aria-pressed={isSelected}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          dispatch({ type: 'SELECT_NODE', nodeId: node.id });
        }
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          dispatch({ type: 'REMOVE_NODE', nodeId: node.id });
        }
      }}
    >
      {/* Left color accent bar */}
      <div
        className="w-[4px] flex-shrink-0"
        style={{ backgroundColor: accentColor }}
        aria-hidden="true"
      />

      {/* Drag handle */}
      <div
        className={cn(
          'flex items-center justify-center px-2 text-[#4a5568] cursor-grab',
          'hover:text-[#718096] hover:bg-white/[0.03] transition-colors',
          'flex-shrink-0',
        )}
        aria-label="Drag to reorder"
        {...listeners}
        {...attributes}
        onClick={(e) => e.stopPropagation()}
      >
        <span className="text-[16px] leading-none select-none" aria-hidden="true">⠿</span>
      </div>

      {/* Node body */}
      <div className="flex-1 min-w-0 py-3 pr-2">
        <div className={cn('text-[0.68rem] font-bold uppercase tracking-[0.8px] mb-0.5', textClass)}>
          {node.type}
        </div>
        <div className="text-[0.85rem] text-[#e2e8f0] truncate leading-tight">
          <span className="mr-1.5 opacity-70" aria-hidden="true">{icon}</span>
          {summary}
        </div>
      </div>

      {/* Delete button */}
      <button
        type="button"
        className={cn(
          'flex items-center justify-center w-8 flex-shrink-0',
          'text-[#4a5568] hover:text-[#fca5a5] hover:bg-red-900/20',
          'transition-colors text-lg leading-none',
        )}
        aria-label={`Delete ${node.type} node`}
        onClick={handleDelete}
      >
        ✕
      </button>
    </div>
  );
}
