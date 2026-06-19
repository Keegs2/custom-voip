/**
 * Product → compiler registry (plan §4.1). Lets the toolbar/publish flow look
 * up the right compiler by `ProductKind`, plus thin `validateFlow`/`compileFlow`
 * helpers so callers never have to branch on the product themselves.
 *
 *  - `ivr`        → ivrCompiler (nested IVR tree → `ivr_flows.flow_config`)
 *  - `api`        → ivrCompiler (same webhook-TwiML sink, different product tag)
 *  - `conference` → ivrCompiler (a conference flow IS an IVR tree with a
 *                   `conference` node → `{nodes:[...]}`)
 *  - `rcf`        → rcfCompiler (FLAT `{forward_to, …}` → `rcf_numbers` columns)
 */
import type { CallFlowDoc, ProductKind } from '../model/types';
import type { FlowCompiler, ValidationResult } from './types';
import { ivrCompiler } from './ivr';
import { rcfCompiler } from './rcf';

/** Compilers keyed by product. Partial until every product is implemented. */
export const compilers: Partial<Record<ProductKind, FlowCompiler<unknown>>> = {
  ivr: ivrCompiler as FlowCompiler<unknown>,
  // api reuses the IVR (webhook TwiML) compiler — same nested-tree sink.
  api: ivrCompiler as FlowCompiler<unknown>,
  // conference IS an IVR tree containing a `conference` node — reuse the IVR compiler.
  conference: ivrCompiler as FlowCompiler<unknown>,
  // rcf compiles to the flat rcf_numbers shape (not a node tree).
  rcf: rcfCompiler as FlowCompiler<unknown>,
};

export function getCompiler(product: ProductKind): FlowCompiler<unknown> | undefined {
  return compilers[product];
}

/** Validate a doc with its product's compiler (empty/ok if none registered). */
export function validateFlow(doc: CallFlowDoc): ValidationResult {
  const compiler = getCompiler(doc.product);
  return compiler ? compiler.validate(doc) : { ok: true, issues: [] };
}

/** Compile a doc with its product's compiler (null if none registered). */
export function compileFlow(doc: CallFlowDoc): unknown {
  const compiler = getCompiler(doc.product);
  return compiler ? compiler.compile(doc) : null;
}
