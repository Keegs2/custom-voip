/**
 * AI Voice Agents — public product guide (route `/docs/ai-agents`).
 * Content lives in `guides/aiAgents.tsx`. Public (outside RequireAuth),
 * inside AppLayout — no top padding.
 */

import { ProductGuide } from './components/ProductGuide';
import { aiAgentsGuide } from './guides/aiAgents';

export function AiAgentsDocsPage() {
  return <ProductGuide data={aiAgentsGuide} />;
}
