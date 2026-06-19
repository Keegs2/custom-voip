/**
 * Product → compiler registry (plan §4.1). Lets the toolbar/publish flow look
 * up the right compiler by `ProductKind`. P0 registers only the IVR stub; P1+
 * adds rcf/api/trunk/conference/ucaas.
 */
import type { ProductKind } from '../model/types';
import type { FlowCompiler } from './types';
import { ivrCompiler } from './ivr';

/** Compilers keyed by product. Partial until every product is implemented. */
export const compilers: Partial<Record<ProductKind, FlowCompiler<unknown>>> = {
  ivr: ivrCompiler as FlowCompiler<unknown>,
};

export function getCompiler(product: ProductKind): FlowCompiler<unknown> | undefined {
  return compilers[product];
}
