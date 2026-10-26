/**
 * panelChrome — how the builder's RIGHT panel sits beside the canvas
 * (docker/ui/CLAUDE.md §19 "Layout", §20): normal or wide, and — while it
 * only shows the flow checklist — tucked into a slim rail so the canvas gets
 * the width. FlowBuilder owns the state and provides it; every panel that
 * can occupy the column (block settings, the checklist, the Publish / Test
 * call / History / Flow assistant sheets) renders <PanelChromeButtons /> in
 * its head. Layout only: nothing here touches the graph or the sheets'
 * behaviour.
 */
import { createContext, useContext } from 'react';

export interface PanelChrome {
  /** The right panel is in its wide size. */
  wide: boolean;
  toggleWide: () => void;
  /** Set while the panel shows the checklist: tucks it into the rail. */
  hide: (() => void) | null;
  /** The right column's id (aria-controls of the hide button). */
  panelId: string;
}

export const PanelChromeContext = createContext<PanelChrome | null>(null);

/** The panel chrome, or null outside the desktop builder (phone sheets have none). */
export function usePanelChrome(): PanelChrome | null {
  return useContext(PanelChromeContext);
}
