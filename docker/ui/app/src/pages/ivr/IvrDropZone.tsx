/**
 * IVR Builder — Drop Zone
 *
 * An invisible (normally) slot between nodes that accepts dragged verbs
 * or nodes. Expands and glows when something is dragged over it.
 */

import { useDroppable } from '@dnd-kit/core';
import { cn } from '../../utils/cn';

interface IvrDropZoneProps {
  /** Path in the tree, e.g. "nodes" or "nodes[0].branches.1" */
  path: string;
  /** Insertion index within the list at `path` */
  position: number;
}

export function IvrDropZone({ path, position }: IvrDropZoneProps) {
  const droppableId = `drop:${path}:${position}`;

  const { isOver, setNodeRef } = useDroppable({
    id: droppableId,
    data: { path, position },
  });

  return (
    <div
      ref={setNodeRef}
      role="region"
      aria-label={`Drop zone at position ${position}`}
      className={cn(
        'relative mx-auto w-full max-w-[560px] rounded-lg transition-all duration-150',
        'border-2 border-dashed',
        isOver
          ? 'min-h-[48px] border-[#3b82f6] bg-[#3b82f6]/10 shadow-[0_0_12px_rgba(59,130,246,0.25)]'
          : 'min-h-[36px] border-transparent',
      )}
    >
      {isOver && (
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-[#3b82f6] text-xs font-semibold select-none pointer-events-none">
            Drop verb here
          </span>
        </div>
      )}
    </div>
  );
}
