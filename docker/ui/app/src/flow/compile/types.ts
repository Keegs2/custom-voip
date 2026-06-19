/**
 * Compiler seam (plan §2.4). The `CallFlowDoc` graph is the source of truth;
 * each product has a pure `FlowCompiler` that validates the graph and emits the
 * backend's native artifact. P0 only defines the interface + a stub; the real
 * per-product compilers are P1+.
 */
import type { CallFlowDoc, ProductKind } from '../model/types';

/** A single validation finding, surfaced in the validation panel (P1). */
export interface ValidationIssue {
  severity: 'error' | 'warning';
  message: string;
  /** Node this finding is anchored to (click-to-focus on canvas). */
  nodeId?: string;
  /** Edge this finding is anchored to. */
  edgeId?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
}

/**
 * Turns a product-agnostic graph into a product-specific backend artifact.
 * `TArtifact` is the compiled shape written to that product's sink on publish.
 */
export interface FlowCompiler<TArtifact> {
  product: ProductKind;
  /** Pure, runs on every store change (P1) — never throws. */
  validate(doc: CallFlowDoc): ValidationResult;
  /** Graph → backend artifact. May throw if `validate` would have failed. */
  compile(doc: CallFlowDoc): TArtifact;
}
