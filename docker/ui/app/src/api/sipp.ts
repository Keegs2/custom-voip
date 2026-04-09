import { apiRequest } from './client';
import type { SippPreset, SippRunConfig, SippRunResponse } from '../types/sipp';

export async function listSippPresets(): Promise<SippPreset[]> {
  return apiRequest('GET', '/sipp/presets');
}

export async function runSipp(config: SippRunConfig): Promise<SippRunResponse> {
  return apiRequest('POST', '/sipp/run', config);
}
