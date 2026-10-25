/**
 * ivrData.ts — server state for the IVR product (React Query), the customer
 * SCOPE every query is keyed on, and the error wording.
 *
 * Scope (contract §8.2, same rule as voicemail):
 *
 *   viewer                         customer_id sent   cache key
 *   ─────────────────────────────  ─────────────────  ─────────
 *   tenant (user / readonly)       none (API scopes)  self:<own id>
 *   admin previewing customer N    N                  c:<N>
 *   admin console, customer N      N                  c:<N>
 *
 * There is no "all customers" IVR view: an admin without a customer would
 * get 400 `customer_id required`, so the page asks them to pick one first.
 * The key always carries the customer, so one account's flows can never be
 * served from another's cache entry. Mutations invalidate ['ivr', key].
 */
import { useQuery, type QueryClient } from '@tanstack/react-query';
import { ApiError } from '../../api/client';
import {
  getDestinations,
  getFlow,
  getFlowVersion,
  getIvrSummary,
  listFlowVersions,
  listPrompts,
  listVoices,
} from '../../api/ivr';
import type { Issue } from '../../types/ivr';

/* ─── Scope ───────────────────────────────────────────────── */

export interface IvrScope {
  /** customer_id for every request; undefined = tenant self-scope. */
  customerId: number | undefined;
  /** Cache discriminator, see the table above. */
  key: string;
}

export function ivrTenantScope(ownCustomerId: number): IvrScope {
  return { customerId: undefined, key: `self:${ownCustomerId}` };
}

export function ivrStaffScope(customerId: number): IvrScope {
  return { customerId, key: `c:${customerId}` };
}

export const ivrKeys = {
  all: (s: IvrScope) => ['ivr', s.key] as const,
  summary: (s: IvrScope) => ['ivr', s.key, 'summary'] as const,
  flow: (s: IvrScope, id: number) => ['ivr', s.key, 'flow', id] as const,
  versions: (s: IvrScope, id: number) => ['ivr', s.key, 'versions', id] as const,
  version: (s: IvrScope, id: number, v: number) => ['ivr', s.key, 'version', id, v] as const,
  prompts: (s: IvrScope) => ['ivr', s.key, 'prompts'] as const,
  destinations: (s: IvrScope) => ['ivr', s.key, 'destinations'] as const,
  voices: (s: IvrScope) => ['ivr', s.key, 'voices'] as const,
};

/* ─── Reads ───────────────────────────────────────────────── */

export function useIvrSummary(scope: IvrScope, enabled = true) {
  return useQuery({
    queryKey: ivrKeys.summary(scope),
    queryFn: () => getIvrSummary(scope.customerId),
    enabled,
    staleTime: 30_000,
  });
}

export function useFlow(scope: IvrScope, flowId: number | null) {
  return useQuery({
    queryKey: ivrKeys.flow(scope, flowId ?? -1),
    queryFn: () => getFlow(flowId as number, scope.customerId),
    enabled: flowId !== null,
    // The builder owns the draft once loaded; never refetch it underneath an edit.
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}

export function useFlowVersions(scope: IvrScope, flowId: number, enabled = true) {
  return useQuery({
    queryKey: ivrKeys.versions(scope, flowId),
    queryFn: () => listFlowVersions(flowId, scope.customerId),
    enabled,
  });
}

export function useFlowVersion(scope: IvrScope, flowId: number, version: number | null) {
  return useQuery({
    queryKey: ivrKeys.version(scope, flowId, version ?? -1),
    queryFn: () => getFlowVersion(flowId, version as number, scope.customerId),
    enabled: version !== null,
    staleTime: Infinity, // versions are immutable
  });
}

export function usePrompts(scope: IvrScope, enabled = true) {
  return useQuery({
    queryKey: ivrKeys.prompts(scope),
    queryFn: () => listPrompts(scope.customerId),
    enabled,
  });
}

export function useDestinations(scope: IvrScope, enabled = true) {
  return useQuery({
    queryKey: ivrKeys.destinations(scope),
    queryFn: () => getDestinations(scope.customerId),
    enabled,
    staleTime: 60_000,
  });
}

export function useVoices(scope: IvrScope, enabled = true) {
  return useQuery({
    queryKey: ivrKeys.voices(scope),
    queryFn: () => listVoices(scope.customerId),
    enabled,
    staleTime: 10 * 60_000,
  });
}

export function invalidateIvr(queryClient: QueryClient, scope: IvrScope): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: ivrKeys.all(scope) });
}

