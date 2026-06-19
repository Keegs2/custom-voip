/**
 * Universal Call Flow Builder — data model.
 *
 * `CallFlowDoc` is the single, product-agnostic source of truth: a directed
 * graph of typed `FlowNode`s connected by `FlowEdge`s (Twilio-Studio-style
 * states + transitions). It maps cleanly onto React Flow's `nodes`/`edges`
 * (positions and viewport live here so the canvas is fully reconstructable)
 * and is compiled per-product into the relevant backend artifact (see
 * `../compile`).
 *
 * Shape is pinned to CALL_FLOW_BUILDER_PLAN.md §2.2. For P0 the per-type
 * `NodeConfig` arms are minimal stubs — the union *shape* and field names
 * match the plan so P1 only has to fill the bodies in.
 */

/* ─── Product + node taxonomy ──────────────────────────────────────────── */

/** A product = entry binding + allowed palette + compile target. */
export type ProductKind =
  | 'ivr' // programmable voice (the rich TwiML runtime we already have)
  | 'rcf' // remote call forwarding
  | 'trunk' // SIP trunk inbound routing
  | 'api' // API calling (webhook-driven voice)
  | 'conference' // conference entry flow
  | 'ucaas'; // find-me/follow-me, voicemail fallback

/** Every node kind the builder can render. Palettes expose a per-product subset. */
export type NodeType =
  | 'entry' // the single trigger / call-arrives node (one per flow)
  | 'answer'
  | 'say'
  | 'play'
  | 'pause'
  | 'menu' // Gather: collect digits, branch per digit
  | 'dial' // Dial/Forward to a PSTN/SIP destination
  | 'ringGroup' // ring N destinations simultaneously/sequentially
  | 'route' // SIP trunk inbound: try PBX endpoints in order/parallel
  | 'schedule' // time-of-day / holiday routing
  | 'condition' // generic branch (caller-id, variable, %-split)
  | 'record'
  | 'voicemail'
  | 'conference'
  | 'queue'
  | 'webhook' // HTTP call out, branch on response
  | 'goto' // jump to another node (loops, shared subtrees)
  | 'redirect' // TwiML <Redirect> — hand control to another URL/flow
  | 'reject'
  | 'hangup';

/* ─── Per-node config (discriminated union keyed on `type`) ─────────────── */

/** Time-of-day / holiday rule used by `schedule` nodes. */
export interface ScheduleRule {
  /** Stable id so the matching outgoing edge handle can reference it. */
  id: string;
  label?: string;
  /** 0–6 (Sun–Sat); empty = every day. */
  days?: number[];
  /** "HH:MM" 24h local-to-`tz`. */
  start?: string;
  end?: string;
}

/**
 * One ordered destination in a find-me/follow-me ring plan (`ringGroup` node).
 * `to` is a PSTN/SIP destination; the optional per-leg `timeout` overrides the
 * group `ringTimeout` for that leg (used by the `sequential` strategy).
 */
export interface RingLeg {
  to: string;
  timeout?: number;
}

/**
 * One ordered PBX endpoint in a SIP-trunk inbound route plan (`route` node).
 * `to` is the trunk's delivery target (an `endpoint_ips` entry / SIP URI); the
 * optional per-endpoint `timeout` overrides the group `timeout` for that attempt
 * (used by the `failover` strategy).
 */
export interface RouteEndpoint {
  to: string;
  timeout?: number;
}

/** Branch predicate carried on an edge (e.g. condition / %-split arms). */
export interface EdgeCondition {
  /** What the runtime compares — caller id, a variable, a random %-split, … */
  kind: 'callerId' | 'variable' | 'percent' | 'else';
  /** Dotted path / variable name for `kind: 'variable'`. */
  field?: string;
  operator?: 'eq' | 'neq' | 'matches' | 'in' | 'gt' | 'lt';
  value?: string | number;
}

/**
 * Typed config per `NodeType`. P0 keeps the bodies minimal — the union shape
 * is what matters so P1 can flesh out each arm without breaking callers.
 */
