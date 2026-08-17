import {
  useCallback,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react';
import { ArrowRight, Check, CheckCircle, Lock, X } from 'lucide-react';
import { submitOnboardingRequest } from '../../api/onboarding';
import { ApiError } from '../../api/client';
import { LandingSelect } from './LandingSelect';
import { normalizeNumberInput } from '../../utils/phone';
import { validateIpOrCidr } from '../../utils/ip';
import {
  ATTACH_TO_LABELS,
  GOV_ID_TYPE_LABELS,
  INTENDED_USE_LABELS,
  PRODUCT_ORDER,
  type KycGovIdType,
  type KycIntendedUse,
  type KycPayload,
  type ProductKey,
  type ProductsPayload,
  type VoicemailAttachTo,
} from '../../types/onboarding';

/* ─────────────────────────────────────────────────────────────
   Landing intake band — "#request-access".

   Wide, single-form replacement for the sidebar AccessRequestForm
   wizard, extended with FCC Know-Your-Customer capture (FCC 26-27
   FNPRM, form_version fcc-26-27-fnprm-v2): a "Business verification"
   group (legal name, physical address, government ID, alternate
   phone), REQUIRED capacity declarations (peak CPS + peak concurrent
   call paths, under "Products & requirements"), and a "High-volume
   calling" group (intended use + originating IPs) — voluntary below
   Granite's thresholds, forced on and locked above them: more than
   1 call/sec OR more than 1,000 concurrent call paths (the backend
   422s over-threshold submissions without the HV block; monthly
   volume is informational only).
   Layout: a shallow header row (identity copy + TED card), then a
   full-width panel with two parallel form tracks — WHO THEY ARE left
   (Contact + Business verification/KYC), WHAT THEY NEED right (product
   picker + per-product setup blocks, then Capacity & timeline, then
   the input-driven High-volume declaration) — stacking identity-first
   below ~1000px. The products group (products-v1) is a multi-select
   card picker (RCF / Trunking / API / Voicemail); each selection
   reveals a compact titled sub-block of setup fields. ONE unified
   IP-chip field (visible when trunking is selected OR high-volume is
   on; label/helper adapt) feeds BOTH payload slots on submit:
   products.trunk.signaling_ips (cap 10 whenever trunk is selected)
   and kyc.high_volume.originating_ips (cap 20 otherwise). Company
   name is no longer asked directly — it's populated from the KYC
   legal business name. Client-side validation mirrors the backend so
   most 422s never happen. Success renders a composed receipt —
   request #, product chips, high-volume status, TED next steps.
   Styling lives in index.css ("LANDING PAGE").
   ───────────────────────────────────────────────────────────── */

/* ─── Form model (top-level mirrors AccessRequestForm) ─────── */

interface IntakeForm {
  contact_name: string;
  email: string;
  phone: string;
  /* Product selection + per-product setup (products-v1) */
  products: ProductKey[];
  /* RCF (former top-level requirements — mirrored on submit) */
  did_count: string;
  porting: string;
  current_carrier: string;
  forwarding_setup: string;
  /* SIP Trunking — signaling IPs come from the unified originating_ips
     field below (one input feeds both payload slots) */
  trunk_call_paths: string;
  trunk_pbx_vendor: string;
  trunk_dids_needed: string;
  /* API Calling */
  api_use_case: string;
  api_expected_cps: string;
  api_webhook_url: string;
  api_needs_numbers: boolean;
  /* Visual Voicemail */
  vm_mailbox_count: string;
  vm_attach_to: string; // human label
  /* Global sizing — capacity declarations are REQUIRED (KYC v2) and drive
     Granite's high-volume threshold; monthly volume is informational. */
  declared_peak_cps: string;
  declared_max_concurrent_calls: string;
  monthly_volume: string;
  timeline: string;
  /* KYC — business verification (labels for selects, raw text otherwise) */
  legal_business_name: string;
  address_line1: string;
  address_line2: string;
  city: string;
  state: string; // "MA — Massachusetts" option label
  postal_code: string;
  address_is_registered_agent_or_virtual: boolean;
  gov_id_type: string; // human label
  gov_id_number: string;
  state_of_registration: string; // option label
  alternate_phone: string;
  website: string;
  /* KYC — high-volume declaration */
  is_high_volume: boolean;
  intended_use: string; // human label
  intended_use_description: string;
  /* UNIFIED IP capture — one IpChipInput that fills BOTH payload slots:
     products.trunk.signaling_ips (when trunk is selected, cap 10) and
     kyc.high_volume.originating_ips (when high-volume is on, cap 20).
     Server 422s from either loc land on this single field. */
  originating_ips: string[];
  expected_daily_calls: string;
}

type FieldErrors = Partial<Record<keyof IntakeForm, string>>;

const EMPTY_FORM: IntakeForm = {
  contact_name: '',
  email: '',
  phone: '',
  products: [],
  did_count: '',
  porting: '',
  current_carrier: '',
  forwarding_setup: '',
  trunk_call_paths: '',
  trunk_pbx_vendor: '',
  trunk_dids_needed: '',
  api_use_case: '',
  api_expected_cps: '',
  api_webhook_url: '',
  api_needs_numbers: false,
  vm_mailbox_count: '',
  vm_attach_to: '',
  declared_peak_cps: '',
  declared_max_concurrent_calls: '',
  monthly_volume: '',
  timeline: '',
  legal_business_name: '',
  address_line1: '',
  address_line2: '',
  city: '',
  state: '',
  postal_code: '',
  address_is_registered_agent_or_virtual: false,
  gov_id_type: '',
  gov_id_number: '',
  state_of_registration: '',
  alternate_phone: '',
  website: '',
  is_high_volume: false,
  intended_use: '',
  intended_use_description: '',
  originating_ips: [],
  expected_daily_calls: '',
};

const DID_COUNT_OPTIONS = ['1–10', '11–50', '51–200', '201–1,000', '1,000+'];

const PORTING_OPTIONS = [
  'Yes — porting from another carrier',
  'No — need new numbers',
  'Both — porting some + new numbers',
];

const FORWARDING_OPTIONS = [
  'All numbers forward to one destination',
  'Each number forwards to a different destination',
  'Need help deciding',
];

const VOLUME_OPTIONS = [
  'Under 1,000 calls',
  '1,000–10,000',
  '10,000–50,000',
  '50,000+',
];

/* Granite's defined high-volume thresholds (fcc-26-27-fnprm-v2). The FCC's
   KYC FNPRM (FCC 26-27) requires enhanced KYC for high-volume calling but
   leaves the numeric threshold to each provider — Granite's: MORE than
   1 call per second, OR MORE than 1,000 concurrent call paths (strictly
   greater — exactly 1 CPS / exactly 1,000 paths is not high-volume).
   Crossing EITHER makes the declaration REQUIRED: the toggle locks on and
   the backend 422s over-threshold submissions without the high_volume
   block. Monthly volume no longer triggers anything — informational only. */
const HV_CPS_THRESHOLD = 1;
const HV_CONCURRENT_THRESHOLD = 1000;

/** Live lock trigger — true when the declared capacity exceeds Granite's
    high-volume threshold. Mirrors the backend's strict > comparisons; blank
    or non-numeric input (Number('') → 0, NaN fails >) never locks. */
function capacityOverThreshold(cpsRaw: string, concurrentRaw: string): boolean {
  return (
    Number(cpsRaw) > HV_CPS_THRESHOLD ||
    Number(concurrentRaw) > HV_CONCURRENT_THRESHOLD
  );
}

const TIMELINE_OPTIONS = [
  'ASAP',
  'Within 30 days',
  '1–3 months',
  'Just exploring',
];

/* ─── Product picker (products-v1) ───────────────────────────
   Multi-select toggle cards; each selection reveals a compact
   titled sub-block of setup fields, in PRODUCT_ORDER. */

const PRODUCT_CARDS: Record<ProductKey, { name: string; desc: string }> = {
  rcf: {
    // One-line title like its row-mates — the sub-block title (and chips
    // elsewhere) carry the RCF shorthand.
    name: 'Remote Call Forwarding',
    desc: 'Numbers that forward anywhere on the PSTN',
  },
  trunk: {
    name: 'SIP Trunking',
    desc: 'IP-authenticated trunks to your PBX or SBC',
  },
  api: {
    name: 'API Calling',
    desc: 'Programmable voice via REST + webhooks',
  },
  voicemail: {
    name: 'Visual Voicemail',
    desc: 'Mailboxes with transcription, per number',
  },
};

/** Per-product form fields — cleared of errors when a product is toggled. */
const PRODUCT_FIELDS: Record<ProductKey, Array<keyof IntakeForm>> = {
  rcf: ['did_count', 'porting', 'current_carrier', 'forwarding_setup'],
  trunk: [
    // originating_ips is the unified IP field — trunk's signaling-IP
    // requirement is one of its two consumers, so toggling trunk clears
    // any stale error on it (it re-validates on submit either way).
    'originating_ips',
    'trunk_call_paths',
    'trunk_pbx_vendor',
    'trunk_dids_needed',
  ],
  api: ['api_use_case', 'api_expected_cps', 'api_webhook_url'],
  voicemail: ['vm_mailbox_count', 'vm_attach_to'],
};

const ATTACH_TO_OPTIONS = Object.values(ATTACH_TO_LABELS);

function attachToFromLabel(label: string): VoicemailAttachTo | null {
  const found = (
    Object.entries(ATTACH_TO_LABELS) as Array<[VoicemailAttachTo, string]>
  ).find(([, l]) => l === label);
  return found ? found[0] : null;
}

const MAX_TRUNK_IPS = 10;
const USE_CASE_MAX = 300;
/** Mirrors the backend's basic webhook_url check (http(s) + plausible host). */
const WEBHOOK_URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d+)?(\/\S*)?$/;

