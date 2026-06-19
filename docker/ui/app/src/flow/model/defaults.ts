/**
 * Factory helpers for the flow model. Centralises id generation (nanoid) and
 * the default `NodeConfig` per `NodeType`, so the store and palette never
 * hand-roll node shapes. Mirrors the role of the legacy `ivrUtils.makeNode`.
 */
import { nanoid } from 'nanoid';
import type {
  CallFlowDoc,
  ConfigForType,
  EntryBinding,
  FlowNode,
  NodeConfig,
  NodeType,
  ProductKind,
} from './types';

/** Short, collision-resistant id for nodes and edges. */
export function newId(): string {
  return nanoid(10);
}

/**
 * Per-type config factories. Typed as `{ [K in NodeType]: () => ConfigForType<K> }`
 * so indexing by a generic `T` yields `ConfigForType<T>` with no casts, and each
 * call returns a fresh object (never a shared mutable default). Adding a
 * `NodeType` without a factory here is a compile error.
 */
const CONFIG_FACTORIES: { [K in NodeType]: () => ConfigForType<K> } = {
  entry: () => ({ type: 'entry' }),
  answer: () => ({ type: 'answer' }),
  say: () => ({ type: 'say', text: '', voice: 'default' }),
  play: () => ({ type: 'play', url: '' }),
  pause: () => ({ type: 'pause', seconds: 1 }),
  menu: () => ({ type: 'menu', numDigits: 1, timeout: 5 }),
  dial: () => ({ type: 'dial', number: '', timeout: 30 }),
  ringGroup: () => ({ type: 'ringGroup', members: [], strategy: 'simul', timeout: 30 }),
  schedule: () => ({ type: 'schedule', tz: 'America/New_York', rules: [] }),
  condition: () => ({ type: 'condition', conditions: [] }),
  record: () => ({ type: 'record' }),
  voicemail: () => ({ type: 'voicemail' }),
  conference: () => ({ type: 'conference', room: '' }),
  queue: () => ({ type: 'queue', name: '' }),
  webhook: () => ({ type: 'webhook', url: '', method: 'POST' }),
  goto: () => ({ type: 'goto', targetNodeId: '' }),
  reject: () => ({ type: 'reject' }),
  hangup: () => ({ type: 'hangup' }),
};

/** Default, fully-typed config for a freshly-dropped node of `type`. */
export function defaultConfig<T extends NodeType>(type: T): ConfigForType<T> {
  return CONFIG_FACTORIES[type]();
}

/** Human-friendly default label per node type. */
const DEFAULT_LABELS: Record<NodeType, string> = {
  entry: 'Call Arrives',
  answer: 'Answer',
  say: 'Say',
  play: 'Play Audio',
  pause: 'Pause',
  menu: 'Menu',
  dial: 'Dial',
  ringGroup: 'Ring Group',
  schedule: 'Schedule',
  condition: 'Condition',
  record: 'Record',
  voicemail: 'Voicemail',
  conference: 'Conference',
  queue: 'Queue',
  webhook: 'Webhook',
  goto: 'Go To',
  reject: 'Reject',
  hangup: 'Hangup',
};

export function defaultLabel(type: NodeType): string {
  return DEFAULT_LABELS[type];
}

/** Build a new, fully-typed node ready to insert into the store. */
export function makeNode(
  type: NodeType,
  position: { x: number; y: number },
  overrides?: { label?: string; config?: NodeConfig },
): FlowNode {
  return {
    id: newId(),
    type,
    position,
    data: {
      label: overrides?.label ?? defaultLabel(type),
      config: overrides?.config ?? defaultConfig(type),
    },
  };
}

/** An empty, unsaved draft document for a given product. */
export function emptyDoc(
  product: ProductKind,
  entry: EntryBinding = { kind: 'did', did: '' },
): CallFlowDoc {
  const entryNode = makeNode('entry', { x: 240, y: 80 });
  return {
    schemaVersion: 1,
    id: null,
    product,
    name: 'Untitled Flow',
    customerId: null,
    entry,
    nodes: [entryNode],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    status: 'draft',
    version: 1,
  };
}
