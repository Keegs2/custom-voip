export type IvrVerbType = 'say' | 'play' | 'gather' | 'dial' | 'hangup' | 'pause';

export interface IvrNode {
  id: string;
  type: IvrVerbType;
  /** Verb-specific configuration (keys depend on verb type) */
  config: Record<string, unknown>;
  /** Display prompt / label shown in the builder */
  prompt?: string;
  /** Outgoing branches keyed by digit or outcome (e.g. "1", "timeout", "default") */
  branches: Record<string, string>;
}

export interface IvrFlow {
  id: number;
  name: string;
  description?: string | null;
  did?: string | null;
  nodes: IvrNode[];
  entry_node_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface IvrFlowListItem {
  id: number;
  name: string;
  description?: string | null;
  did?: string | null;
  node_count: number;
  created_at: string;
  updated_at: string;
}

export interface IvrFlowSave {
  name: string;
  description?: string | null;
  did?: string | null;
  nodes: IvrNode[];
  entry_node_id: string | null;
}
