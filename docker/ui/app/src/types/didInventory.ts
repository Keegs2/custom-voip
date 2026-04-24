export type DidStatus =
  | 'available'
  | 'assigned'
  | 'reserved'
  | 'porting_in'
  | 'porting_out'
  | 'suspended';

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
}

export interface DidAssignRequest {
  customer_id: number;
  product_type: string;
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
