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
        'relative mx-auto w-full max-w-[560px] rounded-xl transition-all duration-150',
        'border-2 border-dashed',
        isOver
          ? 'min-h-[52px] border-[#06b6d4] bg-[rgba(6,182,212,0.07)] shadow-[0_0_16px_rgba(6,182,212,0.2)]'
          : 'min-h-[36px] border-transparent',
      )}
    >
      {isOver && (
        <div className="absolute inset-0 flex items-center justify-center gap-1.5">
          <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#06b6d4' }} aria-hidden="true" />
          <span className="text-[#06b6d4] text-xs font-semibold select-none pointer-events-none tracking-wide">
            Drop here
          </span>
        </div>
      )}
    </div>
  );
}
