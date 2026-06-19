/**
 * Active media (RTP/recording/transcription) streams.
 *
 * `GET /media/streams` lists the live media taps the media plane is currently
 * pumping — one row per call leg being captured. Frame/byte/duration counters
 * are the raw stream stats; the same tap is the pluggable hook point where a
 * speech-to-text (STT) consumer can subscribe for live transcription.
 */
export interface MediaStream {
  call_uuid: string;
  frames: number;
  bytes: number;
  duration_ms: number;
  started_at: string;
}

export interface MediaStreamsResponse {
  streams: MediaStream[];
  esl_connected?: boolean;
}
