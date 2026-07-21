/**
 * Local types for the Dashboard (public landing / product hub) page.
 *
 * Page-global types live in `src/types/`; only the feature-local card shapes
 * used to drive the static product + capability grids live here.
 */

import type { LucideIcon } from 'lucide-react';

/** A single "platform capability" tile in the 2x2 / 4-up capabilities grid. */
export interface CapabilityCardData {
  /** lucide-react icon *component* (rendered by the card, never pre-instantiated). */
  icon: LucideIcon;
  title: string;
  description: string;
}

/** A single product tile in the product hub grid. */
export interface ProductCardData {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  /** Live products are clickable; inactive ones render the muted "Soon" variant. */
  active: boolean;
  /** Route navigated to when an authenticated user clicks an active tile. */
  route?: string;
  /**
   * Slug of the public docs guide for this product (→ `/docs/{docsSlug}`). When
   * set, the card renders a small "Read the guide" link — a low-friction "learn
   * more" affordance that works for logged-out prospects (docs are public).
   */
  docsSlug?: string;
}
