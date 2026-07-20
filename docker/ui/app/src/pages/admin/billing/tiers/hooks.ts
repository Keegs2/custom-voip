/**
 * Data hooks for the Tiers admin feature: trunk tiers, API tiers, and call-path
 * packages. Read-only — the page composes the returned query state.
 */

import { useQuery } from '@tanstack/react-query';
import { listTrunkTiers, listApiTiers } from '../../../../api/tiers';
import { listCallPaths } from '../../../../api/trunks';

export function useTiersData() {
  const trunkTiers = useQuery({ queryKey: ['tiers', 'trunk'], queryFn: listTrunkTiers });
  const apiTiers = useQuery({ queryKey: ['tiers', 'api'], queryFn: listApiTiers });
  const callPaths = useQuery({ queryKey: ['trunks', 'call-paths'], queryFn: listCallPaths });
  return { trunkTiers, apiTiers, callPaths };
}
