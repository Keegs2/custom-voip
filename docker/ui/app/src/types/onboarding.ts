export type OnboardingStatus =
  | 'pending'
  | 'billing_verified'
  | 'approved'
  | 'provisioning'
  | 'active'
  | 'rejected';

export interface OnboardingRequest {
  id: number;
  company_name: string;
  contact_name: string;
  email: string;
  phone: string;
  did_count: string;
  porting: string;
  current_carrier: string | null;
  forwarding_setup: string;
  monthly_volume: string;
  timeline: string;
  status: OnboardingStatus;
  reviewed_by: number | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  admin_notes: string | null;
  billing_verified_by: number | null;
  billing_verified_by_name: string | null;
  billing_verified_at: string | null;
  billing_notes: string | null;
  provisioning_config: DIDConfigEntry[] | null;
  rejected_by: number | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  customer_id: number | null;
  user_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface DIDConfigEntry {
  did: string;
  forward_to: string;
}

export interface OnboardingSubmitPayload {
  company_name: string;
  contact_name: string;
  email: string;
  phone: string;
  did_count: string;
  porting: string;
  current_carrier?: string;
  forwarding_setup: string;
  monthly_volume: string;
  timeline: string;
}

export interface ApprovePayload {
  dids: DIDConfigEntry[];
  admin_notes?: string;
}

export interface ApproveResponse {
  status: string;
  request_id: number;
  customer: { id: number; name: string };
  user: {
    id: number;
    email: string;
    name: string;
    temp_password: string;
  };
  dids: Array<{ did: string; forward_to: string; rcf_id: number }>;
}
