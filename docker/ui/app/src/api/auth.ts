import { apiRequest } from './client';
import type { LoginResponse, User, UserCreate, UserUpdate } from '../types/auth';

/**
 * Authenticate with email/password. Returns JWT token and user object.
 * The caller is responsible for persisting the token to localStorage.
 */
export async function login(email: string, password: string): Promise<LoginResponse> {
  return apiRequest<LoginResponse>('POST', '/auth/login', { email, password });
}

/**
 * Validate the current token and return the authenticated user.
 * Throws ApiError(401) if the token is invalid or expired.
 */
export async function getMe(): Promise<User> {
  return apiRequest<User>('GET', '/auth/me');
}

/**
 * List all platform users — admin only.
 */
export async function listUsers(): Promise<User[]> {
  return apiRequest<User[]>('GET', '/auth/users');
}

/**
 * Create a new user — admin only.
 */
export async function createUser(data: UserCreate): Promise<User> {
  return apiRequest<User>('POST', '/auth/register', data);
}

/**
 * Update an existing user — admin only.
 */
export async function updateUser(id: number, data: UserUpdate): Promise<User> {
  return apiRequest<User>('PUT', `/auth/users/${id}`, data);
}

/**
 * Delete a user — admin only.
 */
export async function deleteUser(id: number): Promise<void> {
  return apiRequest<void>('DELETE', `/auth/users/${id}`);
}
