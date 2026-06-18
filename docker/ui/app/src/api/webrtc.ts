import { apiRequest } from './client';
import type { WebRTCCredentials } from '../types/softphone';

/**
 * Fetch WebRTC credentials for the current user's extension.
 * Returns the WebSocket URL, SIP login, password, and ICE server configuration
 * that the Verto client needs to connect to FreeSWITCH mod_verto.
 *
 * Returns null if the user has no extension provisioned.
 */
export async function getWebRTCCredentials(): Promise<WebRTCCredentials | null> {
  try {
    return await apiRequest<WebRTCCredentials>('GET', '/webrtc/credentials');
  } catch {
    return null;
  }
}
