export type HealthStatus = 'ok' | 'degraded' | 'error';

export interface ComponentHealth {
  status: HealthStatus;
  latency_ms?: number | null;
  detail?: string | null;
}

export interface HealthCheck {
  status: HealthStatus;
  version?: string;
  uptime_seconds?: number;
}

export interface DetailedHealth {
  status: HealthStatus;
  components: {
    api: ComponentHealth;
    database: ComponentHealth;
    redis: ComponentHealth;
  };
}
