export type OnboardingStatus = 'pending' | 'completed' | 'rejected';

/* ─────────────────────────────────────────────────────────────
   FCC Know-Your-Customer capture (FCC 26-27 FNPRM, adopted
   2026-04-30). Mirrors the Pydantic models in
   docker/api/src/routers/onboarding.py — keep in sync.
   ───────────────────────────────────────────────────────────── */

export type KycGovIdType = 'ein' | 'state_registration' | 'duns' | 'other';

export type KycIntendedUse =
  | 'marketing'
  | 'education'
  | 'political_campaign'
  | 'notifications_alerts'
  | 'customer_service'
  | 'ai_voice_agents'
  | 'other';

/** Human labels shared by the intake form and the admin review surface. */
export const GOV_ID_TYPE_LABELS: Record<KycGovIdType, string> = {
  ein: 'EIN (Federal Tax ID)',
  state_registration: 'State registration',
  duns: 'DUNS number',
  other: 'Other',
};

export const INTENDED_USE_LABELS: Record<KycIntendedUse, string> = {
  marketing: 'Marketing & outreach',
  education: 'Education',
  political_campaign: 'Political campaign',
  notifications_alerts: 'Notifications & alerts',
  customer_service: 'Customer service',
  ai_voice_agents: 'AI voice agents',
  other: 'Other',
};

/** Baseline KYC — required for all customers (FCC 26-27). */
export interface KycStandard {
  legal_business_name: string;
  address_line1: string;
  address_line2?: string | null;
  city: string;
  /** 2-letter US state/territory code, e.g. "MA". */
  state: string;
  postal_code: string;
  /** Self-disclosure: the address is a registered agent or virtual office. */
  address_is_registered_agent_or_virtual: boolean;
  gov_id_type: KycGovIdType;
  /** EIN must match NN-NNNNNNN when gov_id_type === 'ein'. */
  gov_id_number: string;
  /** Required by the backend when gov_id_type === 'state_registration'. */
  state_of_registration?: string | null;
  /** E.164; must differ from the main contact phone. */
  alternate_phone: string;
  website?: string | null;
}

/** Additional KYC — required iff the customer self-declares high-volume. */
export interface KycHighVolume {
  intended_use: KycIntendedUse;
  /** Required when intended_use === 'other'. Max 500 chars. */
  intended_use_description?: string | null;
  /** 1-20 entries; IPv4/IPv6 or CIDR no wider than /24 (v4) / /64 (v6). */
  originating_ips: string[];
  expected_daily_calls?: number | null;
}

/* ─────────────────────────────────────────────────────────────
   Product-aware intake (products-v1). Applicants pick 1+ products
   and supply per-product setup info. Mirrors ProductsPayload in
   docker/api/src/routers/onboarding.py — keep in sync.
   ───────────────────────────────────────────────────────────── */

export type ProductKey = 'rcf' | 'trunk' | 'api' | 'voicemail';

/** Stable render/order for product blocks everywhere. */
export const PRODUCT_ORDER: readonly ProductKey[] = [
  'rcf',
  'trunk',
  'api',
  'voicemail',
];

/** Full display names — picker cards, admin block titles. */
export const PRODUCT_LABELS: Record<ProductKey, string> = {
  rcf: 'RCF — Remote Call Forwarding',
  trunk: 'SIP Trunking',
  api: 'API Calling',
  voicemail: 'Visual Voicemail',
};

/** Compact chip labels — admin summary rows. */
export const PRODUCT_CHIP_LABELS: Record<ProductKey, string> = {
  rcf: 'RCF',
  trunk: 'Trunk',
  api: 'API',
  voicemail: 'VVM',
};

export type VoicemailAttachTo = 'existing_numbers' | 'new_numbers' | 'unsure';

export const ATTACH_TO_LABELS: Record<VoicemailAttachTo, string> = {
  existing_numbers: 'Existing numbers',
  new_numbers: 'New numbers',
  unsure: 'Not sure',
};

/** RCF setup info — same option strings as the legacy top-level fields. */
export interface RcfIntake {
  did_count: string;
  porting: string;
  /** Required by the backend when porting starts with "Yes"/"Both". */
  current_carrier?: string | null;
  forwarding_setup: string;
}

/** SIP Trunking setup info — IP-peering only, so signaling IPs are required. */
export interface TrunkIntake {
  /** 1–10 entries; same IP/CIDR syntax rules as the KYC originating IPs. */
  signaling_ips: string[];
  /** 1–1000. */
  concurrent_call_paths: number;
  pbx_vendor?: string | null;
  dids_needed?: string | null;
}

/** API Calling setup info. */
export interface ApiIntake {
  /** 1–300 chars. */
  use_case: string;
  /** 1–1000. */
  expected_cps?: number | null;
  /** Basic http(s):// URL. */
  webhook_url?: string | null;
  needs_numbers: boolean;
}

/** Visual Voicemail setup info. */
export interface VoicemailIntake {
  /** 1–10,000. */
  mailbox_count: number;
  attach_to: VoicemailAttachTo;
}

/**
 * The `products` object POSTed with a new onboarding submission.
 * Each block must be present iff its product is selected (422 otherwise).
 */
export interface ProductsPayload {
  /** Min 1, no duplicates. */
  selected: ProductKey[];
  rcf: RcfIntake | null;
  trunk: TrunkIntake | null;
  api: ApiIntake | null;
  voicemail: VoicemailIntake | null;
}

/** The stored products document as returned on admin reads. */
export interface ProductsRecord extends ProductsPayload {
  form_version?: string;
}

/** The `kyc` object POSTed with a new onboarding submission. */
export interface KycPayload {
  is_high_volume: boolean;
  standard: KycStandard;
  /** Must be null when is_high_volume === false, present when true. */
  high_volume: KycHighVolume | null;
}

/**
 * The stored KYC document as returned on admin reads
 * (onboarding_requests.kyc JSONB: {standard, high_volume, submitted_at,
 * form_version}). High-volume status is derived: high_volume !== null.
 */
export interface KycRecord {
  standard: KycStandard;
  high_volume: KycHighVolume | null;
  submitted_at?: string;
  form_version?: string;
}

export interface OnboardingRequest {
  id: number;
  company_name: string;
  contact_name: string;
  email: string;
  phone: string;
  /** Legacy top-level RCF fields — mirrored from products.rcf when RCF is
      selected; NULL on non-RCF product-aware submissions. */
  did_count: string | null;
  porting: string | null;
  current_carrier: string | null;
  forwarding_setup: string | null;
  monthly_volume: string;
  timeline: string;
  /** Null on legacy pre-KYC submissions. */
  kyc: KycRecord | null;
  /** Null on legacy pre-products submissions (top-level RCF fields apply). */
  products: ProductsRecord | null;
  status: OnboardingStatus;
  admin_notes: string | null;
  completed_by: number | null;
  completed_by_name: string | null;
  completed_at: string | null;
  rejected_by: number | null;
  rejected_by_name: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface OnboardingSubmitPayload {
  company_name: string;
  contact_name: string;
  email: string;
  phone: string;
  /** Legacy mirror of products.rcf — send when RCF is selected, omit otherwise. */
  did_count?: string;
  porting?: string;
  current_carrier?: string;
  forwarding_setup?: string;
  monthly_volume: string;
  timeline: string;
  /** Required on all new submissions — FCC Know-Your-Customer rules. */
  kyc: KycPayload;
  /** Required on all new submissions — product selection + per-product setup. */
  products: ProductsPayload;
}
