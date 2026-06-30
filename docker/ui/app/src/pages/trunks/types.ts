/**
 * Local types + constants for the SIP Trunks glass page. Page-global trunk
 * types still come from `src/types/trunk.ts`; only feature-local values live
 * here.
 */

import type { TrunkAuthType } from '../../types/trunk';

/** Human-readable label for each auth mode, shown in the config summary. */
export const AUTH_LABEL: Record<TrunkAuthType, string> = {
  ip: 'IP authentication',
  credentials: 'Credential authentication',
  both: 'IP + Credential authentication',
};