/** Integer-in-range check for the numeric product fields. */
function intInRange(raw: string, min: number, max: number): string | null {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return 'Enter a whole number';
  if (n < min || n > max) {
    return `Must be ${min.toLocaleString('en-US')}–${max.toLocaleString('en-US')}`;
  }
  return null;
}

/* ─── KYC option lists ───────────────────────────────────────
   Codes-first state labels so LandingSelect typeahead matches
   "ma" → MA directly; the 2-letter code is sliced off on submit. */

const US_STATE_OPTIONS = [
  'AL — Alabama', 'AK — Alaska', 'AZ — Arizona', 'AR — Arkansas',
  'CA — California', 'CO — Colorado', 'CT — Connecticut', 'DE — Delaware',
  'DC — District of Columbia', 'FL — Florida', 'GA — Georgia', 'HI — Hawaii',
  'ID — Idaho', 'IL — Illinois', 'IN — Indiana', 'IA — Iowa', 'KS — Kansas',
  'KY — Kentucky', 'LA — Louisiana', 'ME — Maine', 'MD — Maryland',
  'MA — Massachusetts', 'MI — Michigan', 'MN — Minnesota', 'MS — Mississippi',
  'MO — Missouri', 'MT — Montana', 'NE — Nebraska', 'NV — Nevada',
  'NH — New Hampshire', 'NJ — New Jersey', 'NM — New Mexico', 'NY — New York',
  'NC — North Carolina', 'ND — North Dakota', 'OH — Ohio', 'OK — Oklahoma',
  'OR — Oregon', 'PA — Pennsylvania', 'PR — Puerto Rico', 'RI — Rhode Island',
  'SC — South Carolina', 'SD — South Dakota', 'TN — Tennessee', 'TX — Texas',
  'UT — Utah', 'VT — Vermont', 'VA — Virginia', 'WA — Washington',
  'WV — West Virginia', 'WI — Wisconsin', 'WY — Wyoming',
];

/** "MA — Massachusetts" → "MA". */
function stateCode(label: string): string {
  return label.slice(0, 2);
}

const GOV_ID_OPTIONS = Object.values(GOV_ID_TYPE_LABELS);

function govIdTypeFromLabel(label: string): KycGovIdType | null {
  const found = (
    Object.entries(GOV_ID_TYPE_LABELS) as Array<[KycGovIdType, string]>
  ).find(([, l]) => l === label);
  return found ? found[0] : null;
}

/** Placeholder + inline format hint for the ID-number input, per ID type. */
const GOV_ID_HINTS: Record<KycGovIdType, { placeholder: string; hint: string }> = {
  ein: { placeholder: '12-3456789', hint: 'IRS format NN-NNNNNNN' },
  state_registration: {
    placeholder: 'e.g. 001234567',
    hint: 'Secretary of State entity / filing number',
  },
  duns: { placeholder: 'e.g. 150483782', hint: '9-digit D-U-N-S number' },
  other: {
    placeholder: 'Identifier',
    hint: 'Any government-issued business identifier',
  },
};

const INTENDED_USE_OPTIONS = Object.values(INTENDED_USE_LABELS);

function intendedUseFromLabel(label: string): KycIntendedUse | null {
  const found = (
    Object.entries(INTENDED_USE_LABELS) as Array<[KycIntendedUse, string]>
  ).find(([, l]) => l === label);
  return found ? found[0] : null;
}

const EIN_RE = /^\d{2}-\d{7}$/;
const DESCRIPTION_MAX = 500;
const MAX_IPS = 20;

/* ─── Validation (mirrors the backend Pydantic rules) ──────── */

function portingRequiresCarrier(porting: string): boolean {
  return porting.startsWith('Yes') || porting.startsWith('Both');
}

/** Compare two phone inputs the way the backend does: canonical E.164 when
    both normalize, digits-only fallback otherwise. */
function phonesMatch(a: string, b: string): boolean {
  const normA = normalizeNumberInput(a);
  const normB = normalizeNumberInput(b);
  if (normA.startsWith('+') && normB.startsWith('+')) return normA === normB;
  const digits = (s: string) => s.replace(/\D/g, '');
  return digits(a) !== '' && digits(a) === digits(b);
}

