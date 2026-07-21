export type DidStatus =
  | 'available'
  | 'assigned'
  | 'reserved'
  | 'porting_in'
  | 'porting_out'
  | 'suspended';

/**
 * Which environment OWNS a DID for call routing (did_inventory.allocated_env).
 * - 'prod'     → served by the production platform (DB column default)
 * - 'sandbox'  → reserved for the test / sandbox environment
 * - 'reserved' → held, not routable anywhere
 */
export type DidAllocatedEnv = 'prod' | 'sandbox' | 'reserved';

export interface DidInventoryItem {
  id: number;
  did: string;
  city?: string;
  state?: string;
  lata?: string;
  rate_center?: string;
  customer_id?: number;
  customer_name?: string;
  product_type?: string;
  product_ref_id?: number;
  status: DidStatus;
  // Owning environment for routing. Optional: older rows or endpoints that don't
  // SELECT the column may omit it (the DB column is NOT NULL DEFAULT 'prod').
  allocated_env?: DidAllocatedEnv;
  assigned_at?: string;
  notes?: string;
}

export interface DidStats {
  total: number;
  assigned: number;
  available: number;
  reserved: number;
  by_product: Record<string, number>;
  by_state: Record<string, number>;
  // This API instance's owning environment (DEPLOY_ENV, e.g. "sandbox"). Numbers
  // added via POST /numbers are stamped with this env automatically.
  deploy_env?: string;
  // Inventory counts keyed by allocated_env.
  by_env?: Record<string, number>;
}

export interface DidAssignRequest {
  customer_id: number;
  product_type: string;
  notes?: string;
}

/**
 * Body for POST /numbers (self-service add). The backend normalizes `did`
 * (10-digit, 11-digit, or E.164 → E.164) and stamps allocated_env from its own
 * DEPLOY_ENV — so there is no env field here.
 */
export interface DidAddRequest {
  did: string;
  state?: string;
  notes?: string;
}

export interface DidInventoryListParams {
  status?: DidStatus | '';
  state?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export interface DidInventoryListResponse {
  items: DidInventoryItem[];
  total: number;
}

export interface DidAvailableParams {
  state?: string;
  search?: string;
  limit?: number;
}
