/**
 * Inline SVG icons for the User Detail page. Every export is a small component
 * (so this file only exports components, keeping react-refresh happy).
 * `currentColor` lets the parent tint via the surrounding style.
 */

type IconProps = { size?: number };

const s = (size: number) => ({ width: size, height: size });

export const IconPhone = ({ size = 18 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={s(size)}>
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.05 6.05l1.96-1.84a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 14.92Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconVoicemail = ({ size = 18 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={s(size)}>
    <circle cx="6.5" cy="12" r="4.5" />
    <circle cx="17.5" cy="12" r="4.5" />
    <line x1="6.5" y1="16.5" x2="17.5" y2="16.5" />
  </svg>
);

export const IconChat = ({ size = 18 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={s(size)}>
    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconDevices = ({ size = 18 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={s(size)}>
    <rect x="2" y="3" width="20" height="14" rx="2" />
    <path d="M8 21h8M12 17v4" strokeLinecap="round" />
  </svg>
);

export const IconGear = ({ size = 16 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={s(size)}>
    <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconPhoneForwarded = ({ size = 16 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={s(size)}>
    <polyline points="19 8 23 12 19 16" strokeLinecap="round" strokeLinejoin="round" />
    <line x1="23" y1="12" x2="13" y2="12" strokeLinecap="round" />
    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6.05 6.05l1.96-1.84a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 14.92Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconCode = ({ size = 16 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={s(size)}>
    <polyline points="16 18 22 12 16 6" strokeLinecap="round" strokeLinejoin="round" />
    <polyline points="8 6 2 12 8 18" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconNetwork = ({ size = 16 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={s(size)}>
    <circle cx="18" cy="5" r="3" />
    <circle cx="6" cy="12" r="3" />
    <circle cx="18" cy="19" r="3" />
    <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" strokeLinecap="round" />
    <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" strokeLinecap="round" />
  </svg>
);

export const IconZap = ({ size = 16 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={s(size)}>
    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconUsers = ({ size = 15 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={s(size)}>
    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx="9" cy="7" r="4" />
    <path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" strokeLinecap="round" />
  </svg>
);

export const IconSearch = ({ size = 15 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={{ ...s(size), flexShrink: 0 }}>
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.35-4.35" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconX = ({ size = 12 }: IconProps) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={s(size)}>
    <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
  </svg>
);

export const IconPencil = ({ size = 12 }: IconProps) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={s(size)}>
    <path d="M11.5 2.5a2.121 2.121 0 0 1 3 3L5 15l-4 1 1-4 9.5-9.5Z" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconExternal = ({ size = 11 }: IconProps) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={s(size)}>
    <path d="M6 3h7v7M13 3 3 13" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconChevronLeft = ({ size = 13 }: IconProps) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={s(size)}>
    <path d="M10 3L5 8l5 5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconSave = ({ size = 12 }: IconProps) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={s(size)}>
    <path d="M13 2H5L2 5v9h12V2Z" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M10 2v4H5V2M5 9h6" strokeLinecap="round" />
  </svg>
);

export const IconReset = ({ size = 14 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={s(size)}>
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M3 3v5h5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconDndOff = ({ size = 14 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} style={s(size)}>
    <circle cx="12" cy="12" r="10" />
    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
  </svg>
);

export const IconInfo = ({ size = 16 }: IconProps) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={s(size)}>
    <circle cx="12" cy="12" r="10" />
    <line x1="12" y1="8" x2="12" y2="12" /><line x1="12" y1="16" x2="12.01" y2="16" />
  </svg>
);

export const IconInbound = ({ size = 10 }: IconProps) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={s(size)}>
    <path d="M14 2L2 14M2 14h8M2 14V6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const IconOutbound = ({ size = 10 }: IconProps) => (
  <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={2} style={s(size)}>
    <path d="M2 14L14 2M14 2H6M14 2v8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
