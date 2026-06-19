/**
 * IVR compiler — STUB (P0).
 *
 * P1 will compile the graph into the exact nested-tree shape `ivr.py` already
 * consumes (`flow_config.nodes[*].{type,config,prompt,branches}`), reusing the
 * legacy `ivrUtils.nodesToXml` emission, so the existing FreeSWITCH/Lua runtime
 * serves it unchanged. For now the signature is correct and the body throws.
 */
import type { FlowCompiler, ValidationResult } from './types';

/**
 * The artifact `ivr.py` reads from `ivr_flows.flow_config`. Kept loose for P0;
 * P1 will pin it to the runtime's nested-tree schema.
 */
export interface IvrArtifact {
  nodes: unknown[];
}

export const ivrCompiler: FlowCompiler<IvrArtifact> = {
  product: 'ivr',

  // Params are omitted in the stub (a narrower function still satisfies the
  // FlowCompiler signature). P1 reintroduces `doc` and walks the graph.
  validate(): ValidationResult {
    // TODO(P1): implement the §6.1 rule set (single entry, no orphans, terminal
    // coverage, menu branch/timeout coverage, dial E.164/ext validation, …).
    return { ok: true, issues: [] };
  },

  compile(): IvrArtifact {
    // TODO(P1): walk from `entry`, emit the legacy nested IVR tree / TwiML.
    throw new Error('ivrCompiler.compile is not implemented yet (P1)');
  },
};
