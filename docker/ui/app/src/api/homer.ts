import { apiRequest } from './client';

export interface HomerSearchParams {
  from_user?: string;
  to_user?: string;
  call_id?: string;
  start_time: string; // ISO 8601
  end_time: string;   // ISO 8601
}

export interface HomerSearchResult {
  timestamp: string;
  timestamp_ns: number;
  from_user: string;
  to_user: string;
  callid: string;
  method: string;
  src_ip: string;
  dst_ip: string;
  status: number | null;
  node?: string;
  /** Raw SIP message body (full headers + SDP) from the Loki log line */
  raw_msg?: string | null;
}

export async function searchSipTraces(
  params: HomerSearchParams,
): Promise<{ data: HomerSearchResult[]; correlations: Record<string, string[]> }> {
  return apiRequest('POST', '/homer/search', params);
}
