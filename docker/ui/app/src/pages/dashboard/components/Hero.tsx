/**
 * Hero — the Granite Shale branded marketing header: animated glowing logo with
 * a scan-line overlay, the gradient tagline, and the subtitle. Purely
 * presentational. The float/glow/hover animations live in index.css
 * (`.dash-shale-hero*`, `.dash-scan-line`); this component only owns layout.
 */

import {
  heroWrap,
  heroImageWrap,
  heroImage,
  heroScanLine,
  heroTitle,
  heroTitleAccent,
  heroSubtitle,
} from '../styles';

export function Hero() {
  return (
    <header className="animate-fade-in-up" style={heroWrap}>
      {/*
        Two-layer structure (kept from the original):
          .dash-shale-hero-wrap → outer; owns the hover 3D rotate
          img.dash-shale-hero   → inner; owns the glow + float animation
        Separate elements prevent the hover transform and the float transform
        from fighting over the same CSS property.
      */}
      <div className="dash-shale-hero-wrap" style={heroImageWrap}>
        <img
          src="/shale_logo.png"
          alt="Granite Shale — Distributed Voice Infrastructure"
          className="dash-shale-hero"
          style={heroImage}
        />
        <div className="dash-scan-line" style={heroScanLine} />
      </div>

      <h1 className="animate-fade-in-up animation-delay-200" style={heroTitle}>
        <span style={heroTitleAccent}>Distributed</span> Voice Infrastructure.{' '}
        <br />
        Built for the Enterprise.
      </h1>

      <p className="animate-fade-in-up animation-delay-400" style={heroSubtitle}>
        Port your numbers. Configure your rules. Route every call through
        carrier-grade infrastructure with automatic failover across three
        availability zones.
      </p>
    </header>
  );
}
