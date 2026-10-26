/**
 * The API Reference's content, one SectionDoc per /docs/api section
 * (docProducts.ts API_SECTIONS). Exhaustive by type: a new section slug
 * fails to compile until its content is added here.
 */
import type { ApiSection } from '../../docProducts';
import type { EndpointDoc, SectionDoc } from '../types';
import { CALLS } from './calls';
import { NUMBERS } from './numbers';
import { START } from './start';
import { TRUNKING } from './trunking';
import { VOICEMAIL } from './voicemail';

export const API_SECTION_DOCS: Readonly<Record<ApiSection, SectionDoc>> = {
  start: START,
  numbers: NUMBERS,
  calls: CALLS,
  voicemail: VOICEMAIL,
  trunking: TRUNKING,
};

/** Every endpoint in a section, in reading order. */
export function sectionEndpoints(doc: SectionDoc): EndpointDoc[] {
  return doc.groups.flatMap((g) => g.entries.filter((e): e is EndpointDoc => e.kind === 'endpoint'));
}