/* ─── Errors ──────────────────────────────────────────────── */

/**
 * The API's structured errors, whichever way FastAPI wraps them: contract
 * shapes put the code in `detail` with siblings (`{ detail: "stale_revision",
 * current_revision }`), a plain HTTPException nests them
 * (`{ detail: { code | detail: "stale_revision", current_revision } }`).
 * Both are flattened to one record here.
 */
export interface IvrErrorBody {
  code: string | null;
  currentRevision: number | null;
  errors: Issue[];
  /** prompt_in_use: names of the flows whose draft uses the prompt. */
  flows: string[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asIssues(v: unknown): Issue[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(isRecord)
    .filter((i) => typeof i.message === 'string')
    .map((i) => ({
      code: typeof i.code === 'string' ? i.code : 'invalid',
      message: i.message as string,
      node_id: typeof i.node_id === 'string' ? i.node_id : null,
      handle: typeof i.handle === 'string' ? i.handle : null,
    }));
}

export function readIvrError(err: unknown): IvrErrorBody {
  const empty: IvrErrorBody = { code: null, currentRevision: null, errors: [], flows: [] };
  if (!(err instanceof ApiError) || !isRecord(err.raw)) return empty;
  const top = err.raw;
  const inner = isRecord(top.detail) ? top.detail : {};
  const merged: Record<string, unknown> = { ...inner, ...top };
  const code =
    typeof top.detail === 'string'
      ? top.detail
      : typeof inner.code === 'string'
        ? inner.code
        : typeof inner.detail === 'string'
          ? inner.detail
          : null;
  const rev = merged.current_revision;
  const flowsRaw = Array.isArray(merged.flows) ? merged.flows : [];
  const flows = flowsRaw
    .map((f) => (typeof f === 'string' ? f : isRecord(f) && typeof f.name === 'string' ? f.name : null))
    .filter((f): f is string => f !== null);
  return {
    code,
    currentRevision: typeof rev === 'number' ? rev : null,
    errors: asIssues(merged.errors),
    flows,
  };
}

export function isIvrError(err: unknown, status: number, code: string): boolean {
  return err instanceof ApiError && err.status === status && readIvrError(err).code === code;
}

/** Customer-readable text for any IVR API error. */
export function ivrErrorText(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  const { code, flows } = readIvrError(err);
  switch (code) {
    case 'ivr_not_enabled':
      return 'IVR isn’t switched on for this account.';
    case 'customer_id required':
      return 'Pick a customer first.';
    case 'stale_revision':
      return 'This flow was changed somewhere else since you opened it.';
    case 'flow_in_use':
      return 'A number still uses this flow. Point the number at another flow first.';
    case 'prompt_in_use':
      return flows.length
        ? `This message is still used by ${flows.map((f) => `“${f}”`).join(', ')}. Remove it from ${flows.length === 1 ? 'that flow' : 'those flows'} first.`
        : 'This message is still used by a flow. Remove it from the flow first.';
    case 'invalid_flow':
      return 'The flow has problems to fix before it can be published.';
    default:
      break;
  }
  if (err.status === 429) return 'Too many previews in a minute. Wait a moment and try again.';
  if (err.status === 503) return 'The IVR service is temporarily unavailable. Try again in a minute.';
  if (err.status === 403) return 'You don’t have permission to do that.';
  if (err.status === 404) return 'That item no longer exists. Refresh the page.';
  if (err.status === 413) return 'That file is too large.';
  if (err.status >= 500) return fallback;
  return typeof err.message === 'string' && err.message && !err.message.startsWith('{') ? err.message : fallback;
}
