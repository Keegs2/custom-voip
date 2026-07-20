/**
 * OnboardingAdminPage — the customer onboarding request queue (admin).
 *
 * THIN page: composition + top-level state only. All data fetching, mutations,
 * and per-form editor state live in `./onboarding/hooks.ts`; styles in
 * `./onboarding/styles.ts`; presentational pieces in `./onboarding/components/`.
 * Mirrors the reference architecture in `pages/rcf-glass/` and the convention in
 * docs/FRONTEND_GLASS_REFACTOR.md.
 *
 * The ambient GlassBackground is mounted app-wide by AppLayout — this page does
 * NOT mount its own; it just builds glass surfaces on top.
 *
 * React #310: every hook sits unconditionally at the top, before any return.
 */

import { useState, useCallback } from 'react';
import { GLASS } from '../../components/glass/glass';
import type { ApproveResponse } from '../../types/onboarding';
import { useOnboardingList } from './onboarding/hooks';
import { statusLabel } from './onboarding/helpers';
import type { FilterTab } from './onboarding/types';
import { heroBadge, heroTitle, heroSubtitle, colHeaderRow, colHeaderLabel } from './onboarding/styles';
import { OnboardingTabs } from './onboarding/components/OnboardingTabs';
import { OnboardingCard } from './onboarding/components/OnboardingCard';
import { CredentialsModal } from './onboarding/components/CredentialsModal';
import { SkeletonCard, StateCard } from './onboarding/components/states';
import { IconError, IconEmpty } from './onboarding/components/icons';

const LIST_GAP = 14;

export function OnboardingAdminPage() {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [credentials, setCredentials] = useState<ApproveResponse | null>(null);

  const { items, isLoading, isError } = useOnboardingList(activeFilter);

  const handleSelectFilter = useCallback((tab: FilterTab) => {
    setActiveFilter(tab);
    setExpandedId(null);
  }, []);

  const handleToggle = useCallback((id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleApproved = useCallback((result: ApproveResponse) => {
    setCredentials(result);
  }, []);

  const handleCredentialsDone = useCallback(() => {
    setCredentials(null);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      {/* Hero */}
      <header>
        <div style={heroBadge()}>
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: GLASS.accent, boxShadow: `0 0 8px ${GLASS.accent}` }} />
          <span style={{ fontSize: '0.64rem', fontWeight: 700, letterSpacing: '0.14em', textTransform: 'uppercase', color: GLASS.accent }}>
            Customer Onboarding
          </span>
        </div>
        <h1 style={heroTitle()}>Onboarding Queue</h1>
        <p style={heroSubtitle}>
          Review incoming RCF onboarding requests, verify billing, then select inventory DIDs and
          provision the account in one step.
        </p>
      </header>

      {/* Status filter tabs */}
      <OnboardingTabs active={activeFilter} onSelect={handleSelectFilter} />

      {/* Body */}
      {isLoading ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: LIST_GAP }}>
          {Array.from({ length: 5 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      ) : isError ? (
        <StateCard
          icon={<IconError />}
          title="Couldn't load onboarding requests"
          body="The request failed. Check your connection and try again."
        />
      ) : items.length === 0 ? (
        <StateCard
          icon={<IconEmpty />}
          title="No onboarding requests"
          body={
            activeFilter !== 'all'
              ? `Nothing with status "${statusLabel(activeFilter)}" right now.`
              : 'New onboarding requests submitted by prospects will appear here.'
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: LIST_GAP }}>
          {/* Column headers */}
          <div style={colHeaderRow}>
            <div style={{ width: 11, flexShrink: 0 }} />
            <div style={{ flex: 1, ...colHeaderLabel }}>Company / Contact</div>
            <div style={{ width: 52, textAlign: 'center', ...colHeaderLabel }}>DIDs</div>
            <div style={{ width: 120, ...colHeaderLabel }}>Timeline</div>
            <div style={{ width: 110, ...colHeaderLabel }}>Status</div>
            <div style={{ width: 90, ...colHeaderLabel }}>Submitted</div>
          </div>

          {items.map((req, i) => (
            <OnboardingCard
              key={req.id}
              request={req}
              index={i}
              isExpanded={expandedId === req.id}
              onToggle={() => handleToggle(req.id)}
              onApproved={handleApproved}
            />
          ))}
        </div>
      )}

      {/* Credentials modal — shown after a successful approval */}
      {credentials && <CredentialsModal result={credentials} onClose={handleCredentialsDone} />}
    </div>
  );
}
