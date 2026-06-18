import { apiRequest } from './client';
import type { Extension } from '../types/softphone';

export interface ExtensionListParams {
  customer_id?: number;
  include_presence?: boolean;
}

/**
 * List extensions, optionally scoped to a customer and including presence info.
 */
export async function listExtensions(params: ExtensionListParams = {}): Promise<Extension[]> {
  const query = new URLSearchParams();
  if (params.customer_id !== undefined) query.set('customer_id', String(params.customer_id));
  if (params.include_presence) query.set('include_presence', 'true');
  const qs = query.toString();
  return apiRequest<Extension[]>('GET', `/extensions${qs ? `?${qs}` : ''}`);
}

/**
 * Fetch a single extension by ID.
 */
export async function getExtension(id: number): Promise<Extension> {
  return apiRequest<Extension>('GET', `/extensions/${id}`);
}

/**
 * Fetch the extension directory — all extensions with display names and presence.
 * Used to populate the contacts tab in the softphone widget.
 */
export async function getDirectory(customerId?: number): Promise<Extension[]> {
  const query = new URLSearchParams();
  query.set('include_presence', 'true');
  if (customerId !== undefined) query.set('customer_id', String(customerId));
  return apiRequest<Extension[]>('GET', `/extensions/directory?${query.toString()}`);
}

/**
 * Get the extension assigned to the currently authenticated user.
 */
export async function getMyExtension(): Promise<Extension | null> {
  try {
    return await apiRequest<Extension>('GET', '/extensions/me');
  } catch {
    // User may not have an extension — treat 404 as null rather than error
    return null;
  }
}