function validate(data: IntakeForm): FieldErrors {
  const errs: FieldErrors = {};

  /* Contact */
  if (!data.contact_name.trim()) errs.contact_name = 'Required';
  if (!data.email.trim()) errs.email = 'Required';
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) errs.email = 'Invalid email';
  if (!data.phone.trim()) errs.phone = 'Required';

  /* Products & requirements — required blocks mirror the backend
     ProductsPayload rules (block present iff product selected). */
  if (data.products.length === 0) {
    errs.products = 'Select at least one product';
  }

  if (data.products.includes('rcf')) {
    if (!data.did_count) errs.did_count = 'Please select an option';
    if (!data.porting) errs.porting = 'Please select an option';
    if (portingRequiresCarrier(data.porting) && !data.current_carrier.trim()) {
      errs.current_carrier = 'Required when porting numbers';
    }
    if (!data.forwarding_setup) errs.forwarding_setup = 'Please select an option';
  }

  if (data.products.includes('trunk')) {
    if (!data.trunk_call_paths.trim()) {
      errs.trunk_call_paths = 'Required';
    } else {
      const rangeErr = intInRange(data.trunk_call_paths.trim(), 1, 1000);
      if (rangeErr) errs.trunk_call_paths = rangeErr;
    }
  }

  if (data.products.includes('api')) {
    if (!data.api_use_case.trim()) {
      errs.api_use_case = 'Required';
    } else if (data.api_use_case.trim().length > USE_CASE_MAX) {
      errs.api_use_case = `Maximum ${USE_CASE_MAX} characters`;
    }
    if (data.api_expected_cps.trim()) {
      const rangeErr = intInRange(data.api_expected_cps.trim(), 1, 1000);
      if (rangeErr) errs.api_expected_cps = rangeErr;
    }
    if (data.api_webhook_url.trim() && !WEBHOOK_URL_RE.test(data.api_webhook_url.trim())) {
      errs.api_webhook_url = 'Enter a valid http(s):// URL';
    }
  }

  if (data.products.includes('voicemail')) {
    if (!data.vm_mailbox_count.trim()) {
      errs.vm_mailbox_count = 'Required';
    } else {
      const rangeErr = intInRange(data.vm_mailbox_count.trim(), 1, 10_000);
      if (rangeErr) errs.vm_mailbox_count = rangeErr;
    }
    if (!attachToFromLabel(data.vm_attach_to)) {
      errs.vm_attach_to = 'Please select an option';
    }
  }

  /* Capacity declarations — REQUIRED (KYC v2), mirror the backend ranges. */
  if (!data.declared_peak_cps.trim()) {
    errs.declared_peak_cps = 'Required';
  } else {
    const rangeErr = intInRange(data.declared_peak_cps.trim(), 1, 1000);
    if (rangeErr) errs.declared_peak_cps = rangeErr;
  }
  if (!data.declared_max_concurrent_calls.trim()) {
    errs.declared_max_concurrent_calls = 'Required';
  } else {
    const rangeErr = intInRange(
      data.declared_max_concurrent_calls.trim(),
      1,
      100_000,
    );
    if (rangeErr) errs.declared_max_concurrent_calls = rangeErr;
  }

  if (!data.monthly_volume) errs.monthly_volume = 'Please select an option';
  if (!data.timeline) errs.timeline = 'Please select an option';

  /* Granite's FCC-KYC high-volume threshold — the UI locks the toggle on
     above 1 CPS / 1,000 call paths, so this only fires if that invariant is
     ever broken (belt and braces against a backend 422). */
  if (
    capacityOverThreshold(
      data.declared_peak_cps,
      data.declared_max_concurrent_calls,
    ) &&
    !data.is_high_volume
  ) {
    errs.declared_peak_cps =
      'The high-volume declaration is required above 1 call/sec or 1,000 concurrent call paths';
  }

  /* Business verification */
  if (!data.legal_business_name.trim()) errs.legal_business_name = 'Required';
  if (!data.address_line1.trim()) errs.address_line1 = 'Required';
  if (!data.city.trim()) errs.city = 'Required';
  if (!data.state) errs.state = 'Please select a state';
  if (!data.postal_code.trim()) errs.postal_code = 'Required';
  else if (data.postal_code.trim().length < 3) errs.postal_code = 'Too short';

  const govType = govIdTypeFromLabel(data.gov_id_type);
  if (!govType) {
    errs.gov_id_type = 'Please select an ID type';
  }
  const govId = data.gov_id_number.trim();
  if (!govId) {
    errs.gov_id_number = 'Required';
  } else if (govType === 'ein' && !EIN_RE.test(govId)) {
    errs.gov_id_number = 'EIN must be NN-NNNNNNN';
  } else if (govType !== 'ein' && (govId.length < 2 || govId.length > 40)) {
    errs.gov_id_number = 'Must be 2–40 characters';
  }
  if (govType === 'state_registration' && !data.state_of_registration) {
    errs.state_of_registration = 'Required for state registrations';
  }

  const altRaw = data.alternate_phone.trim();
  if (!altRaw) {
    errs.alternate_phone = 'Required';
  } else if (!/^\+\d{8,15}$/.test(normalizeNumberInput(altRaw))) {
    errs.alternate_phone = 'Enter a full phone number';
  } else if (data.phone.trim() && phonesMatch(data.phone, altRaw)) {
    errs.alternate_phone = 'Must differ from the primary phone';
  }

  /* Unified IP field — required whenever either consumer needs it:
     trunk selected (IP-authenticated signaling) or high-volume on (FCC
     originating IPs). Trunk's tighter backend cap (10 vs 20) applies
     whenever trunk is selected. */
  if (
    (data.products.includes('trunk') || data.is_high_volume) &&
    data.originating_ips.length === 0
  ) {
    errs.originating_ips = 'Add at least one IP address or CIDR block';
  } else if (
    data.products.includes('trunk') &&
    data.originating_ips.length > MAX_TRUNK_IPS
  ) {
    errs.originating_ips = `Maximum ${MAX_TRUNK_IPS} addresses when SIP Trunking is selected`;
  }

  /* High-volume declaration */
  if (data.is_high_volume) {
    const use = intendedUseFromLabel(data.intended_use);
    if (!use) errs.intended_use = 'Please select an intended use';
    if (use === 'other' && !data.intended_use_description.trim()) {
      errs.intended_use_description = 'Required when intended use is Other';
    }
    if (data.expected_daily_calls.trim()) {
      const n = Number(data.expected_daily_calls);
      if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
        errs.expected_daily_calls = 'Enter a whole number';
      } else if (n > 10_000_000) {
        errs.expected_daily_calls = 'Maximum 10,000,000';
      }
    }
  }

  return errs;
}

/* ─── Server 422 → field mapping ─────────────────────────────
   Backend errors carry precise loc paths; map them onto the form
   so validation drift still lands on the right field. Cross-field
   model_validator errors report loc at the model level, so fall
   back to message-content matching before giving up to the banner. */

const SERVER_LOC_TO_FIELD: Record<string, keyof IntakeForm> = {
  // company_name is populated from the KYC legal business name.
  company_name: 'legal_business_name',
  contact_name: 'contact_name',
  email: 'email',
  phone: 'phone',
  did_count: 'did_count',
  porting: 'porting',
  current_carrier: 'current_carrier',
  forwarding_setup: 'forwarding_setup',
  monthly_volume: 'monthly_volume',
  timeline: 'timeline',
  // products-v1 — model-level block mismatches land on the picker.
  products: 'products',
  'products.selected': 'products',
  'products.rcf.did_count': 'did_count',
  'products.rcf.porting': 'porting',
  'products.rcf.current_carrier': 'current_carrier',
  // RcfIntake model_validator (carrier required when porting) reports at
  // the block level — that's its only cross-field rule.
  'products.rcf': 'current_carrier',
  'products.rcf.forwarding_setup': 'forwarding_setup',
  // Unified IP field — BOTH backend locs (trunk signaling IPs and KYC
  // high-volume originating IPs) map onto the single chip input.
  'products.trunk.signaling_ips': 'originating_ips',
  'products.trunk.concurrent_call_paths': 'trunk_call_paths',
  'products.trunk.pbx_vendor': 'trunk_pbx_vendor',
  'products.trunk.dids_needed': 'trunk_dids_needed',
  'products.api.use_case': 'api_use_case',
  'products.api.expected_cps': 'api_expected_cps',
  'products.api.webhook_url': 'api_webhook_url',
  'products.voicemail.mailbox_count': 'vm_mailbox_count',
  'products.voicemail.attach_to': 'vm_attach_to',
  // KycPayload model_validator errors (high-volume threshold, high_volume
  // block presence) report at loc body->kyc — land them on the capacity row
  // that drives the threshold, next to the locked toggle's cause.
  kyc: 'declared_peak_cps',
  'kyc.declared_peak_cps': 'declared_peak_cps',
  'kyc.declared_max_concurrent_calls': 'declared_max_concurrent_calls',
  'kyc.standard.legal_business_name': 'legal_business_name',
  'kyc.standard.address_line1': 'address_line1',
  'kyc.standard.address_line2': 'address_line2',
  'kyc.standard.city': 'city',
  'kyc.standard.state': 'state',
  'kyc.standard.postal_code': 'postal_code',
  'kyc.standard.gov_id_type': 'gov_id_type',
  'kyc.standard.gov_id_number': 'gov_id_number',
  'kyc.standard.state_of_registration': 'state_of_registration',
  'kyc.standard.alternate_phone': 'alternate_phone',
  'kyc.standard.website': 'website',
  'kyc.high_volume.intended_use': 'intended_use',
  'kyc.high_volume.intended_use_description': 'intended_use_description',
  'kyc.high_volume.originating_ips': 'originating_ips',
  'kyc.high_volume.expected_daily_calls': 'expected_daily_calls',
};

const FUZZY_FIELD_PATTERNS: Array<[RegExp, keyof IntakeForm]> = [
  // Threshold model_validator (is_high_volume required above 1 CPS / 1,000
  // concurrent call paths) reports at body->kyc — land it on the capacity
  // pair that drives the threshold.
  [/is_high_volume|high-volume threshold/i, 'declared_peak_cps'],
  [/declared_peak_cps/i, 'declared_peak_cps'],
  [/declared_max_concurrent_calls/i, 'declared_max_concurrent_calls'],
  [/alternate_phone/i, 'alternate_phone'],
  [/state_of_registration/i, 'state_of_registration'],
  [/gov_id_number|EIN/i, 'gov_id_number'],
  [/intended_use_description/i, 'intended_use_description'],
  // Both IP locs fuzz to the one unified chip field.
  [/signaling_ips|originating_ips|CIDR|IP address/i, 'originating_ips'],
  [/current_carrier/i, 'current_carrier'],
  [/webhook_url/i, 'api_webhook_url'],
  [/products\.\w+ (is required|must be null)|selected/i, 'products'],
];

function mapServerErrors(raw: unknown): { fields: FieldErrors; leftover: string[] } {
  const fields: FieldErrors = {};
  const leftover: string[] = [];
  const detail =
    typeof raw === 'object' && raw !== null
      ? (raw as { detail?: unknown }).detail
      : undefined;
  if (!Array.isArray(detail)) return { fields, leftover };

  for (const item of detail) {
    if (typeof item !== 'object' || item === null) {
      leftover.push(String(item));
      continue;
    }
    const err = item as { loc?: unknown; msg?: unknown };
    const msg = (typeof err.msg === 'string' ? err.msg : 'Invalid value').replace(
      /^Value error,\s*/,
      '',
    );
    // Drop 'body' and numeric list indexes (e.g. originating_ips.3).
    const locPath = Array.isArray(err.loc)
      ? err.loc.filter((p): p is string => typeof p === 'string' && p !== 'body').join('.')
      : '';
    let field: keyof IntakeForm | undefined = SERVER_LOC_TO_FIELD[locPath];
    if (!field) {
      field = FUZZY_FIELD_PATTERNS.find(([re]) => re.test(`${locPath} ${msg}`))?.[1];
    }
    if (field) fields[field] = msg;
    else leftover.push(msg);
  }
  return { fields, leftover };
}

