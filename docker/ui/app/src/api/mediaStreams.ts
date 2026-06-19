import { apiRequest } from './client';
import type { MediaStreamsResponse } from '../types/mediaStream';

/** GET /media/streams — active media taps (frames/bytes/duration per call leg). */
export async function listMediaStreams(): Promise<MediaStreamsResponse> {
  const raw = await apiRequest<MediaStreamsResponse>('GET', '/media/streams');
  return {
    streams: raw.streams ?? [],
    esl_connected: raw.esl_connected,
  };
}
