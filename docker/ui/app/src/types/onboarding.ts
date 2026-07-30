export type OnboardingStatus = 'pending' | 'completed' | 'rejected';

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
  did_count: string;
  porting: string;
  current_carrier?: string;
  forwarding_setup: string;
  monthly_volume: string;
  timeline: string;
}
