/**
 * briefContent.ts — single source of truth for the SE Onboarding Intake
 * Brief content.
 *
 * Every string, fact list, product block, capacity verdict, and checklist
 * item in the brief is composed HERE, as plain data. Two renderers consume
 * this module — the on-screen HTML preview (OnboardingBriefPage) and the
 * downloadable PDF (onboardingBriefPdf) — so the two artifacts cannot
 * drift: they are pure presenters over the same model.
 *
 * Everything in this file is a pure function of an OnboardingRequest.
 */
import {
  ATTACH_TO_LABELS,
  GOV_ID_TYPE_LABELS,
  INTENDED_USE_LABELS,
  PRODUCT_LABELS,
  type KycRecord,
  type OnboardingRequest,
  type OnboardingStatus,
  type ProductKey,
} from '../../types/onboarding';
import { fmt } from '../../utils/format';

/** Granite's provider-defined high-volume thresholds (FCC 26-27). */
export const CPS_THRESHOLD = 1;
export const PATHS_THRESHOLD = 1_000;

// ─── Shared strings ───────────────────────────────────────────────────────────

export const BRIEF_BRAND = 'Granite CRAG';
export const BRIEF_TITLE = 'Onboarding Intake Brief';
export const HV_BANNER_TITLE = 'High-Volume Applicant — Enhanced KYC on File';
export const RED_FLAG_TEXT =
  'Address on file is a registered agent / virtual office. Obtain and ' +
  'verify the physical operating address before provisioning.';
export const FOOTER_LEFT = 'Granite CRAG · Onboarding Intake Queue';

export const STATUS_LABELS: Record<OnboardingStatus, string> = {
  pending: 'Pending Review',
  completed: 'Completed',
  rejected: 'Rejected',
};

/** The download filename for a request's brief. */
export function briefFileName(id: number): string {
  return `crag-intake-brief-${id}.pdf`;
}

// ─── Tiny formatters ──────────────────────────────────────────────────────────

export function fmtBriefDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
}

export function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName;
}

function num(n: number): string {
  return n.toLocaleString('en-US');
}

export function footerRight(): string {
  return `Internal — Solutions Engineering · Generated ${fmtBriefDate(new Date().toISOString())}`;
}

/** "5 CPS · 1,200 paths" — the HV banner sub-line. */
export function hvBannerSub(kyc: KycRecord | null): string {
  const cps = kyc?.declared_peak_cps;
  const paths = kyc?.declared_max_concurrent_calls;
  return `${cps ?? '—'} CPS · ${paths != null ? num(paths) : '—'} paths`;
}

// ─── Facts (KYC digest + HV enhanced-KYC record) ──────────────────────────────

/**
 * One label/value fact. `value` may contain '\n' (renderers emit line
 * breaks). `monoSuffix` is appended in mono type after `value`;
 * `monoValue` renders the whole value in mono. `ips` replaces the value
 * with a mono chip list.
 */
export interface BriefFact {
  label: string;
  value: string | null;
  monoSuffix?: string;
  monoValue?: boolean;
  ips?: string[];
}

/** The KYC digest facts grid (order matters — renderers keep it). */
export function buildKycFacts(kyc: KycRecord): BriefFact[] {
  const s = kyc.standard;
  const facts: BriefFact[] = [
    { label: 'Legal Business Name', value: s.legal_business_name },
    {
      label: 'Physical Address',
      value:
        `${s.address_line1}${s.address_line2 ? `, ${s.address_line2}` : ''}\n` +
        `${s.city}, ${s.state} ${s.postal_code}`,
    },
    {
      label: 'Government ID',
      value: GOV_ID_TYPE_LABELS[s.gov_id_type] ?? s.gov_id_type,
      monoSuffix: s.gov_id_number,
    },
  ];
  if (s.state_of_registration) {
    facts.push({ label: 'State of Registration', value: s.state_of_registration });
  }
  facts.push(
    {
      label: 'Alternate Phone',
      value: s.alternate_phone ? fmt(s.alternate_phone) : null,
      monoValue: true,
    },
    { label: 'Website', value: s.website || null },
  );
  return facts;
}

/** The FCC 26-27 enhanced-KYC record facts (high-volume applicants only). */
export function buildHvFacts(kyc: KycRecord): BriefFact[] | null {
  const hv = kyc.high_volume;
  if (!hv) return null;
  const facts: BriefFact[] = [
    {
      label: 'Intended Use',
      value: INTENDED_USE_LABELS[hv.intended_use] ?? hv.intended_use,
    },
    {
      label: 'Expected Daily Calls',
      value: hv.expected_daily_calls != null ? num(hv.expected_daily_calls) : null,
    },
  ];
  if (hv.intended_use_description) {
    facts.push({ label: 'Use Description', value: hv.intended_use_description });
  }
  facts.push({
    label: `Originating IPs (${hv.originating_ips.length})`,
    value: null,
    ips: hv.originating_ips,
  });
  return facts;
}

