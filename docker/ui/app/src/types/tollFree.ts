/**
 * Toll-Free / RespOrg types — map 1:1 to `routers/tollfree.py`
 * (`toll_free_numbers` + `tfn_import_batches`).
 */

/** Lifecycle statuses accepted by the API (see `_ALLOWED_STATUS`). */
export type TfnStatus =
  | 'spare'
  | 'reserved'
  | 'assigned'
  | 'active'
  | 'suspend'
  | 'disconnect'
  | 'transitional'
  | 'unavailable'
  | 'aging';

/** A row from the list endpoint (with joined customer/carrier names). */
export interface Tfn {
  id: number;
  tfn: string;
  customer_id: number | null;
  status: string;
  resp_org_id: string | null;
  template_name: string | null;
  effective_date: string | null;
  cr_status: string | null;
  cr_reference: string | null;
  carrier_id: number | null;
  label: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  customer_name: string | null;
  carrier_name: string | null;
}

/** The full single-TFN view (superset of the list row). */
export interface TfnDetail extends Tfn {
  cr_data?: Record<string, unknown>;
  cr_last_submitted_at?: string | null;
  cr_error?: string | null;
  import_batch_id?: number | null;
}

export interface TfnListResponse {
  items: Tfn[];
  total: number;
  limit: number;
  offset: number;
}

export interface TfnStats {
  total: number;
  by_status: Record<string, number>;
  by_cr_status: Record<string, number>;
}

/** One skipped/invalid entry recorded during a bulk import. */
export interface TfnImportError {
  value: string;
  error: string;
}

/** A bulk-import batch (progress + result). */
export interface TfnImportBatch {
  id: number;
  batch_key: string;
  customer_id: number | null;
  status: string; // 'running' | 'completed'
  total: number;
  processed: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  created_by: number | null;
  errors: TfnImportError[];
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  /** True when a completed batch_key was re-submitted (no reprocessing). */
  idempotent_replay?: boolean;
}

export interface TfnImportRequest {
  numbers: string[];
  batch_key?: string;
  customer_id?: number | null;
  carrier_id?: number | null;
  resp_org_id?: string | null;
  status?: string | null;
}

export interface ReassignCarrierRequest {
  tfns: string[];
  carrier_id: number;
}

export interface ReassignCarrierResult {
  carrier_id: number;
  gateway_name: string;
  requested: number;
  updated: number;
  not_found: number;
  invalid: number;
}

export interface TfnUpdate {
  customer_id?: number | null;
  carrier_id?: number | null;
  status?: string;
  resp_org_id?: string | null;
  template_name?: string | null;
  label?: string | null;
  notes?: string | null;
}

export interface TfnCrStatus {
  tfn: string;
  cr_status: string | null;
  cr_reference: string | null;
  cr_last_submitted_at: string | null;
  cr_error: string | null;
  resp_org_id: string | null;
  template_name: string | null;
  effective_date: string | null;
  /** When false, cr-submit only records local intent (no external RespOrg call). */
  somos_adapter_enabled: boolean;
}

export interface TfnCrSubmitResult {
  tfn: string;
  cr_status: string;
  cr_last_submitted_at: string | null;
  resp_org_id: string | null;
  adapter: { submitted: boolean; reason?: string };
}
