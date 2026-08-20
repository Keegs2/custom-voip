import { apiRequest } from './client';
import type {
  OnboardingRequest,
  OnboardingSubmitPayload,
} from '../types/onboarding';

/**
 * POST /onboarding — public endpoint, no auth required.
 * Submits a new onboarding request from a prospective customer (landing page
 * "Request Access" form). Admin review of these requests now lives in TED.
 */
export async function submitOnboardingRequest(
  data: OnboardingSubmitPayload,
): Promise<OnboardingRequest> {
  return apiRequest('POST', '/onboarding', data);
}
