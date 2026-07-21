/**
 * ProductCard — one product tile in the hub grid, rendered as a frosted glass
 * surface (GlassCard) that lifts + glows on hover.
 *
 * Active tiles are clickable (navigate, or fire the Request Access flow for
 * unauthenticated visitors). Inactive tiles fade to the faint accent and render
 * a muted "Soon" badge instead.
 *
 * React #310: every hook (useNavigate, useState) sits unconditionally at the top
 * — there is no early return above them.
 */

import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { BookOpen, ArrowRight } from 'lucide-react';
import { GlassCard } from '../../../components/glass/GlassCard';
import { GLASS } from '../../../components/glass/glass';
import type { ProductCardData } from '../types';
import {
  productCardBody,
  productHeaderRow,
  productIconBox,
  productBadge,
  productBadgeDot,
  productBadgeText,
  productTitle,
  productSubtitle,
  productDocsLink,
} from '../styles';

interface ProductCardProps {
  card: ProductCardData;
  /** Entrance stagger index for GlassCard. */
  index: number;
  /**
   * When provided, clicking an active card fires this instead of navigating.
   * Used on the public homepage so product tiles open the Request Access form
   * rather than silently bouncing an unauthenticated visitor to login.
   */
  onRequestAccess?: () => void;
}

export function ProductCard({ card, index, onRequestAccess }: ProductCardProps) {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const [hovered, setHovered] = useState(false);
  const [docsHovered, setDocsHovered] = useState(false);
  const navigate = useNavigate();

  const accent = card.active ? GLASS.accent : GLASS.textFaint;
  const Icon = card.icon;
  const clickable = card.active;

  function handleClick() {
    if (!card.active) return;
    if (onRequestAccess) {
      onRequestAccess();
      return;
    }
    if (card.route) navigate(card.route);
  }

  return (
    <div
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? handleClick : undefined}
      onKeyDown={
        clickable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                handleClick();
              }
            }
          : undefined
      }
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ cursor: clickable ? 'pointer' : 'default', outline: 'none', height: '100%' }}
    >
      <GlassCard index={index} accent={accent} style={{ height: '100%', opacity: card.active ? 1 : 0.5 }}>
        <div style={productCardBody}>
          <div style={productHeaderRow}>
            <div style={productIconBox(accent, clickable && hovered)}>
              <Icon size={20} strokeWidth={1.75} />
            </div>

            {card.active ? (
              <span style={productBadge(GLASS.accent)}>
                <span style={productBadgeDot(GLASS.accent)} />
                <span style={productBadgeText('#60a5fa')}>Active</span>
              </span>
            ) : (
              <span style={productBadge(GLASS.textMuted)}>
                <span style={productBadgeText(GLASS.textMuted)}>Soon</span>
              </span>
            )}
          </div>

          <div style={productTitle}>{card.title}</div>
          <div style={{ ...productSubtitle, flex: 1 }}>{card.subtitle}</div>

          {/* "Read the guide" — public docs link. stopPropagation so it navigates
              to the guide instead of triggering the card's own click (which would
              open Request Access / the product route). Works logged-out. */}
          {card.docsSlug && (
            <Link
              to={`/docs/${card.docsSlug}`}
              onClick={(e) => e.stopPropagation()}
              onMouseEnter={() => setDocsHovered(true)}
              onMouseLeave={() => setDocsHovered(false)}
              style={productDocsLink(GLASS.accent, docsHovered)}
              aria-label={`Read the ${card.title} guide`}
            >
              <BookOpen size={12} strokeWidth={2.2} />
              Read the guide
              <ArrowRight size={11} strokeWidth={2.4} style={{ opacity: docsHovered ? 1 : 0.6 }} />
            </Link>
          )}
        </div>
      </GlassCard>
    </div>
  );
}
