export type SippVerdict = 'PASS' | 'WARN' | 'FAIL';

export interface SippPreset {
  id: number;
  name: string;
  description?: string | null;
  defaults: Record<string, unknown>;
}

export interface SippRunConfig {
  preset_id?: number | null;
  remote_host: string;
  remote_port?: number;
  call_rate: number;
  call_limit: number;
  duration_seconds?: number;
  scenario?: string | null;
  extra_args?: string | null;
}

export interface SippResults {
  calls_attempted: number;
  calls_completed: number;
  calls_failed: number;
  avg_response_ms: number;
  max_response_ms: number;
  retransmissions: number;
  raw_output?: string | null;
}

export interface SippRunResponse {
  verdict: SippVerdict;
  config: SippRunConfig;
  results: SippResults;
}
