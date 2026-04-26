import { apiRequest } from './client';

export interface SbcStat {
  sbc_id: string;
  calls_total: number;
  calls_last_minute: number;
  answered_calls: number;
  avg_duration_ms: number;
  percentage: number;
}

export interface SbcStatsResponse {
  window_minutes: number;
  total_calls: number;
  sbcs: SbcStat[];
  timestamp: string;
}

export async function getSbcStats(minutes = 5): Promise<SbcStatsResponse> {
  return apiRequest('GET', `/sbc/stats?minutes=${minutes}`);
}
