/**
 * Canvas edges.
 *
 *  ExitEdge — a stored §2 edge (an exit → a block). Smooth-step, neutral at
 *             rest; edges touching the selected block take the accent.
 *  JumpEdge — a Go to block's jump to its target, drawn dashed so loops
 *             ("press 9 to hear it again") are visible. Never stored: the
 *             Go to's config is the source of truth and the compiler aims
 *             pointers straight at the target.
 *
 * All paint goes through `style` / CSS classes (var() tokens), never the SVG
 * fill/stroke attributes (docker/ui/CLAUDE.md §18.3 rule 5).
 */
import { memo } from 'react';
import { BaseEdge, getSmoothStepPath, type EdgeProps } from '@xyflow/react';
import { useFlow, type FlowEdge } from '../store/flowStore';

function ExitEdgeImpl(props: EdgeProps<FlowEdge>) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, markerEnd } = props;
  const touchesSelection = useFlow((s) => s.selectedId !== null && (s.selectedId === source || s.selectedId === target));
  const [path] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 14,
    offset: 18,
  });
  return (
    <BaseEdge
      id={id}
      path={path}
      markerEnd={markerEnd}
      className={`ivr-edge${selected ? ' ivr-edge--selected' : ''}${touchesSelection ? ' ivr-edge--related' : ''}`}
      interactionWidth={18}
    />
  );
}

function JumpEdgeImpl(props: EdgeProps) {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, markerEnd } = props;
  // Bottom → bottom with a generous offset: the loop runs underneath the
  // blocks in between ("press 9 to hear it again" reads as a return path).
  const [path] = getSmoothStepPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, borderRadius: 18, offset: 26 });
  return <BaseEdge id={id} path={path} markerEnd={markerEnd} className="ivr-edge-jump" interactionWidth={0} />;
}

export const ExitEdge = memo(ExitEdgeImpl);
export const JumpEdge = memo(JumpEdgeImpl);
