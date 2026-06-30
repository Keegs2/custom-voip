/**
 * Inline SVG icons for the Communications hub. This file only exports
 * components (keeping react-refresh / fast-refresh happy). Each icon paints in
 * `currentColor` by default so the surrounding style can tint it, or takes an
 * explicit `color` for the product accent.
 */

interface IconProps {
  size?: number;
  color?: string;
}

export const IconHeadset = ({ size = 32, color = 'currentColor' }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} style={{ width: size, height: size }}>
    <path d="M3.75 13.5a8.25 8.25 0 0 1 16.5 0" strokeLinecap="round" strokeLinejoin="round" />
    <path
      d="M3.75 13.5A2.25 2.25 0 0 0 1.5 15.75v1.5A2.25 2.25 0 0 0 3.75 19.5h.75V13.5h-.75ZM20.25 13.5A2.25 2.25 0 0 1 22.5 15.75v1.5A2.25 2.25 0 0 1 20.25 19.5H19.5V13.5h.75Z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const IconChat = ({ size = 28, color = 'currentColor' }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} style={{ width: size, height: size }}>
    <path
      d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const IconVideo = ({ size = 28, color = 'currentColor' }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} style={{ width: size, height: size }}>
    <path
      d="m15.75 10.5 4.72-4.72a.75.75 0 0 1 1.28.53v11.38a.75.75 0 0 1-1.28.53l-4.72-4.72M4.5 18.75h9a2.25 2.25 0 0 0 2.25-2.25v-9a2.25 2.25 0 0 0-2.25-2.25h-9A2.25 2.25 0 0 0 2.25 7.5v9a2.25 2.25 0 0 0 2.25 2.25Z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const IconFolder = ({ size = 28, color = 'currentColor' }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} style={{ width: size, height: size }}>
    <path
      d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v8.25A2.25 2.25 0 0 0 4.5 16.5h15a2.25 2.25 0 0 0 2.25-2.25V8.25A2.25 2.25 0 0 0 19.5 6h-5.379a1.5 1.5 0 0 1-1.06-.44Z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const IconVoicemail = ({ size = 28, color = 'currentColor' }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.6} style={{ width: size, height: size }}>
    <path d="M5.25 8.25a3 3 0 1 0 6 0 3 3 0 0 0-6 0ZM12.75 8.25a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M2.25 14.25h7.5M14.25 14.25h7.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconArrow = ({ size = 14, color = 'currentColor' }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} style={{ width: size, height: size, flexShrink: 0 }}>
    <path d="M4.5 12h15m0 0-6.75-6.75M19.5 12l-6.75 6.75" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
