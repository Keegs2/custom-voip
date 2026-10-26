/**
 * The customer Guides hub's topics and the shapes its content is written in.
 * Component-free (react-refresh/only-export-components), like docProducts.ts.
 *
 * Routes: /docs/guides is the overview; /docs/guides/:topic opens a product
 * guide. Any other slug (incl. the old `trunking` / `calling`) redirects to
 * the overview. The Guides page no longer reads GUIDE_PRODUCTS from
 * ../docProducts (that list still types the shared ProductSelector).
 *
 * Content rules (customers only — docker/ui/CLAUDE.md §7 "Guides"): describe
 * only what a tenant `user` / `readonly` can see and do today, name things by
 * their on-screen labels, and never name carriers, the cloud provider,
 * internal components, prices or staff-only tools.
 */
import type { ReactNode } from 'react';

/** Product guides, in switcher order. The overview has no slug. */
export const GUIDE_TOPICS = ['rcf', 'voicemail', 'ivr'] as const;
export type GuideTopic = (typeof GUIDE_TOPICS)[number];

/** What the switcher shows: the overview (`null`) or one product guide. */
export type GuideView = GuideTopic | null;

export function isGuideTopic(v: string | undefined): v is GuideTopic {
  return v !== undefined && (GUIDE_TOPICS as readonly string[]).includes(v);
}

/** URL of a guide; `taskId` deep-links (and opens) one task. */
export function guideHref(view: GuideView, taskId?: string): string {
  const base = view === null ? '/docs/guides' : `/docs/guides/${view}`;
  return taskId ? `${base}#${taskId}` : base;
}

/** One task ("Change where a number rings"): a row that opens to its steps. */
export interface GuideTask {
  /** Stable, page-unique id — also the URL hash that opens it. */
  id: string;
  title: string;
  /** One line under the title, open or closed. */
  summary: string;
  icon: ReactNode;
  body: ReactNode;
}

/** One key fact in the "At a glance" card. */
export interface GuideFact {
  label: string;
  value: ReactNode;
}

/** One question in "Questions & fixes". */
export interface GuideFaq {
  id: string;
  question: string;
  answer: ReactNode;
}

/** Everything one product guide renders. */
export interface ProductGuideContent {
  topic: GuideTopic;
  /** The "How to" panel's one-line intro. */
  intro: string;
  tasks: readonly GuideTask[];
  facts: readonly GuideFact[];
  faq: readonly GuideFaq[];
}
