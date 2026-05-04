import { apiRequest } from './client';

export interface HomerSearchParams {
  from_user?: string;
  to_user?: string;
  call_id?: string;
  start_time: string; // ISO 8601
  end_time: string;   // ISO 8601
}

export interface HomerSearchResult {
  id: number;
  date: string;
  from_user: string;
  to_user: string;
  callid: string;
  method: string;
  source_ip: string;
  destination_ip: string;
  status: number;
}

export async function searchSipTraces(
  params: HomerSearchParams,
): Promise<{ data: HomerSearchResult[] }> {
  return apiRequest('POST', '/homer/search', params);
}
