/**
 * BuilderData — server data every builder panel reads (React Query
 * results, loaded once by FlowBuilder): the account's messages, its numbers
 * for the transfer picker, and this flow's own numbers.
 */
import { createContext, useContext } from 'react';
import type { Destinations, Prompt } from '../types/ivr';

export interface BuilderData {
  prompts: readonly Prompt[] | undefined;
  destinations: Destinations | undefined;
  destinationsLoading: boolean;
  destinationsFailed: boolean;
  /** DIDs bound to this flow (self-transfer guard, "answers on"). */
  ownDids: readonly string[];
  /** View only: tenant 'readonly', or a published version on screen. */
  readOnly: boolean;
}

export const BuilderDataContext = createContext<BuilderData | null>(null);

export function useBuilderData(): BuilderData {
  const d = useContext(BuilderDataContext);
  if (!d) throw new Error('useBuilderData outside BuilderDataContext');
  return d;
}
