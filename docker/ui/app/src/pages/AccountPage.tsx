/**
 * AccountPage — the routed Account settings page (thin composition shell).
 *
 * Architecture (see docs/FRONTEND_GLASS_REFACTOR.md): this file owns layout +
 * composition + the single top-level auth read ONLY. All form state, mutations,
 * styles, and presentational pieces live in the co-located `account/` folder:
 *   account/hooks.ts       → useProfileForm / usePasswordForm (live PUT /auth/me)
 *   account/styles.ts      → centralised CSSProperties / builders
 *   account/components/     → frosted-glass cards, fields, banners, icons
 *   account/types.ts        → local types (UpdateMeBody, StatusState, ROLE_LABELS)
 *
 * The ambient GlassBackground + the app-wide spacing standard (top offset +
 * gutters) are owned by AppLayout — this page does NOT mount its own backdrop
 * and does NOT re-pad the top edge. It only constrains the form column to a
 * comfortable reading measure and centres it.
 *
 * React #310: the only hook (`useAuth`) sits at the very top, before the early
 * return.
 */

import { useAuth } from '../contexts/AuthContext';
import { heroBadge, heroBadgeDot, heroBadgeLabel, heroTitle, heroSubtitle } from './account/styles';
import { GlassProfileCard } from './account/components/GlassProfileCard';
import { GlassPasswordCard } from './account/components/GlassPasswordCard';

const COLUMN: React.CSSProperties = {
  maxWidth: 760,
  marginLeft: 'auto',
  marginRight: 'auto',
  width: '100%',
};

const CARD_STACK: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
};

export function AccountPage() {
  // ALL hooks first (React #310) — useAuth is the only hook here.
  const { user, refreshUser } = useAuth();

  if (!user) {
    return null;
  }

  return (
    <div style={COLUMN}>
      {/* Hero — sits flush with the layout top offset (no top margin of its own). */}
      <header style={{ marginBottom: 32 }}>
        <div style={heroBadge()}>
          <span style={heroBadgeDot()} />
          <span style={heroBadgeLabel()}>Account</span>
        </div>
        <h1 style={heroTitle()}>Account Settings</h1>
        <p style={heroSubtitle}>Manage your profile identity and security settings for the platform portal.</p>
      </header>

      {/* Cards */}
      <div style={CARD_STACK}>
        <GlassProfileCard user={user} onRefresh={refreshUser} index={0} />
        <GlassPasswordCard onRefresh={refreshUser} index={1} />
      </div>
    </div>
  );
}
