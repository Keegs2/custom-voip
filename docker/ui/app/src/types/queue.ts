/**
 * Call-queue (ACD) monitoring.
 *
 * `GET /queues` returns a lightweight `{ name, depth }` summary per queue.
 * `GET /queues/{name}` drills into the waiting members. Both are tenant-scoped
 * and may be empty when the FreeSWITCH ESL bridge is down (`esl_connected:false`).
 */
export interface QueueSummary {
  name: string;
  depth: number;
}

export interface QueueMember {
  /** Channel/member uuid where available */
  uuid?: string;
  caller?: string;
  dest?: string;
  /** Seconds the caller has been waiting, when reported by the API */
  wait_ms?: number;
  state?: string;
  [key: string]: unknown;
}

export interface QueuesResponse {
  queues: QueueSummary[];
  esl_connected?: boolean;
}

export interface QueueDetail {
  name: string;
  depth: number;
  members: QueueMember[];
  esl_connected?: boolean;
}
