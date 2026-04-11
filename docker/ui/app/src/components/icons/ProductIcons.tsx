/**
 * Shared product icons using lucide-react.
 * All icons accept a `size` prop (default 18px for sidebar, 24px for pages, 28px for dashboard).
 */

import {
  PhoneForwarded,
  Server,
  Code2,
  GitBranch,
  BookOpen,
  Settings,
  BarChart3,
  Wrench,
  Voicemail,
} from 'lucide-react';

interface IconProps {
  size?: number;
}

/** RCF — phone forwarding */
export function IconRCF({ size = 18 }: IconProps) {
  return <PhoneForwarded size={size} strokeWidth={1.6} />;
}

/** SIP Trunks — server */
export function IconTrunk({ size = 18 }: IconProps) {
  return <Server size={size} strokeWidth={1.6} />;
}

/** API Calling — code brackets */
export function IconAPI({ size = 18 }: IconProps) {
  return <Code2 size={size} strokeWidth={1.6} />;
}

/** IVR Builder — flow/branching */
export function IconIVR({ size = 18 }: IconProps) {
  return <GitBranch size={size} strokeWidth={1.6} />;
}

/** API Docs — open book */
export function IconDocs({ size = 18 }: IconProps) {
  return <BookOpen size={size} strokeWidth={1.6} />;
}

/** Administration — gear/settings */
export function IconAdmin({ size = 18 }: IconProps) {
  return <Settings size={size} strokeWidth={1.6} />;
}

/** Call Quality — signal/chart bars */
export function IconSignal({ size = 18 }: IconProps) {
  return <BarChart3 size={size} strokeWidth={1.6} />;
}

/** Troubleshooting — wrench */
export function IconTroubleshoot({ size = 18 }: IconProps) {
  return <Wrench size={size} strokeWidth={1.6} />;
}

/** Voicemail */
export function IconVoicemail({ size = 18 }: IconProps) {
  return <Voicemail size={size} strokeWidth={1.6} />;
}
