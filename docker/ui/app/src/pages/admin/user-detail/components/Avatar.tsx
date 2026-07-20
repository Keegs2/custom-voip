/**
 * Avatar — a rounded, gradient-filled initial tile coloured deterministically
 * from the user's name.
 */

import { getAvatarColor } from '../helpers';

interface AvatarProps {
  name: string;
  size?: number;
}

export function Avatar({ name, size = 64 }: AvatarProps) {
  const color = getAvatarColor(name);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.25,
        background: `linear-gradient(135deg, ${color}30 0%, ${color}18 100%)`,
        border: `2px solid ${color}50`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.4,
        fontWeight: 800,
        color,
        flexShrink: 0,
        letterSpacing: '-0.02em',
        boxShadow: `0 0 24px ${color}20`,
      }}
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}