export type NodeConfig =
  | { type: 'entry' }
  | { type: 'answer' }
  | { type: 'say'; text: string; voice: string; language?: string }
  | { type: 'play'; url: string; loop?: number }
  | { type: 'pause'; seconds: number }
  | {
      type: 'menu';
      /** Spoken/played menu prompt, compiled into a Say inside the <Gather>. */
      prompt?: string;
      voice?: string;
      /** Enabled option keys ('0'-'9','*','#') — each gets a source handle. */
      digits: string[];
      /** Digits to collect before submitting (TwiML numDigits). */
      numDigits?: number;
      timeout: number;
      finishOnKey?: string;
    }
  | {
      type: 'dial';
      /** Forward destination. For RCF this compiles to `forward_to`. */
      number: string;
      callerId?: string;
      /** Ring timeout (seconds). For RCF this compiles to `ring_timeout`. */
      timeout: number;
      record?: boolean;
      /** RCF-only: pass the original caller's CID through (`pass_caller_id`). */
      passCallerId?: boolean;
      /** RCF-only: max concurrent channels to the destination (`max_channels`). */
      maxChannels?: number;
    }
  | {
      type: 'ringGroup';
      /** Ring legs in order; `sequential` rings them one-by-one, `parallel` all at once. */
      strategy: 'sequential' | 'parallel';
      /** Group ring timeout (seconds). Compiles to `ring_timeout`. */
      ringTimeout: number;
      /** Ordered destinations. Each compiles to a `legs[]` entry `{to, timeout?}`. */
      legs: RingLeg[];
    }
  | {
      type: 'route';
      /**
       * `failover` tries endpoints in order until one answers; `parallel` rings
       * all endpoints at once, first to answer wins.
       */
      strategy: 'failover' | 'parallel';
      /** Overall route timeout (seconds). Compiles to `timeout`. */
      timeout: number;
      /** Ordered PBX endpoints. Each compiles to an `endpoints[]` entry `{to, timeout?}`. */
      endpoints: RouteEndpoint[];
    }
  | { type: 'schedule'; tz: string; rules: ScheduleRule[] }
  | { type: 'condition'; conditions: EdgeCondition[] }
  | {
      type: 'record';
      maxLength?: number;
      playBeep?: boolean;
      finishOnKey?: string;
      transcribe?: boolean;
    }
  | { type: 'voicemail'; greeting?: string; mailbox?: string }
  | {
      type: 'conference';
      room: string;
      muted?: boolean;
      beep?: boolean;
      waitForModerator?: boolean;
      maxParticipants?: number;
      record?: boolean;
    }
  | { type: 'queue'; name: string; timeout?: number }
  | { type: 'webhook'; url: string; method?: 'GET' | 'POST' }
  | { type: 'goto'; targetNodeId: string }
  | { type: 'redirect'; url: string; method?: 'GET' | 'POST' }
  | { type: 'reject'; reason?: string }
  | { type: 'hangup' };

/** Narrow `NodeConfig` to the arm matching a given `NodeType`. */
export type ConfigForType<T extends NodeType> = Extract<NodeConfig, { type: T }>;

/* ─── Graph primitives ─────────────────────────────────────────────────── */

export interface FlowNode<C extends NodeConfig = NodeConfig> {
  id: string; // nanoid
  type: NodeType;
  position: { x: number; y: number };
  data: {
    label?: string; // user-facing name
    config: C; // typed per NodeType (discriminated union)
  };
}

export interface FlowEdge {
  id: string;
  source: string; // node id
  /**
   * Which outcome this edge leaves the source by: 'next' | a digit '1'..'#' |
   * 'timeout' | 'noMatch' | 'busy' | 'noAnswer' | a schedule-rule id, …
   */
  sourceHandle?: string | null;
  target: string;
  targetHandle?: string | null;
  data?: { label?: string; condition?: EdgeCondition };
}

/* ─── Entry binding — the product seam ─────────────────────────────────── */

/**
 * The whole abstraction: the *flow* is identical machinery; the *product* is
 * (entry binding) + (palette subset) + (compile target). One editor, six bindings.
 */
export type EntryBinding =
  | { kind: 'did'; did: string } // ivr / api / rcf
  | { kind: 'trunk'; trunkId: number } // trunk inbound
  | { kind: 'conference'; confId: string } // conference entry
  | { kind: 'extension'; ext: string }; // ucaas find-me/follow-me

/* ─── The document ─────────────────────────────────────────────────────── */

export interface CallFlowDoc {
  schemaVersion: 1;
  id: number | null; // persisted flow id (null = unsaved)
  product: ProductKind; // selects palette + compiler
  name: string;
  customerId: number | null;
  entry: EntryBinding;
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport?: { x: number; y: number; zoom: number };
  status: 'draft' | 'published';
  version: number;
  updatedAt?: string;
}
