import { apiRequest } from './client';
import type { LegacyFlowConfig } from '../flow/compile/fromLegacyIvr';

/**
 * A row from the legacy `ivr_flows` table as returned by `GET /ivr` (list) and
 * `GET /ivr/{id}` (get). The runtime stores the IVR tree under `flow_config`
 * (see `routers/ivr.py`), NOT as a flat `nodes` array — these endpoints return
 * the raw row. Used by the Call Flow Builder's "Import legacy IVR" action, which
 * converts `flow_config` into a `CallFlowDoc` via `fromLegacyIvr`.
 */
export interface LegacyIvrFlowRow {
  id: number;
  customer_id: number;
  did: string | null;
  name: string;
  flow_config: LegacyFlowConfig;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** List legacy IVR flows (admin: all customers; otherwise tenant-scoped). */
export async function listIvrFlows(): Promise<LegacyIvrFlowRow[]> {
  return apiRequest('GET', '/ivr');
}

/** Fetch a single legacy IVR flow by id (tenant-scoped). */
export async function getIvrFlow(id: number): Promise<LegacyIvrFlowRow> {
  return apiRequest('GET', `/ivr/${id}`);
}
