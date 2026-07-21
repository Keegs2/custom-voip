/**
 * Programmable Voice — public product guide (route `/docs/programmable-voice`;
 * `/docs/api` redirects here). Content lives in `guides/programmableVoice.tsx`.
 * Public (outside RequireAuth), inside AppLayout — no top padding.
 */

import { ProductGuide } from './components/ProductGuide';
import { programmableVoiceGuide } from './guides/programmableVoice';

export function ProgrammableVoiceDocsPage() {
  return <ProductGuide data={programmableVoiceGuide} />;
}
