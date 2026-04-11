export interface User {
  id: number;
  email: string;
  role: 'admin' | 'user' | 'readonly';
  customer_id: number | null;
  name: string;
  status: string;
  created_at: string;
  last_login: string | null;
  customer_name: string | null;
  account_type: 'rcf' | 'api' | 'trunk' | 'hybrid' | 'ucaas' | null;
}

export interface LoginResponse {
  access_token: string;
  token_type: string;
  user: User;
}

export interface UserCreate {
  email: string;
  password: string;
  customer_id?: number | null;
  role?: string;
  name: string;
}

export interface UserUpdate {
  email?: string;
  password?: string;
  customer_id?: number | null;
  role?: string;
  name?: string;
  status?: string;
}
