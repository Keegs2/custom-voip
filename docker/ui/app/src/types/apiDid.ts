export interface ApiDid {
  id: number;
  did: string;
  customer_id: number;
  customer_name?: string;
  voice_url: string;
  status_callback: string | null;
  enabled: boolean;
  created_at: string;
}

export interface ApiDidCreate {
  did: string;
  customer_id: number;
  voice_url: string;
  status_callback?: string | null;
  enabled?: boolean;
}

export interface ApiDidUpdate {
  voice_url?: string;
  status_callback?: string | null;
  enabled?: boolean;
}
