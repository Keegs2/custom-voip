/**
 * CanvasView — what the canvas blocks need to draw themselves beyond their
 * own data: where each exit leads, block titles, findings and reachability.
 * The builder supplies it for the draft (from useFlowAnalysis) or for a
 * read-only published version (History → View) or a Flow assistant
 * proposal, so BlockNode never cares which one it is showing.
 */
import { createContext, useContext } from 'react';
import type { SummaryContext } from '../model/summary';
import type { ShownIssue } from '../useFlowAnalysis';

export interface CanvasView {
  /** "source\0handle" → target id. */
  targets: ReadonlyMap<string, string>;
  titleOf: (id: string) => string;
  issuesByNode: ReadonlyMap<string, readonly ShownIssue[]>;
  /** null = don't dim anything (read-only versions). */
  reachable: ReadonlySet<string> | null;
  summary: SummaryContext;
  readOnly: boolean;
  /** Ask the builder to open the "add a block after this exit" menu (keyboard + click on a free exit). */
  onAddAfter: ((source: string, handle: string) => void) | null;
  /** A Flow assistant proposal: blocks it adds or changes compared with the draft. */
  marks?: ReadonlyMap<string, 'new' | 'changed'>;
}

export const CanvasViewContext = createContext<CanvasView | null>(null);

export function useCanvasView(): CanvasView {
  const v = useContext(CanvasViewContext);
  if (!v) throw new Error('useCanvasView outside CanvasViewContext');
  return v;
}
