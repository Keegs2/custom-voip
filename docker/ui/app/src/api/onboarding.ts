import { apiRequest } from './client';
import type {
  OnboardingRequest,
  OnboardingSubmitPayload,
} from '../types/onboarding';

export interface OnboardingListParams {
  status?: string;
  limit?: number;
  offset?: number;
}

export interface OnboardingListResponse {
  items: OnboardingRequest[];
  total: number;
}

/**
 * POST /onboarding — public endpoint, no auth required.
 * Submits a new onboarding request from a prospective customer.
 */
export async function submitOnboardingRequest(
  data: OnboardingSubmitPayload,
): Promise<OnboardingRequest> {
  return apiRequest('POST', '/onboarding', data);
}

/**
 * GET /onboarding — admin endpoint.
 * Returns paginated onboarding requests, optionally filtered by status.
 */
export async function listOnboardingRequests(
  params: OnboardingListParams = {},
): Promise<OnboardingListResponse> {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.limit !== undefined) query.set('limit', String(params.limit));
  if (params.offset !== undefined) query.set('offset', String(params.offset));

  const qs = query.toString();
  const raw = await apiRequest<OnboardingRequest[] | OnboardingListResponse>(
    'GET',
    `/onboarding${qs ? `?${qs}` : ''}`,
  );

  if (Array.isArray(raw)) {
    return { items: raw, total: raw.length };
  }
  return {
    items: (raw as OnboardingListResponse).items ?? [],
    total:
      (raw as OnboardingListResponse).total ??
      (raw as OnboardingListResponse).items?.length ??
      0,
  };
}

/**
 * GET /onboarding/{id} — admin endpoint.
 * Returns a single onboarding request by ID.
 */
export async function getOnboardingRequest(id: number): Promise<OnboardingRequest> {
  return apiRequest('GET', `/onboarding/${id}`);
}

/**
 * POST /onboarding/{id}/complete — admin endpoint.
 * Marks the intake as completed (pending → completed), optionally recording notes.
 */
export async function completeOnboarding(
  id: number,
  notes?: string,
): Promise<OnboardingRequest> {
  return apiRequest('POST', `/onboarding/${id}/complete`, { notes });
}

/**
 * POST /onboarding/{id}/reject — admin endpoint.
 * Rejects the onboarding request, optionally providing a reason.
 */
export async function rejectOnboarding(
  id: number,
  reason?: string,
): Promise<OnboardingRequest> {
  return apiRequest('POST', `/onboarding/${id}/reject`, { reason });
}
