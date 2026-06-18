import { apiRequest } from './client';
import type { WebRTCCredentials } from '../types/softphone';

/**
 * STUN-only fallback used only when the API omits ICE configuration entirely
 * (e.g. an older API build). Production responses include STUN *and*
 * time-limited TURN servers, which always take precedence over this default —
 * TURN is what lets media traverse symmetric NATs/firewalls.
 */
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [{ urls: 'stun:stun.l.google.com:19302' }];

/**
 * Fetch WebRTC credentials for the current user's extension.
 * Returns the WebSocket URL, SIP login, password, and ICE server configuration
 * (STUN + time-limited TURN) that the Verto client feeds into every
 * RTCPeerConnection it creates.
 *
 * Returns null if the user has no extension provisioned.
 */
export async function getWebRTCCredentials(): Promise<WebRTCCredentials | null> {
  try {
    const creds = await apiRequest<WebRTCCredentials>('GET', '/webrtc/credentials');
    // Defense-in-depth: guarantee a usable ICE config so the peer connection
    // always has servers to gather candidates from. The API's iceServers
    // (including TURN) are used verbatim when present; we only substitute the
    // STUN-only default if the response is missing or empty.
    return {
      ...creds,
      ice_servers:
        Array.isArray(creds.ice_servers) && creds.ice_servers.length > 0
          ? creds.ice_servers
          : DEFAULT_ICE_SERVERS,
    };
  } catch {
    return null;
  }
}