/* ─── Field wrapper ──────────────────────────────────────────
   Two fixed slots — label, then a .landing-field-body holding the
   control + error/hint. Inside .landing-intake-fields the field
   subgrids these two slots onto shared parent rows, so paired
   fields keep their controls on the same pixel even if one label
   wraps (see "Pixel-perfect paired rows" in index.css). */

function Field({
  id,
  label,
  error,
  hint,
  full,
  children,
}: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  full?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={full ? 'landing-field landing-field-full' : 'landing-field'}>
      <label className="landing-label" id={`${id}-label`} htmlFor={id}>
        {label}
      </label>
      <div className="landing-field-body">
        {children}
        {error ? (
          <span className="landing-field-err">{error}</span>
        ) : (
          hint && <span className="landing-field-hint">{hint}</span>
        )}
      </div>
    </div>
  );
}

function inputClass(hasError: boolean): string {
  return hasError ? 'landing-input landing-input-invalid' : 'landing-input';
}

/* ─── Originating-IP chip input ──────────────────────────────
   Type an IPv4/IPv6 address or CIDR block, Enter/comma to add,
   ×-remove. Syntax mirrors the backend (max 20, /24 v4 & /64 v6
   floors). Entry errors render inline below the chip well. */

function IpChipInput({
  id,
  ips,
  disabled,
  invalid,
  maxIps = MAX_IPS,
  onChange,
}: {
  id: string;
  ips: string[];
  disabled?: boolean;
  invalid?: boolean;
  /** Entry cap — 20 for KYC originating IPs, 10 for trunk signaling IPs. */
  maxIps?: number;
  onChange: (ips: string[]) => void;
}) {
  // All hooks unconditionally at the top — React #310 prevention.
  const [draft, setDraft] = useState('');
  const [entryError, setEntryError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const commit = useCallback(
    (raw: string) => {
      // Comma-separated paste support: validate each entry independently.
      const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
      if (parts.length === 0) {
        setDraft('');
        return;
      }
      let next = ips;
      for (const part of parts) {
        const result = validateIpOrCidr(part);
        if (!result.ok) {
          setEntryError(result.error);
          return;
        }
        if (next.includes(result.value)) continue; // silent dedupe
        if (next.length >= maxIps) {
          setEntryError(`Maximum ${maxIps} addresses`);
          return;
        }
        next = [...next, result.value];
      }
      if (next !== ips) onChange(next);
      setDraft('');
      setEntryError(null);
    },
    [ips, maxIps, onChange],
  );

  const handleKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        commit(draft);
      } else if (e.key === 'Backspace' && draft === '' && ips.length > 0) {
        onChange(ips.slice(0, -1));
        setEntryError(null);
      }
    },
    [commit, draft, ips, onChange],
  );

  const wellClass = [
    'landing-chipfield',
    invalid || entryError ? 'landing-chipfield-invalid' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      {/* Click-to-focus convenience — the inner input is the interactive element */}
      <div className={wellClass} onClick={() => inputRef.current?.focus()}>
        {ips.map((ip) => (
          <span key={ip} className="landing-chip-ip">
            {ip}
            <button
              type="button"
              aria-label={`Remove ${ip}`}
              disabled={disabled}
              onClick={(e) => {
                e.stopPropagation();
                onChange(ips.filter((x) => x !== ip));
                setEntryError(null);
              }}
            >
              <X size={12} strokeWidth={2.5} />
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          id={id}
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={ips.length === 0 ? '203.0.113.10, 198.51.100.0/24…' : ''}
          value={draft}
          disabled={disabled || ips.length >= maxIps}
          onChange={(e) => {
            setDraft(e.target.value);
            setEntryError(null);
          }}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            if (draft.trim()) commit(draft);
          }}
        />
      </div>
      {entryError && <span className="landing-field-err">{entryError}</span>}
    </>
  );
}

/* ─── Section ────────────────────────────────────────────── */

/** What the success receipt shows — captured from the 200 response (id)
    plus the submitted form (products, high-volume status). */
interface SubmissionReceipt {
  id: number;
  products: ProductKey[];
  highVolume: boolean;
}

