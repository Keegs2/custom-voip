/**
 * Local types for the documentation pages.
 *
 * Two content shapes live here:
 *   1. The API-reference primitives (HTTP verb, param row) used by the technical
 *      "For developers" material — these predate the multi-product docs.
 *   2. The `ProductGuide` data model — the single, typed shape every product
 *      guide (RCF, Programmable Voice, SIP Trunking, Unified Comms, AI Agents,
 *      Toll-Free, Billing, Platform) is authored against, so all guides render
 *      through ONE presentational component with identical structure. Content is
 *      declarative data; the technical detail is carried as a render function so
 *      it can compose the code/endpoint primitives.
 *
 * These are feature-local only — nothing here duplicates a global type from
 * `src/types/`. The docs pages are static content surfaces (no server state).
 */

import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

/* ─── API-reference primitives ───────────────────────────────────────────── */

/** HTTP verbs rendered by the <Endpoint> row, each with its own colour. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/** One row in a <ParamTable>. */
export interface Param {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

/* ─── Product-guide data model ───────────────────────────────────────────── */

/**
 * A single line item in the "What you get" feature list. `title` is the bold
 * lede; `body` is the supporting sentence(s).
 */
export interface FeatureItem {
  title: string;
  body: ReactNode;
}

/** A single numbered step in the "Getting started" walkthrough. */
export interface GuideStep {
  title: string;
  body: ReactNode;
}

/** A single REST endpoint reference shown in the "For developers" accordion. */
export interface EndpointRef {
  method: HttpMethod;
  path: string;
  description: string;
}

/**
 * The full content for one product guide. Every guide page is a thin wrapper
 * that hands one of these to <ProductGuide>, guaranteeing identical IA across
 * all products. Plain-English fields lead; the technical detail is isolated in
 * `developers` (rendered inside a collapsible accordion).
 */
export interface ProductGuideData {
  /** Route slug segment, e.g. 'rcf' → /docs/rcf. Used for CTAs + cross-links. */
  slug: string;
  /** lucide-react icon *component* (rendered by the page, never pre-instantiated). */
  icon: LucideIcon;
  /** Eyebrow above the title (audience / category label). */
  eyebrow: string;
  /** Product name — the page <h1>. */
  title: string;
  /** One-line subtitle under the title. */
  subtitle: string;
  /** Per-product accent hue (hex). Defaults to app blue when omitted. */
  accent?: string;

  /** "In plain English" — the opening value proposition. */
  plainEnglish: ReactNode;
  /** "Who it's for" — audience bullets. */
  whoItsFor: ReactNode[];
  /** "What you get" — the feature list. */
  features: FeatureItem[];
  /** "How it works" — a short prose explanation of the mechanism. */
  howItWorks: ReactNode;
  /** "Getting started" — ordered steps ending in a sign-up CTA. */
  gettingStarted: GuideStep[];
  /** Optional label for the getting-started CTA button (defaults provided). */
  ctaLabel?: string;

  /**
   * "For developers" — the technical section rendered inside a collapsible
   * accordion. A render function so it can compose the code/endpoint/table
   * primitives freely (not just plain text).
   */
  developers: {
    /** One-line summary shown as the accordion subtitle. */
    summary: string;
    /** Optional REST endpoint references rendered above the free-form body. */
    endpoints?: EndpointRef[];
    /** Free-form technical body (code blocks, param tables, notes, prose). */
    body: () => ReactNode;
  };
}

/**
 * Hub-card metadata for the /docs landing grid + the sidebar Documentation
 * group. Derived from PRODUCTS.md's "products at a glance" table so the hub, the
 * nav, and each guide stay in sync from one source.
 */
export interface GuideMeta {
  slug: string;
  icon: LucideIcon;
  /** Product name. */
  title: string;
  /** The one-sentence pitch (PRODUCTS.md "in one sentence"). */
  pitch: string;
  /** "Best for" audience line (PRODUCTS.md). */
  bestFor: string;
  /** Per-product accent hue (hex). */
  accent: string;
}
