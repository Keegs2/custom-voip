/**
 * Local types for the Communications hub. Anything shared only within this
 * feature folder lives here.
 */

import type { ReactNode } from 'react';

/** A single product tile on the unified-communications hub. */
export interface FeatureCardDef {
  title: string;
  description: string;
  /** Route the tile navigates to on click. */
  to: string;
  /** Local accent hue for this product tile (justified per-product override). */
  accent: string;
  /** Pre-tinted icon node (the icon owns its own colour). */
  icon: ReactNode;
}
