/**
 * Visual IVR — the shapes the portal exchanges with the API.
 *
 * Binding contract: docs/IVR_INTERFACES.md
 *   §2   the draft graph (`call_flows.draft_graph`, `call_flow_versions.graph`)
 *   §8.2 the customer IVR API (P1 serves it, this UI consumes it)
 *
 * The graph is the ONLY thing the browser ever sends about call logic. The
 * server compiles it into the executable plan (§3) at publish time; the
 * browser's own compile (src/flow/compile/ivr.ts) is for instant validation
 * and the "what callers hear" preview only, and its output is never sent.
 *
 * JSON bodies are snake_case (the API's convention); the graph's own keys
 * are camelCase exactly as §2 pins them (`timeoutSec`, `passCallerId` …).
 *
 * This file is type-only and dependency-free so the pure builder modules
 * (and their node-run self-tests) can import it.
 */

/* ─── §2 Draft graph ──────────────────────────────────────── */

/** The nine v1 blocks (D10: the `product` seam lets other palettes join later). */
export type IvrNodeType =
  | 'entry'
  | 'play'
  | 'menu'
  | 'schedule'
  | 'condition'
  | 'dial'
  | 'voicemail'
  | 'goto'
  | 'hangup';

/** `ivr_prompts.id` — owned by the flow's customer, not deleted. */
export type PromptId = number;

/** A key a caller can press. */
export type MenuDigit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | '*' | '#';

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

/** `["09:00", "17:00"]` — 24-hour, start < end, `"24:00"` = end of day. */
export type TimeRange = [string, string];

/** The pinned timezone list (§2) — FreeSWITCH's schedule table carries all of them. */
export type IvrTimezone =
  | 'America/New_York'
  | 'America/Detroit'
  | 'America/Chicago'
  | 'America/Denver'
  | 'America/Phoenix'
  | 'America/Los_Angeles'
  | 'America/Anchorage'
  | 'Pacific/Honolulu'
  | 'America/Puerto_Rico';

export type EntryConfig = Record<string, never>;

export interface PlayConfig {
  /** 1–10, played in order. */
  prompts: PromptId[];
}

export interface MenuConfig {
  /** 1–10, played in order while listening for a key (barge-in). */
  prompts: PromptId[];
  /** Subset of 0-9 * #, 1–12, unique. Each one is an exit `d:<digit>`. */
  digits: MenuDigit[];
  /** 1–30 seconds to wait for a key. */
  timeoutSec: number;
  /** 0–5 re-prompts before the no-input / invalid exit. */
  retries: number;
  invalidPrompts?: PromptId[];
  noInputPrompts?: PromptId[];
}

export interface ScheduleConfig {
  tz: IvrTimezone;
  weekly: Record<DayKey, TimeRange[]>;
  /** "YYYY-MM-DD" days the line is closed all day (holidays). */
  closedDates: string[];
}

export type ConditionMode = 'prefix' | 'equals' | 'anonymous';

export interface ConditionConfig {
  mode: ConditionMode;
  /** 1–50 values; empty for `anonymous`. */
  values: string[];
}

/** One of the customer's own numbers, or an outside US number (D3/D4). */
export type DialTarget = { kind: 'own'; did: string } | { kind: 'external'; number: string };

export interface DialConfig {
  target: DialTarget;
  /** D5: true = show the caller's number, false = show this IVR's number. */
  passCallerId: boolean;
  /** 5–120 seconds before the No answer exit. */
  ringTimeoutSec: number;
}

export interface VoicemailConfig {
  /** One of the customer's voicemail DIDs. */
  did: string;
}

export interface GotoConfig {
  targetNodeId: string;
}

export interface HangupConfig {
  prompts?: PromptId[];
}

/** `type` → its `config` (§2 table). */
export interface IvrConfigMap {
  entry: EntryConfig;
  play: PlayConfig;
  menu: MenuConfig;
  schedule: ScheduleConfig;
  condition: ConditionConfig;
  dial: DialConfig;
  voicemail: VoicemailConfig;
  goto: GotoConfig;
  hangup: HangupConfig;
}

export type IvrConfigOf<T extends IvrNodeType> = IvrConfigMap[T];

/**
 * One block. Discriminated on `type` so `node.data.config` narrows with it.
 * Unknown keys from the server are preserved round-trip (src/flow/model/graph.ts).
 */
