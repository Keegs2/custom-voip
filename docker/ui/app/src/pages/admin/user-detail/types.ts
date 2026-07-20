/**
 * Local types for the User Detail (360) admin page.
 *
 * These map 1:1 to the API shapes consumed by `/search/user/:id/360`,
 * `/customers`, and the user update endpoint. Page-global types still come from
 * `src/types/*` (e.g. `User`, `Customer`); only the feature-local request/response
 * shapes and small unions live here.
 */

export type PresenceStatus = 'available' | 'away' | 'busy' | 'dnd' | 'offline';
export type CallDirection = 'inbound' | 'outbound';
export type CallResult = 'answered' | 'failed' | 'busy' | 'no-answer' | 'cancelled';
export type UserRole = 'admin' | 'user' | 'readonly';
export type AccountType = 'RCF' | 'API' | 'Trunk' | 'UCaaS' | 'Hybrid';

/** Lightweight customer shape returned by the edit-form `/customers` lookup. */
export interface Customer {
  id: number;
  name: string;
  account_type: string;
  status: string;
}

export interface RecentCall {
  id: string;
  direction: CallDirection;
  caller: string;
  callee: string;
  duration: number;
  result: CallResult;
  timestamp: string;
}

export interface Device {
  id: string;
  user_agent: string;
  ip_address: string;
  registered_at: string;
  expires_at: string;
}

export interface RcfProduct {
  id: number;
  did: string;
  name: string | null;
  forward_to: string;
  enabled: boolean;
  ring_timeout: number;
  failover_to: string | null;
  pass_caller_id: boolean;
}

export interface ApiDidProduct {
  did: string;
  voice_url: string;
  enabled: boolean;
}

export interface TrunkProduct {
  id: number;
  trunk_name: string;
  max_channels: number;
  enabled: boolean;
  did_count: number;
  ip_count: number;
}

export interface User360Response {
  user: {
    id: number;
    name: string;
    email: string;
    role: UserRole;
    customer_id: number;
    customer_name: string;
    account_type: AccountType | null;
    status: 'active' | 'disabled' | 'suspended';
    last_login: string | null;
  };
  extension: {
    number: string;
    did: string | null;
    voicemail_enabled: boolean;
    dnd: boolean;
    forward_on_busy: string | null;
    forward_on_no_answer: string | null;
    forward_timeout_sec: number | null;
  } | null;
  presence: {
    status: PresenceStatus;
    message: string | null;
    updated_at: string | null;
  } | null;
  voicemail: {
    total: number;
    unread: number;
  };
  chat: {
    total_conversations: number;
    unread_messages: number;
  };
  recent_calls: RecentCall[];
  devices: Device[];
  products: {
    rcf: RcfProduct[];
    api_dids: ApiDidProduct[];
    trunks: TrunkProduct[];
  };
}

export interface UpdateUserPayload {
  name?: string;
  email?: string;
  role?: UserRole;
  status?: 'active' | 'disabled';
  customer_id?: number;
  password?: string;
}

/** Convenience alias for the nested user object. */
export type User360 = User360Response['user'];
/** Convenience alias for the nested extension object (non-null variant). */
export type ExtensionInfo = NonNullable<User360Response['extension']>;

/** Page size for the customer picker "load more" pagination. */
export const CUSTOMER_PAGE_SIZE = 25;