// ─── Requested-products blocks ────────────────────────────────────────────────

/**
 * One line inside a product block:
 * - `fact`  — label left, value right (single row)
 * - `block` — label above a full-width paragraph (`mono` for URLs)
 * - `ips`   — label above a mono chip list
 */
export type ProductLine =
  | { kind: 'fact'; label: string; value: string | null }
  | { kind: 'block'; label: string; value: string | null; mono?: boolean }
  | { kind: 'ips'; label: string; ips: string[] };

export interface ProductBlock {
  key: ProductKey;
  name: string;
  lines: ProductLine[];
}

export interface ProductsModel {
  /** Section-title note, e.g. "3 selected · monthly volume 500-2,000". */
  note: string;
  blocks: ProductBlock[];
}

/**
 * The Requested Products section. Legacy rows (products === null) yield a
 * single RCF block from the top-level intake fields.
 */
export function buildProductsModel(req: OnboardingRequest): ProductsModel {
  const products = req.products;

  if (!products) {
    return {
      note: 'Legacy RCF intake (pre-products form)',
      blocks: [
        {
          key: 'rcf',
          name: PRODUCT_LABELS.rcf,
          lines: [
            { kind: 'fact', label: 'DIDs requested', value: req.did_count },
            { kind: 'fact', label: 'Porting', value: req.porting },
            ...(req.current_carrier
              ? [{ kind: 'fact', label: 'Current carrier', value: req.current_carrier } as const]
              : []),
            { kind: 'fact', label: 'Forwarding setup', value: req.forwarding_setup },
            { kind: 'fact', label: 'Monthly volume', value: req.monthly_volume },
          ],
        },
      ],
    };
  }

  const blocks: ProductBlock[] = [];
  const { rcf, trunk, api, voicemail } = products;

  if (rcf) {
    blocks.push({
      key: 'rcf',
      name: PRODUCT_LABELS.rcf,
      lines: [
        { kind: 'fact', label: 'DIDs requested', value: rcf.did_count },
        { kind: 'fact', label: 'Porting', value: rcf.porting },
        ...(rcf.current_carrier
          ? [{ kind: 'fact', label: 'Current carrier', value: rcf.current_carrier } as const]
          : []),
        { kind: 'fact', label: 'Forwarding setup', value: rcf.forwarding_setup },
      ],
    });
  }

  if (trunk) {
    blocks.push({
      key: 'trunk',
      name: PRODUCT_LABELS.trunk,
      lines: [
        {
          kind: 'fact',
          label: 'Concurrent call paths',
          value: num(trunk.concurrent_call_paths),
        },
        { kind: 'fact', label: 'PBX vendor', value: trunk.pbx_vendor ?? null },
        { kind: 'fact', label: 'DID notes', value: trunk.dids_needed ?? null },
        {
          kind: 'ips',
          label:
            `Signaling IPs (${trunk.signaling_ips.length}) — ` +
            'IP-authenticated, no registration',
          ips: trunk.signaling_ips,
        },
      ],
    });
  }

  if (api) {
    blocks.push({
      key: 'api',
      name: PRODUCT_LABELS.api,
      lines: [
        { kind: 'block', label: 'Use case', value: api.use_case },
        {
          kind: 'fact',
          label: 'Expected CPS',
          value: api.expected_cps != null ? num(api.expected_cps) : null,
        },
        { kind: 'fact', label: 'Needs numbers', value: api.needs_numbers ? 'Yes' : 'No' },
        { kind: 'block', label: 'Webhook URL', value: api.webhook_url ?? null, mono: true },
      ],
    });
  }

  if (voicemail) {
    blocks.push({
      key: 'voicemail',
      name: PRODUCT_LABELS.voicemail,
      lines: [
        { kind: 'fact', label: 'Mailboxes', value: num(voicemail.mailbox_count) },
        {
          kind: 'fact',
          label: 'Attach to',
          value: ATTACH_TO_LABELS[voicemail.attach_to] ?? voicemail.attach_to,
        },
      ],
    });
  }

  return {
    note: `${products.selected.length} selected · monthly volume ${req.monthly_volume}`,
    blocks,
  };
}

// ─── Capacity & compliance ────────────────────────────────────────────────────

export interface CapacityRowModel {
  metric: string;
  /** Pre-formatted declared value, or null when undeclared. */
  declared: string | null;
  threshold: string;
  /** null when declared is null (no verdict possible). */
  over: boolean | null;
}

export interface CapacityModel {
  /** null → capacity was declared; string → "not declared" explainer. */
  missingNote: string | null;
  rows: CapacityRowModel[];
}

