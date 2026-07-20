/**
 * Static product tiles for the unified-communications hub. Each tile keeps its
 * own product accent (a justified per-product override, mirroring the Sidebar's
 * per-product hues) while the surrounding chrome leads with the app blue glass.
 *
 * Pure data module — exports a single const (no components), so this stays out
 * of the way of react-refresh's only-export-components rule.
 */

import { GLASS } from '../../components/glass/glass';
import type { FeatureCardDef } from './types';
import { IconChat, IconVideo, IconFolder, IconVoicemail } from './components/icons';

export const FEATURE_CARDS: FeatureCardDef[] = [
  {
    title: 'Chat',
    description: 'Real-time messaging with your team. Direct messages and group conversations.',
    to: '/chat',
    accent: GLASS.accent, // app blue
    icon: <IconChat color={GLASS.accent} />,
  },
  {
    title: 'Meetings',
    description: 'Video meetings with screen sharing, recording, and scheduling.',
    to: '/conference',
    accent: GLASS.green,
    icon: <IconVideo color={GLASS.green} />,
  },
  {
    title: 'Documents',
    description: 'Shared document storage for your organization.',
    to: '/documents',
    accent: GLASS.warning,
    icon: <IconFolder color={GLASS.warning} />,
  },
  {
    title: 'Voicemail',
    description: 'Listen to voicemail messages and manage greetings.',
    to: '/voicemail',
    accent: '#818cf8',
    icon: <IconVoicemail color="#818cf8" />,
  },
];