export type IvrNode = {
  [T in IvrNodeType]: {
    id: string;
    type: T;
    position: { x: number; y: number };
    data: { label?: string; config: IvrConfigMap[T] };
  };
}[IvrNodeType];

export interface IvrEdge {
  id: string;
  source: string;
  /** `next` · `d:<digit>` · `noInput` · `noMatch` · `open` · `closed` · `match` · `noAnswer` */
  sourceHandle: string;
  target: string;
}

export interface IvrViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface IvrGraph {
  schemaVersion: 1;
  nodes: IvrNode[];
  edges: IvrEdge[];
  viewport?: IvrViewport;
}

/* ─── §8.2 API shapes ─────────────────────────────────────── */

export interface IvrNumber {
  id: number;
  did: string;
  name: string | null;
  flow_id: number | null;
  flow_name: string | null;
  /** Admin kill switch (TED). Off = the number rejects calls. */
  enabled: boolean;
  max_channels: number;
  /** The bound flow has a published version (callers hear it). */
  published: boolean;
}

export interface FlowSummary {
  id: number;
  name: string;
  /** Optimistic lock — +1 per draft write. */
  revision: number;
  published_version: number | null;
  published_at: string | null;
  updated_at: string;
  /** DIDs bound to this flow. */
  numbers: string[];
}

export interface Flow extends FlowSummary {
  draft_graph: IvrGraph;
}

/** Per-customer limits. Every key is optional: P1 owns the exact set. */
export interface IvrLimits {
  max_prompts?: number;
  max_prompt_seconds?: number;
  max_audio_bytes?: number;
  max_blocks?: number;
  max_flows?: number;
  [key: string]: number | undefined;
}

export interface IvrSummary {
  enabled: boolean;
  numbers: IvrNumber[];
  flows: FlowSummary[];
  limits: IvrLimits;
}

export type PromptKind = 'tts' | 'upload' | 'recording';

export interface Prompt {
  id: PromptId;
  name: string;
  kind: PromptKind;
  tts_text?: string | null;
  tts_voice?: string | null;
  duration_ms: number;
  bytes: number;
  created_at: string;
}

/** A validation finding. `message` is customer-readable English. */
export interface Issue {
  code: string;
  message: string;
  node_id?: string | null;
  handle?: string | null;
}

export interface ValidateResult {
  ok: boolean;
  errors: Issue[];
  warnings: Issue[];
}

export interface PublishResult {
  version: number;
  published_at: string;
  /** Server-defined; the UI shows only fields it recognises. */
  plan_summary: Record<string, unknown> | null;
}

export interface FlowVersion {
  version: number;
  published_at: string;
  published_by_email?: string | null;
}

export interface FlowVersionDetail {
  version: number;
  graph: IvrGraph;
  published_at: string;
}

export interface SimulateRequest {
  draft_graph?: IvrGraph;
  /** E.164, or `anonymous` for a withheld caller ID. */
  caller: string;
  /** ISO 8601 instant the call happens at. */
  at: string;
  digits: string[];
}

export interface SimStep {
  node_id: string;
  kind: string;
  /** Prompt NAMES, in the order the caller hears them. */
  says: string[];
  note: string;
}

export interface SimulateResult {
  steps: SimStep[];
  /** Server-defined (a sentence, or an object such as `{ exit, transfer_to }`). */
  outcome: unknown;
}

export type DestinationProduct = 'rcf' | 'voicemail' | 'ivr' | 'trunk';

export interface DestinationNumber {
  did: string;
  name: string | null;
  enabled: boolean;
  /** Human text: "Forwards to +1 774-404-5256", "Mailbox: Front desk". */
  detail: string | null;
}

export interface DestinationGroup {
  product: DestinationProduct;
  label: string;
  numbers: DestinationNumber[];
}

export interface Destinations {
  groups: DestinationGroup[];
}

export interface Voice {
  id: string;
  label: string;
  gender: 'female' | 'male';
  license: string;
}

export interface PlaybackUrl {
  url: string;
}

/* ─── Request bodies ──────────────────────────────────────── */

export interface FlowCreate {
  name: string;
  draft_graph?: IvrGraph;
}

export interface FlowUpdate {
  name?: string;
  draft_graph?: IvrGraph;
  revision: number;
}

export interface NumberUpdate {
  name?: string | null;
  flow_id?: number | null;
}

export interface TtsPromptCreate {
  name: string;
  text: string;
  voice: string;
}
