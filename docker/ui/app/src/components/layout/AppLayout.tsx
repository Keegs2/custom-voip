import { Outlet, useLocation } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { SoftphoneWidget } from '../softphone/SoftphoneWidget';
import { GlassBackground } from '../glass/GlassBackground';
import { RouteErrorBoundary } from '../errors/RouteErrorBoundary';

/**
 * App-wide SPACING STANDARD — the single source of truth for the content
 * container's breathing room. Every routed page renders inside this padded,
 * centered column, so pages must NOT add their own top margin/padding (the
 * top offset is owned here). See docs/FRONTEND_GLASS_REFACTOR.md §7.
 *
 * All three gutters are FLUID (clamp) so horizontal and vertical breathing room
 * scale together — never cramped on a laptop, never sprawling on a wide monitor.
 *
 *  - PAGE_PADDING_X      left/right gutter — 24px → 48px
 *  - PAGE_PADDING_TOP    comfortable top offset so content is not glued to the
 *                        edge — 32px → 48px (min 32px guarantees the offset even
 *                        on short viewports)
 *  - PAGE_PADDING_BOTTOM generous tail so the last row clears the softphone
 *                        widget — 64px → 96px
 */
const PAGE_PADDING_X = 'clamp(24px, 3vw, 48px)';
const PAGE_PADDING_TOP = 'clamp(32px, 4vh, 48px)';
const PAGE_PADDING_BOTTOM = 'clamp(64px, 8vh, 96px)';

export function AppLayout() {
  // The public landing page (index route) is a marketing surface and breathes
  // wider than the standard 1280 app content cap. Every other route keeps 1280.
  const { pathname } = useLocation();
  const contentMaxWidth = pathname === '/' ? 1600 : 1280;

  return (
    <div className="min-h-screen bg-[#0f1117]">
      {/*
        App-wide liquid-glass backdrop. Fixed + zIndex:0, so it paints behind the
        content (which is lifted to zIndex:1 below) and behind the Sidebar
        (zIndex:100). It never recolours the Sidebar and is subtle enough that
        opaque, not-yet-glassified pages still read fine on top.
      */}
      <GlassBackground />
      <Sidebar />
      {/* Main content — offset by the fixed 240px sidebar ONLY at md+ via the
          responsive class (`md:ml-60` = 240px): below md the Sidebar is
          off-canvas behind the hamburger topbar, so an inline marginLeft would
          leave a 240px dead gutter on phones/tablets (2026-07 audit P0).
          position:relative + zIndex:1 lifts the content above GlassBackground. */}
      <main
        className="min-h-screen flex flex-col md:ml-60"
        style={{ position: 'relative', zIndex: 1 }}
      >
        {/* Inner wrapper: fills main, centers content within the content column,
            and owns the app-wide spacing standard (top offset + gutters + tail).
            Pages render directly inside this — they never re-pad the top edge. */}
        <div
          className="flex-1 flex flex-col"
          style={{
            maxWidth: contentMaxWidth,
            width: '100%',
            marginLeft: 'auto',
            marginRight: 'auto',
            paddingLeft: PAGE_PADDING_X,
            paddingRight: PAGE_PADDING_X,
            paddingTop: PAGE_PADDING_TOP,
            paddingBottom: PAGE_PADDING_BOTTOM,
          }}
        >
          {/* Per-route error boundary: a crash in ONE page renders an in-place
              recoverable fallback while the sidebar + softphone (and an active
              call) keep working. Auto-resets on navigation. */}
          <RouteErrorBoundary>
            <Outlet />
          </RouteErrorBoundary>
        </div>
      </main>

      {/* Softphone overlay — self-gates on hasUcaas (renders null for rcf and
          any account with no WebRTC extension), so RCF sees zero UCaaS chrome. */}
      <SoftphoneWidget />
    </div>
  );
}
