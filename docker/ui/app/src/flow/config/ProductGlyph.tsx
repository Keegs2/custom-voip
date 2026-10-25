/** The product icon for one of the customer's own numbers (transfer picker, destination card). */
import { Network, PhoneForwarded, Voicemail, Workflow } from 'lucide-react';
import type { DestinationProduct } from '../../types/ivr';

export function ProductGlyph({ product, size = 14 }: { product: DestinationProduct | string; size?: number }) {
  if (product === 'voicemail') return <Voicemail size={size} aria-hidden="true" />;
  if (product === 'ivr') return <Workflow size={size} aria-hidden="true" />;
  if (product === 'trunk') return <Network size={size} aria-hidden="true" />;
  return <PhoneForwarded size={size} aria-hidden="true" />;
}