export function buildCapacityModel(kyc: KycRecord | null): CapacityModel {
  const cps = kyc?.declared_peak_cps;
  const paths = kyc?.declared_max_concurrent_calls;

  if (cps == null && paths == null) {
    return {
      missingNote: `Capacity not declared (${kyc ? 'pre-v2 intake form' : 'pre-KYC intake'}).`,
      rows: [],
    };
  }

  return {
    missingNote: null,
    rows: [
      {
        metric: 'Peak calls per second',
        declared: cps != null ? num(cps) : null,
        // NOTE: no '→' here — the PDF renders with core Helvetica (WinAnsi),
        // which cannot encode U+2192. Stick to WinAnsi-safe punctuation.
        threshold: '> 1 CPS — high-volume',
        over: cps != null ? cps > CPS_THRESHOLD : null,
      },
      {
        metric: 'Concurrent call paths',
        declared: paths != null ? num(paths) : null,
        threshold: '> 1,000 paths — high-volume',
        over: paths != null ? paths > PATHS_THRESHOLD : null,
      },
    ],
  };
}

// ─── SE action checklist — auto-composed from the submission ──────────────────

export interface ChecklistItem {
  text: string;
  /** Rendered red + bold — blocking verification issues. */
  critical?: boolean;
}

/**
 * Derives 4-8 concrete next steps so the SE does the least possible work
 * before contacting the customer. Priority order: blocking KYC issues →
 * identity verification → high-volume / capacity → per-product provisioning
 * prep → kickoff scheduling (always last). When the list would exceed 8,
 * the lowest-priority product item (voicemail) is dropped first.
 */
export function buildActionChecklist(req: OnboardingRequest): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const kyc = req.kyc;
  const s = kyc?.standard;
  const products = req.products;

  if (!kyc) {
    items.push({
      critical: true,
      text: 'Collect FCC 26-27 business verification (KYC) — this request predates the KYC intake form.',
    });
  }

  if (s?.address_is_registered_agent_or_virtual) {
    items.push({
      critical: true,
      text: 'Registered-agent / virtual-office address on file — obtain and verify the physical operating address before provisioning.',
    });
  }

  if (s) {
    const idLabel = GOV_ID_TYPE_LABELS[s.gov_id_type] ?? s.gov_id_type;
    const registry =
      s.gov_id_type === 'ein'
        ? 'IRS records'
        : s.gov_id_type === 'state_registration'
          ? `the ${s.state_of_registration ?? s.state} state registry`
          : 'the issuing registry';
    items.push({ text: `Verify ${idLabel} ${s.gov_id_number} against ${registry}.` });
  }

  const hv = kyc?.high_volume;
  if (hv) {
    const n = hv.originating_ips.length;
    items.push({
      text:
        `High-volume (FCC 26-27): validate intended use — ` +
        `${INTENDED_USE_LABELS[hv.intended_use] ?? hv.intended_use} — and confirm ` +
        `ownership of ${n} originating IP${n === 1 ? '' : 's'}.`,
    });
  }

  const cps = kyc?.declared_peak_cps;
  const paths = kyc?.declared_max_concurrent_calls;
  if ((cps != null && cps > CPS_THRESHOLD) || (paths != null && paths > PATHS_THRESHOLD)) {
    items.push({
      text:
        `Declared capacity (${cps ?? '—'} CPS / ` +
        `${paths != null ? num(paths) : '—'} concurrent paths) ` +
        `exceeds Granite's standard threshold — size trunk groups and rate limits accordingly.`,
    });
  }

  const porting = products?.rcf?.porting ?? req.porting;
  const carrier = products?.rcf?.current_carrier ?? req.current_carrier;
  if (porting && /^(yes|both)/i.test(porting)) {
    items.push({
      text: `Confirm porting from ${carrier ?? 'the losing carrier'} — LOA and a recent bill (CSR) required.`,
    });
  }

  if (products?.trunk) {
    const t = products.trunk;
    items.push({
      text:
        `Whitelist signaling IP${t.signaling_ips.length === 1 ? '' : 's'} on trunk ` +
        `provisioning: ${t.signaling_ips.join(', ')}` +
        `${t.pbx_vendor ? ` (PBX: ${t.pbx_vendor})` : ''}.`,
    });
  }

  if (products?.api) {
    const a = products.api;
    const webhook = a.webhook_url ? `; confirm webhook endpoint ${a.webhook_url}` : '';
    items.push({
      text: a.needs_numbers
        ? `Assign DIDs for API Calling and issue API credentials${webhook}.`
        : `Issue API credentials${webhook}.`,
    });
  }

  let vvmIndex = -1;
  if (products?.voicemail) {
    const v = products.voicemail;
    vvmIndex = items.length;
    items.push({
      text:
        `Provision ${num(v.mailbox_count)} voicemail ` +
        `mailbox${v.mailbox_count === 1 ? '' : 'es'} ` +
        `(${ATTACH_TO_LABELS[v.attach_to] ?? v.attach_to}).`,
    });
  }

  items.push({
    text: `Target live date: ${req.timeline} — schedule the kickoff call with ${firstName(req.contact_name)}.`,
  });

  if (items.length > 8 && vvmIndex >= 0) items.splice(vvmIndex, 1);
  return items.slice(0, 8);
}