export function RequestAccessSection() {
  // All hooks unconditionally at the top — React #310 prevention.
  const [form, setForm] = useState<IntakeForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [submitting, setSubmitting] = useState(false);
  // Non-null once the POST succeeds — drives the composed success receipt.
  const [receipt, setReceipt] = useState<SubmissionReceipt | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // True once the user explicitly flips the high-volume switch; below the
  // threshold their choice is theirs — capacity changes never override it.
  const hvTouched = useRef(false);
  // The user's own switch position from before the capacity lock (>1 CPS or
  // >1,000 concurrent call paths) forced it on, restored when the declared
  // capacity drops back to/below Granite's thresholds.
  const hvBeforeLock = useRef(false);

  const handleChange = useCallback(
    <K extends keyof IntakeForm>(field: K, value: IntakeForm[K]) => {
      setForm((prev) => {
        const next = { ...prev, [field]: value };
        // Granite's FCC-KYC thresholds (FCC 26-27 leaves the numbers to the
        // provider): above 1 CPS or 1,000 concurrent call paths the
        // declaration is required — force the switch on and lock it, live as
        // the capacity numbers are typed. Dropping back to/below both
        // thresholds restores the user's own choice (or off if they never
        // touched the switch).
        if (
          field === 'declared_peak_cps' ||
          field === 'declared_max_concurrent_calls'
        ) {
          const wasLocked = capacityOverThreshold(
            prev.declared_peak_cps,
            prev.declared_max_concurrent_calls,
          );
          const nowLocked = capacityOverThreshold(
            next.declared_peak_cps,
            next.declared_max_concurrent_calls,
          );
          if (nowLocked) {
            if (!wasLocked) hvBeforeLock.current = prev.is_high_volume;
            next.is_high_volume = true;
          } else if (wasLocked) {
            next.is_high_volume = hvTouched.current ? hvBeforeLock.current : false;
          }
        }
        return next;
      });
      setErrors((prev) => {
        if (!prev[field]) return prev;
        const next = { ...prev };
        delete next[field];
        return next;
      });
    },
    [],
  );

  /** Toggle a product card; clears the picker error and any stale errors
      on that product's own fields. */
  const toggleProduct = useCallback((key: ProductKey) => {
    setForm((prev) => ({
      ...prev,
      products: prev.products.includes(key)
        ? prev.products.filter((p) => p !== key)
        : [...prev.products, key],
    }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next.products;
      for (const field of PRODUCT_FIELDS[key]) delete next[field];
      return next;
    });
  }, []);

  const handleHighVolumeToggle = useCallback((checked: boolean) => {
    hvTouched.current = true;
    setForm((prev) => ({ ...prev, is_high_volume: checked }));
    setErrors((prev) => {
      const next = { ...prev };
      delete next.intended_use;
      delete next.intended_use_description;
      delete next.originating_ips;
      delete next.expected_daily_calls;
      return next;
    });
  }, []);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      if (submitting) return;
      const errs = validate(form);
      if (Object.keys(errs).length > 0) {
        setErrors(errs);
        // The picker sits far above the submit button — echo a missing
        // product selection in the banner so the miss is visible from the CTA.
        setSubmitError(
          errs.products
            ? 'Select at least one product under “Products & requirements”.'
            : null,
        );
        return;
      }
      setErrors({});
      setSubmitting(true);
      setSubmitError(null);

      // validate() guarantees these resolve; keep the compiler honest.
      const govType = govIdTypeFromLabel(form.gov_id_type) ?? 'other';
      const intendedUse = intendedUseFromLabel(form.intended_use) ?? 'other';

      const kyc: KycPayload = {
        is_high_volume: form.is_high_volume,
        // Capacity declarations (v2) — validate() guarantees both parse as
        // in-range integers before this runs.
        declared_peak_cps: Number(form.declared_peak_cps),
        declared_max_concurrent_calls: Number(form.declared_max_concurrent_calls),
        standard: {
          legal_business_name: form.legal_business_name.trim(),
          address_line1: form.address_line1.trim(),
          address_line2: form.address_line2.trim() || undefined,
          city: form.city.trim(),
          state: stateCode(form.state),
          postal_code: form.postal_code.trim(),
          address_is_registered_agent_or_virtual:
            form.address_is_registered_agent_or_virtual,
          gov_id_type: govType,
          gov_id_number: form.gov_id_number.trim(),
          state_of_registration: form.state_of_registration
            ? stateCode(form.state_of_registration)
            : undefined,
          alternate_phone: normalizeNumberInput(form.alternate_phone),
          website: form.website.trim() || undefined,
        },
        high_volume: form.is_high_volume
          ? {
              intended_use: intendedUse,
              intended_use_description:
                form.intended_use_description.trim() || undefined,
              originating_ips: form.originating_ips,
              expected_daily_calls: form.expected_daily_calls.trim()
                ? Number(form.expected_daily_calls)
                : undefined,
            }
          : null,
      };

      // Products payload — blocks present iff selected (backend 422s
      // otherwise); selection normalized to the stable display order.
      const selectedProducts = PRODUCT_ORDER.filter((p) =>
        form.products.includes(p),
      );
      const rcfSelected = selectedProducts.includes('rcf');
      const products: ProductsPayload = {
        selected: selectedProducts,
        rcf: rcfSelected
          ? {
              did_count: form.did_count,
              porting: form.porting,
              current_carrier: form.current_carrier.trim() || undefined,
              forwarding_setup: form.forwarding_setup,
            }
          : null,
        trunk: selectedProducts.includes('trunk')
          ? {
              // Unified IP field — the same entries also fill
              // kyc.high_volume.originating_ips when high-volume is on.
              signaling_ips: form.originating_ips,
              concurrent_call_paths: Number(form.trunk_call_paths),
              pbx_vendor: form.trunk_pbx_vendor.trim() || undefined,
              dids_needed: form.trunk_dids_needed.trim() || undefined,
            }
          : null,
        api: selectedProducts.includes('api')
          ? {
              use_case: form.api_use_case.trim(),
              expected_cps: form.api_expected_cps.trim()
                ? Number(form.api_expected_cps)
                : undefined,
              webhook_url: form.api_webhook_url.trim() || undefined,
              needs_numbers: form.api_needs_numbers,
            }
          : null,
        voicemail: selectedProducts.includes('voicemail')
          ? {
              mailbox_count: Number(form.vm_mailbox_count),
              attach_to: attachToFromLabel(form.vm_attach_to) ?? 'unsure',
            }
          : null,
      };

      try {
        const created = await submitOnboardingRequest({
          // The FCC KYC legal business name IS the company name.
          company_name: form.legal_business_name.trim(),
          contact_name: form.contact_name,
          email: form.email,
          // Human contact field, not a routable DID — light touch, just trim.
          phone: form.phone.trim(),
          // Legacy top-level RCF mirror — only when RCF is selected.
          did_count: rcfSelected ? form.did_count : undefined,
          porting: rcfSelected ? form.porting : undefined,
          current_carrier:
            rcfSelected && form.current_carrier.trim()
              ? form.current_carrier.trim()
              : undefined,
          forwarding_setup: rcfSelected ? form.forwarding_setup : undefined,
          monthly_volume: form.monthly_volume,
          timeline: form.timeline,
          kyc,
          products,
        });
        setReceipt({
          id: created.id,
          products: selectedProducts,
          highVolume: form.is_high_volume,
        });
      } catch (err) {
        // Map precise backend 422 field messages onto the form; anything
        // that can't be attributed to a field falls back to the banner.
        if (err instanceof ApiError && err.status === 422) {
          const { fields, leftover } = mapServerErrors(err.raw);
          if (Object.keys(fields).length > 0) {
            setErrors(fields);
            setSubmitError(
              leftover.length > 0
                ? leftover.join(' · ')
                : 'Please review the highlighted fields.',
            );
          } else {
            setSubmitError(err.message || 'Submission failed. Please try again.');
          }
        } else {
          setSubmitError(
            err instanceof Error && err.message
              ? err.message
              : 'Submission failed. Please try again.',
          );
        }
      } finally {
        setSubmitting(false);
      }
    },
    [form, submitting],
  );

  const handleReset = useCallback(() => {
    setForm(EMPTY_FORM);
    setErrors({});
    setReceipt(null);
    setSubmitError(null);
    hvTouched.current = false;
    hvBeforeLock.current = false;
  }, []);

  const showCarrier = portingRequiresCarrier(form.porting);
  const govType = govIdTypeFromLabel(form.gov_id_type);
  const govIdHint = govType ? GOV_ID_HINTS[govType] : null;
  const intendedUse = intendedUseFromLabel(form.intended_use);
  const descriptionRequired = intendedUse === 'other';
  // Above Granite's capacity thresholds (>1 CPS or >1,000 concurrent call
  // paths) the declaration is mandatory — the switch is forced on and locked
  // (handleChange keeps is_high_volume true).
  const hvLocked = capacityOverThreshold(
    form.declared_peak_cps,
    form.declared_max_concurrent_calls,
  );

  /* Unified IP field — ONE IpChipInput serving two payload consumers.
     Visible when either needs it; the tighter trunk cap (10) governs
     whenever trunk is selected; label + helper adapt to who's asking. */
  const trunkSelected = form.products.includes('trunk');
  const ipFieldVisible = trunkSelected || form.is_high_volume;
  const ipFieldMax = trunkSelected ? MAX_TRUNK_IPS : MAX_IPS;
  const ipFieldLabel = trunkSelected
    ? form.is_high_volume
      ? 'Signaling & originating IP addresses'
      : 'Signaling IP addresses'
    : 'Originating IP addresses';
  const ipFieldHint = trunkSelected
    ? form.is_high_volume
      ? 'Public signaling IPs of your PBX/SBC — used for IP authentication; the same addresses satisfy the FCC originating-IP requirement for high-volume callers. Enter or comma to add, up to 10.'
      : 'Public signaling IPs of your PBX/SBC — used for IP authentication. Enter or comma to add, up to 10.'
    : 'IPv4, IPv6, or CIDR blocks your calls originate from — the FCC originating-IP requirement for high-volume callers. Enter or comma to add, up to 20.';

  return (
    <section
      className="landing-band landing-band-cobalt landing-intake"
      id="request-access"
    >
      <div className="landing-wrap">
        {/* ── Header row — identity left, TED presence right ── */}
        <div className="landing-intake-head">
          <div>
            <span className="landing-kicker landing-kicker-inverse">
              Get started
            </span>
            <h2 className="landing-h2">Bring your traffic.</h2>
            <p className="landing-blurb">
              Tell us about your numbers, your volume, and where calls need to
              land. Your request goes to work the moment you submit — porting,
              forwarding, and cutover included.
            </p>
            <ul className="landing-intake-points">
              <li>Intake starts the moment you submit</li>
              <li>Porting managed end to end by Granite</li>
              <li>Talk directly to the engineers who run the network</li>
            </ul>
          </div>
          <div className="landing-ted">
            <span className="landing-ted-mark" aria-hidden="true">
              TED
            </span>
            <div>
              <p className="landing-ted-name">
                TED
                <span className="landing-ted-role">Granite Onboarding AI</span>
              </p>
              <p className="landing-ted-line">
                TED intakes your request the moment you submit, then works
                directly with Granite Telephony Engineering to activate your
                service.
              </p>
            </div>
          </div>
        </div>

        {/* ── The intake form — intake left, KYC right ── */}
        <div className="landing-intake-panel">
          {receipt ? (
            /* ── Composed receipt — reference #, what was requested,
                high-volume status, TED next steps. ── */
            <div className="landing-intake-success" role="status">
              <span className="landing-intake-success-ring">
                <CheckCircle size={26} strokeWidth={2} />
              </span>
              <span className="landing-intake-success-ref">
                Request #{receipt.id}
              </span>
              <h3 className="landing-intake-success-title">TED has your request.</h3>
              <div
                className="landing-intake-success-chips"
                aria-label="Requested products"
              >
                {receipt.products.map((key) => (
                  <span key={key} className="landing-success-chip">
                    {PRODUCT_CARDS[key].name}
                  </span>
                ))}
                <span
                  className={
                    receipt.highVolume
                      ? 'landing-success-chip landing-success-chip-hv'
                      : 'landing-success-chip landing-success-chip-dim'
                  }
                >
                  {receipt.highVolume
                    ? 'High-volume declared'
                    : 'Standard volume'}
                </span>
              </div>
              <p className="landing-intake-success-note">
                Granite&rsquo;s Onboarding AI is processing your intake and will
                work directly with Granite Telephony Engineering to activate
                your service. Expect a follow-up within one business day —
                reference request #{receipt.id} in any correspondence.
              </p>
              <button
                type="button"
                className="landing-intake-reset"
                onClick={handleReset}
              >
                Submit another request
              </button>
            </div>
          ) : (
            <form onSubmit={handleSubmit} noValidate>
              <div className="landing-intake-columns">
                {/* ── Left track — who they are ── */}
                <div className="landing-intake-fields landing-intake-col-a">
                  <span className="landing-intake-sub landing-field-full">
                    Contact
                  </span>

                  {/* Company name comes from the KYC legal business name —
                      no separate field (it was a duplicate ask). */}
                  <Field
                    id="ra-contact"
                    label="Contact name"
                    error={errors.contact_name}
                    full
                  >
                    <input
                      id="ra-contact"
                      className={inputClass(!!errors.contact_name)}
                      type="text"
                      placeholder="John Smith"
                      autoComplete="name"
                      value={form.contact_name}
                      onChange={(e) => handleChange('contact_name', e.target.value)}
                      disabled={submitting}
                    />
                  </Field>

                  <Field id="ra-email" label="Work email" error={errors.email}>
                    <input
                      id="ra-email"
                      className={inputClass(!!errors.email)}
                      type="email"
                      placeholder="john@acme.com"
                      autoComplete="email"
                      value={form.email}
                      onChange={(e) => handleChange('email', e.target.value)}
                      disabled={submitting}
                    />
                  </Field>

                  <Field id="ra-phone" label="Phone number" error={errors.phone}>
                    <input
                      id="ra-phone"
                      className={inputClass(!!errors.phone)}
                      type="tel"
                      placeholder="+1 (617) 555-0100"
                      autoComplete="tel"
                      value={form.phone}
                      onChange={(e) => handleChange('phone', e.target.value)}
                      disabled={submitting}
                    />
                  </Field>

                  <span className="landing-intake-sub landing-field-full">
                    Business verification
                  </span>
                  <p className="landing-intake-intro landing-field-full">
                    FCC Know-Your-Customer rules require voice providers to
                    verify who is originating calls on their network. TED
                    verifies these details during intake.
                  </p>

                  <Field
                    id="ra-legalname"
                    label="Legal business name"
                    error={errors.legal_business_name}
                    full
                  >
                    <input
                      id="ra-legalname"
                      className={inputClass(!!errors.legal_business_name)}
                      type="text"
                      placeholder="Acme Corporation, Inc."
                      autoComplete="organization"
                      value={form.legal_business_name}
                      onChange={(e) => handleChange('legal_business_name', e.target.value)}
                      disabled={submitting}
                    />
                  </Field>

                  <Field
                    id="ra-addr1"
                    label="Address line 1"
                    error={errors.address_line1}
                    full
                  >
                    <input
                      id="ra-addr1"
                      className={inputClass(!!errors.address_line1)}
                      type="text"
                      placeholder="100 Newport Ave Ext"
                      autoComplete="address-line1"
                      value={form.address_line1}
                      onChange={(e) => handleChange('address_line1', e.target.value)}
                      disabled={submitting}
                    />
                  </Field>

                  <Field id="ra-addr2" label="Address line 2 (optional)" error={errors.address_line2}>
                    <input
                      id="ra-addr2"
                      className={inputClass(!!errors.address_line2)}
                      type="text"
                      placeholder="Suite 200"
                      autoComplete="address-line2"
                      value={form.address_line2}
                      onChange={(e) => handleChange('address_line2', e.target.value)}
                      disabled={submitting}
                    />
                  </Field>

                  <Field id="ra-city" label="City" error={errors.city}>
                    <input
                      id="ra-city"
                      className={inputClass(!!errors.city)}
                      type="text"
                      placeholder="Quincy"
                      autoComplete="address-level2"
                      value={form.city}
                      onChange={(e) => handleChange('city', e.target.value)}
                      disabled={submitting}
                    />
                  </Field>

                  <Field id="ra-state" label="State" error={errors.state}>
                    <LandingSelect
                      id="ra-state"
                      labelId="ra-state-label"
                      value={form.state}
                      options={US_STATE_OPTIONS}
                      placeholder="Select a state…"
                      onChange={(v) => handleChange('state', v)}
                      disabled={submitting}
                      invalid={!!errors.state}
                    />
                  </Field>

                  <Field id="ra-zip" label="ZIP code" error={errors.postal_code}>
                    <input
                      id="ra-zip"
                      className={inputClass(!!errors.postal_code)}
                      type="text"
                      placeholder="02171"
                      autoComplete="postal-code"
                      value={form.postal_code}
                      onChange={(e) => handleChange('postal_code', e.target.value)}
                      disabled={submitting}
                    />
                  </Field>

                  {/* Neutral self-disclosure, not a gate */}
                  <div className="landing-field-full">
                    <label className="landing-check">
                      <input
                        type="checkbox"
                        checked={form.address_is_registered_agent_or_virtual}
                        onChange={(e) =>
                          handleChange(
                            'address_is_registered_agent_or_virtual',
                            e.target.checked,
                          )
                        }
                        disabled={submitting}
                      />
                      <span className="landing-check-box" aria-hidden="true">
                        <Check size={13} strokeWidth={3} />
                      </span>
                      <span className="landing-check-text">
                        This address is a registered agent or virtual office
                      </span>
                    </label>
                  </div>

                  <Field id="ra-govidtype" label="Government ID type" error={errors.gov_id_type}>
                    <LandingSelect
                      id="ra-govidtype"
                      labelId="ra-govidtype-label"
                      value={form.gov_id_type}
                      options={GOV_ID_OPTIONS}
                      placeholder="Select an ID type…"
                      onChange={(v) => handleChange('gov_id_type', v)}
                      disabled={submitting}
                      invalid={!!errors.gov_id_type}
                    />
                  </Field>

                  <Field
                    id="ra-govid"
                    label="ID number"
                    error={errors.gov_id_number}
                    hint={govIdHint?.hint}
                  >
                    <input
                      id="ra-govid"
                      className={inputClass(!!errors.gov_id_number)}
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={govIdHint?.placeholder ?? 'Select an ID type first'}
                      value={form.gov_id_number}
                      onChange={(e) => handleChange('gov_id_number', e.target.value)}
                      disabled={submitting}
                    />
                  </Field>

                  {/* Required for state registrations; hidden otherwise */}
                  {govType === 'state_registration' && (
                    <Field
                      id="ra-regstate"
                      label="State of registration"
                      error={errors.state_of_registration}
                    >
                      <LandingSelect
                        id="ra-regstate"
                        labelId="ra-regstate-label"
                        value={form.state_of_registration}
                        options={US_STATE_OPTIONS}
                        placeholder="Select a state…"
                        onChange={(v) => handleChange('state_of_registration', v)}
                        disabled={submitting}
                        invalid={!!errors.state_of_registration}
                      />
                    </Field>
                  )}

                  <Field
                    id="ra-altphone"
                    label="Alternate phone"
                    error={errors.alternate_phone}
                    hint="Must differ from the primary phone above"
                  >
                    <input
                      id="ra-altphone"
                      className={inputClass(!!errors.alternate_phone)}
                      type="tel"
                      placeholder="+1 (617) 555-0199"
                      autoComplete="tel"
                      value={form.alternate_phone}
                      onChange={(e) => handleChange('alternate_phone', e.target.value)}
                      disabled={submitting}
                    />
                  </Field>

                  <Field id="ra-website" label="Website (optional)" error={errors.website}>
                    <input
                      id="ra-website"
                      className={inputClass(!!errors.website)}
                      type="url"
                      placeholder="https://acme.com"
                      autoComplete="url"
                      value={form.website}
                      onChange={(e) => handleChange('website', e.target.value)}
                      disabled={submitting}
                    />
                  </Field>
                </div>

                {/* ── Right track — what they need ── */}
                <div className="landing-intake-fields landing-intake-col-b">
                  <span className="landing-intake-sub landing-field-full">
                    Products &amp; requirements
                  </span>

                  {/* ── Product picker — multi-select toggle cards ── */}
                  <div className="landing-field landing-field-full">
                    <span className="landing-label" id="ra-products-label">
                      Which products are you interested in?
                    </span>
                    <div className="landing-field-body">
                      <div
                        className={
                          errors.products
                            ? 'landing-product-grid landing-product-grid-invalid'
                            : 'landing-product-grid'
                        }
                        role="group"
                        aria-labelledby="ra-products-label"
                      >
                        {PRODUCT_ORDER.map((key) => (
                          <button
                            key={key}
                            type="button"
                            className="landing-product-card"
                            aria-pressed={form.products.includes(key)}
                            onClick={() => toggleProduct(key)}
                            disabled={submitting}
                          >
                            <span className="landing-product-check" aria-hidden="true">
                              <Check size={12} strokeWidth={3.5} />
                            </span>
                            <span className="landing-product-name">
                              {PRODUCT_CARDS[key].name}
                            </span>
                            <span className="landing-product-desc">
                              {PRODUCT_CARDS[key].desc}
                            </span>
                          </button>
                        ))}
                      </div>
                      {errors.products && (
                        <span className="landing-field-err">{errors.products}</span>
                      )}
                    </div>
                  </div>

                  {/* ── RCF setup ── */}
                  {form.products.includes('rcf') && (
                    <div className="landing-field-full landing-product-block landing-hv-reveal">
                      <span className="landing-product-block-title">
                        RCF — Remote Call Forwarding
                      </span>
                      <div className="landing-intake-fields">
                        <Field id="ra-didcount" label="How many phone numbers?" error={errors.did_count}>
                          <LandingSelect
                            id="ra-didcount"
                            labelId="ra-didcount-label"
                            value={form.did_count}
                            options={DID_COUNT_OPTIONS}
                            placeholder="Select a range…"
                            onChange={(v) => handleChange('did_count', v)}
                            disabled={submitting}
                            invalid={!!errors.did_count}
                          />
                        </Field>

                        <Field id="ra-porting" label="Porting existing numbers?" error={errors.porting}>
                          <LandingSelect
                            id="ra-porting"
                            labelId="ra-porting-label"
                            value={form.porting}
                            options={PORTING_OPTIONS}
                            placeholder="Select an option…"
                            onChange={(v) => handleChange('porting', v)}
                            disabled={submitting}
                            invalid={!!errors.porting}
                          />
                        </Field>

                        {/* Conditional: only when porting is Yes or Both */}
                        {showCarrier && (
                          <Field
                            id="ra-carrier"
                            label="Current carrier"
                            error={errors.current_carrier}
                            full
                          >
                            <input
                              id="ra-carrier"
                              className={inputClass(!!errors.current_carrier)}
                              type="text"
                              placeholder="e.g. AT&T, Lumen, Verizon"
                              value={form.current_carrier}
                              onChange={(e) => handleChange('current_carrier', e.target.value)}
                              disabled={submitting}
                            />
                          </Field>
                        )}

                        <Field id="ra-forwarding" label="Forwarding setup" error={errors.forwarding_setup}>
                          <LandingSelect
                            id="ra-forwarding"
                            labelId="ra-forwarding-label"
                            value={form.forwarding_setup}
                            options={FORWARDING_OPTIONS}
                            placeholder="Select an option…"
                            onChange={(v) => handleChange('forwarding_setup', v)}
                            disabled={submitting}
                            invalid={!!errors.forwarding_setup}
                          />
                        </Field>
                      </div>
                    </div>
                  )}

                  {/* ── SIP Trunking setup ── */}
                  {form.products.includes('trunk') && (
                    <div className="landing-field-full landing-product-block landing-hv-reveal">
                      <span className="landing-product-block-title">
                        SIP Trunking
                      </span>
                      {/* Signaling IPs are captured once in the unified
                          "IP addresses" block below — trunks authenticate
                          by IP, no registration. */}
                      <div className="landing-intake-fields">
                        <Field id="ra-callpaths" label="Concurrent call paths" error={errors.trunk_call_paths}>
                          <input
                            id="ra-callpaths"
                            className={inputClass(!!errors.trunk_call_paths)}
                            type="number"
                            min={1}
                            max={1000}
                            step={1}
                            placeholder="20"
                            value={form.trunk_call_paths}
                            onChange={(e) => handleChange('trunk_call_paths', e.target.value)}
                            disabled={submitting}
                          />
                        </Field>

                        <Field id="ra-pbx" label="PBX vendor (optional)" error={errors.trunk_pbx_vendor}>
                          <input
                            id="ra-pbx"
                            className={inputClass(!!errors.trunk_pbx_vendor)}
                            type="text"
                            maxLength={100}
                            placeholder="e.g. Asterisk, 3CX, Avaya"
                            value={form.trunk_pbx_vendor}
                            onChange={(e) => handleChange('trunk_pbx_vendor', e.target.value)}
                            disabled={submitting}
                          />
                        </Field>

                        <Field
                          id="ra-trunkdids"
                          label="DIDs needed (optional)"
                          error={errors.trunk_dids_needed}
                          full
                        >
                          <input
                            id="ra-trunkdids"
                            className={inputClass(!!errors.trunk_dids_needed)}
                            type="text"
                            maxLength={200}
                            placeholder="e.g. 25 new numbers, Boston metro"
                            value={form.trunk_dids_needed}
                            onChange={(e) => handleChange('trunk_dids_needed', e.target.value)}
                            disabled={submitting}
                          />
                        </Field>
                      </div>
                    </div>
                  )}

                  {/* ── API Calling setup ── */}
                  {form.products.includes('api') && (
                    <div className="landing-field-full landing-product-block landing-hv-reveal">
                      <span className="landing-product-block-title">
                        API Calling
                      </span>
                      <div className="landing-intake-fields">
                        <Field id="ra-usecase" label="Use case" error={errors.api_use_case} full>
                          <input
                            id="ra-usecase"
                            className={inputClass(!!errors.api_use_case)}
                            type="text"
                            maxLength={USE_CASE_MAX}
                            placeholder="e.g. Outbound appointment reminders from our CRM"
                            value={form.api_use_case}
                            onChange={(e) => handleChange('api_use_case', e.target.value)}
                            disabled={submitting}
                          />
                        </Field>

                        <Field
                          id="ra-cps"
                          label="Expected calls / second (optional)"
                          error={errors.api_expected_cps}
                        >
                          <input
                            id="ra-cps"
                            className={inputClass(!!errors.api_expected_cps)}
                            type="number"
                            min={1}
                            max={1000}
                            step={1}
                            placeholder="10"
                            value={form.api_expected_cps}
                            onChange={(e) => handleChange('api_expected_cps', e.target.value)}
                            disabled={submitting}
                          />
                        </Field>

                        <Field id="ra-webhook" label="Webhook URL (optional)" error={errors.api_webhook_url}>
                          <input
                            id="ra-webhook"
                            className={inputClass(!!errors.api_webhook_url)}
                            type="url"
                            maxLength={255}
                            placeholder="https://api.acme.com/voice/events"
                            value={form.api_webhook_url}
                            onChange={(e) => handleChange('api_webhook_url', e.target.value)}
                            disabled={submitting}
                          />
                        </Field>

                        <div className="landing-field-full">
                          <label className="landing-mini-toggle">
                            <input
                              type="checkbox"
                              role="switch"
                              aria-checked={form.api_needs_numbers}
                              checked={form.api_needs_numbers}
                              onChange={(e) => handleChange('api_needs_numbers', e.target.checked)}
                              disabled={submitting}
                            />
                            <span className="landing-mini-toggle-q">
                              Do you need us to provide numbers?
                            </span>
                            <span className="landing-mini-toggle-a" aria-hidden="true">
                              {form.api_needs_numbers ? 'Yes' : 'No'}
                            </span>
                            <span className="landing-switch" aria-hidden="true" />
                          </label>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* ── Visual Voicemail setup ── */}
                  {form.products.includes('voicemail') && (
                    <div className="landing-field-full landing-product-block landing-hv-reveal">
                      <span className="landing-product-block-title">
                        Visual Voicemail
                      </span>
                      <div className="landing-intake-fields">
                        <Field id="ra-mailboxes" label="How many mailboxes?" error={errors.vm_mailbox_count}>
                          <input
                            id="ra-mailboxes"
                            className={inputClass(!!errors.vm_mailbox_count)}
                            type="number"
                            min={1}
                            max={10_000}
                            step={1}
                            placeholder="50"
                            value={form.vm_mailbox_count}
                            onChange={(e) => handleChange('vm_mailbox_count', e.target.value)}
                            disabled={submitting}
                          />
                        </Field>

                        <Field id="ra-attachto" label="Attach mailboxes to" error={errors.vm_attach_to}>
                          <LandingSelect
                            id="ra-attachto"
                            labelId="ra-attachto-label"
                            value={form.vm_attach_to}
                            options={ATTACH_TO_OPTIONS}
                            placeholder="Select an option…"
                            onChange={(v) => handleChange('vm_attach_to', v)}
                            disabled={submitting}
                            invalid={!!errors.vm_attach_to}
                          />
                        </Field>
                      </div>
                    </div>
                  )}

                  {/* ── Capacity & timeline — the technical declarations.
                      The capacity pair (KYC v2, REQUIRED) drives Granite's
                      high-volume threshold live: >1 CPS or >1,000 concurrent
                      call paths locks the declaration toggle on (see the
                      High-volume well below). ── */}
                  <span className="landing-intake-sub landing-field-full">
                    Capacity &amp; timeline
                  </span>

                  <Field
                    id="ra-peakcps"
                    label="Peak calls per second"
                    error={errors.declared_peak_cps}
                    hint="How many calls you'll start per second at peak"
                  >
                    <input
                      id="ra-peakcps"
                      className={inputClass(!!errors.declared_peak_cps)}
                      type="number"
                      min={1}
                      max={1000}
                      step={1}
                      placeholder="1"
                      value={form.declared_peak_cps}
                      onChange={(e) => handleChange('declared_peak_cps', e.target.value)}
                      disabled={submitting}
                    />
                  </Field>

                  <Field
                    id="ra-peakconcurrent"
                    label="Peak concurrent calls"
                    error={errors.declared_max_concurrent_calls}
                    hint="Simultaneous active calls (call paths) at peak"
                  >
                    <input
                      id="ra-peakconcurrent"
                      className={inputClass(!!errors.declared_max_concurrent_calls)}
                      type="number"
                      min={1}
                      max={100_000}
                      step={1}
                      placeholder="100"
                      value={form.declared_max_concurrent_calls}
                      onChange={(e) =>
                        handleChange('declared_max_concurrent_calls', e.target.value)
                      }
                      disabled={submitting}
                    />
                  </Field>

                  {/* One-line label — pairs with the timeline select.
                      Informational only — no longer a high-volume trigger. */}
                  <Field id="ra-volume" label="Expected monthly volume" error={errors.monthly_volume}>
                    <LandingSelect
                      id="ra-volume"
                      labelId="ra-volume-label"
                      value={form.monthly_volume}
                      options={VOLUME_OPTIONS}
                      placeholder="Select a range…"
                      onChange={(v) => handleChange('monthly_volume', v)}
                      disabled={submitting}
                      invalid={!!errors.monthly_volume}
                    />
                  </Field>

                  <Field id="ra-timeline" label="When do you need this live?" error={errors.timeline}>
                    <LandingSelect
                      id="ra-timeline"
                      labelId="ra-timeline-label"
                      value={form.timeline}
                      options={TIMELINE_OPTIONS}
                      placeholder="Select a timeline…"
                      onChange={(v) => handleChange('timeline', v)}
                      disabled={submitting}
                      invalid={!!errors.timeline}
                    />
                  </Field>

                  {/* ── High-volume calling declaration ── */}
                  <span className="landing-intake-sub landing-field-full">
                    High-volume calling
                  </span>

                  {/* Threshold statement — always visible. FCC 26-27 sets the
                      enhanced-KYC requirement but leaves the numeric threshold
                      to each provider; Granite defines two, and crossing
                      EITHER makes the declaration mandatory. */}
                  <p className="landing-intake-intro landing-field-full">
                    Under the FCC&rsquo;s Know-Your-Customer rules (FCC 26-27),
                    high-volume calling requires enhanced verification —
                    intended use and originating IP addresses. The FCC leaves
                    the threshold to each provider; Granite&rsquo;s thresholds
                    are more than <strong>1 call per second</strong> or more
                    than <strong>1,000 concurrent call paths</strong> —
                    crossing either one requires the declaration.
                  </p>

                  <div className="landing-field-full">
                    <label
                      className={
                        hvLocked
                          ? 'landing-hv-toggle landing-hv-toggle-locked'
                          : 'landing-hv-toggle'
                      }
                    >
                      <input
                        type="checkbox"
                        role="switch"
                        aria-checked={form.is_high_volume}
                        checked={form.is_high_volume}
                        onChange={(e) => handleHighVolumeToggle(e.target.checked)}
                        disabled={submitting || hvLocked}
                      />
                      <span className="landing-hv-toggle-text">
                        <span className="landing-hv-toggle-q">
                          Will you run high-volume outbound calling?
                        </span>
                        {hvLocked ? (
                          <span className="landing-hv-toggle-sub landing-hv-toggle-sub-lock">
                            <Lock size={11} strokeWidth={2.5} aria-hidden="true" />
                            Required above 1 call/sec or 1,000 concurrent call paths
                          </span>
                        ) : (
                          <span className="landing-hv-toggle-sub">
                            {form.is_high_volume
                              ? 'Declared voluntarily — required only above 1 call/sec or 1,000 concurrent call paths'
                              : 'Automated campaigns, dialers, AI voice agents — voluntary at or below 1 call/sec and 1,000 concurrent call paths'}
                          </span>
                        )}
                      </span>
                      <span className="landing-switch" aria-hidden="true" />
                    </label>
                  </div>

                  {form.is_high_volume && (
                    <div className="landing-field-full landing-intake-fields landing-hv-reveal">
                      <p className="landing-intake-intro landing-field-full">
                        For high-volume callers, FCC Know-Your-Customer rules
                        also ask how the service will be used and where calls
                        will originate.
                      </p>

                      <Field
                        id="ra-intendeduse"
                        label="Intended use of service"
                        error={errors.intended_use}
                      >
                        <LandingSelect
                          id="ra-intendeduse"
                          labelId="ra-intendeduse-label"
                          value={form.intended_use}
                          options={INTENDED_USE_OPTIONS}
                          placeholder="Select an intended use…"
                          onChange={(v) => handleChange('intended_use', v)}
                          disabled={submitting}
                          invalid={!!errors.intended_use}
                        />
                      </Field>

                      <Field
                        id="ra-dailycalls"
                        label="Expected daily calls (optional)"
                        error={errors.expected_daily_calls}
                      >
                        <input
                          id="ra-dailycalls"
                          className={inputClass(!!errors.expected_daily_calls)}
                          type="number"
                          min={0}
                          max={10_000_000}
                          step={1}
                          placeholder="50000"
                          value={form.expected_daily_calls}
                          onChange={(e) =>
                            handleChange('expected_daily_calls', e.target.value)
                          }
                          disabled={submitting}
                        />
                      </Field>

                      <Field
                        id="ra-usedesc"
                        label={
                          descriptionRequired
                            ? 'Describe the intended use'
                            : 'Describe the intended use (optional)'
                        }
                        error={errors.intended_use_description}
                        full
                      >
                        <textarea
                          id="ra-usedesc"
                          className={`${inputClass(!!errors.intended_use_description)} landing-textarea`}
                          rows={3}
                          maxLength={DESCRIPTION_MAX}
                          placeholder="e.g. Appointment reminders for utility service visits"
                          value={form.intended_use_description}
                          onChange={(e) =>
                            handleChange('intended_use_description', e.target.value)
                          }
                          disabled={submitting}
                        />
                        <span className="landing-charcount" aria-hidden="true">
                          {form.intended_use_description.length}/{DESCRIPTION_MAX}
                        </span>
                      </Field>

                    </div>
                  )}

                  {/* ── Unified IP capture — ONE field, TWO payload slots.
                      Appears when SIP Trunking is selected (IP-authenticated
                      signaling) OR high-volume is on (FCC originating-IP
                      requirement); label/helper adapt. On submit the same
                      entries fill products.trunk.signaling_ips (cap 10) and
                      kyc.high_volume.originating_ips. ── */}
                  {ipFieldVisible && (
                    <div className="landing-field-full landing-product-block landing-hv-reveal">
                      {/* No block title — the adaptive field label leads the
                          well (a second all-caps line read as a duplicate). */}
                      <div className="landing-intake-fields">
                        <Field
                          id="ra-ips"
                          label={ipFieldLabel}
                          error={errors.originating_ips}
                          hint={ipFieldHint}
                          full
                        >
                          <IpChipInput
                            id="ra-ips"
                            ips={form.originating_ips}
                            maxIps={ipFieldMax}
                            disabled={submitting}
                            invalid={!!errors.originating_ips}
                            onChange={(ips) => handleChange('originating_ips', ips)}
                          />
                        </Field>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {submitError && (
                <div className="landing-form-error landing-intake-error" role="alert">
                  {submitError}
                </div>
              )}

              <div className="landing-intake-actions">
                <button
                  type="submit"
                  className="landing-btn landing-btn-onblue"
                  disabled={submitting}
                >
                  {submitting ? (
                    'Submitting…'
                  ) : (
                    <>
                      Request access
                      <ArrowRight size={16} strokeWidth={2.5} />
                    </>
                  )}
                </button>
                <p className="landing-intake-note">
                  TED, Granite&rsquo;s Onboarding AI, picks this up instantly —
                  engineering follow-up within one business day.
                </p>
              </div>
            </form>
          )}
        </div>
      </div>
    </section>
  );
}
