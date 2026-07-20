/**
 * TiersTab — THIN composition page for the Tiers admin area. Trunk tiers, API
 * tiers, and call-path packages, each in a frosted <SectionPanel>. Data comes
 * from the feature hooks; presentational pieces live in
 * pages/admin/billing/tiers/.
 *
 * React #310: all hooks sit at the top of useTiersData, before any return.
 */

import { GlassChip } from '../../components/glass/GlassCard';
import { GLASS } from '../../components/glass/glass';
import { useTiersData } from './billing/tiers/hooks';
import { SectionPanel } from './billing/components/SectionPanel';
import { InlineLoading, ErrorState, EmptyState } from './billing/components/states';
import { TierCard } from './billing/tiers/components/TierCard';
import { CallPathsTable } from './billing/tiers/components/CallPathsTable';

const CARD_GRID: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: 16,
};

export function TiersTab() {
  const { trunkTiers, apiTiers, callPaths } = useTiersData();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      {/* Trunk Tiers */}
      <SectionPanel
        eyebrow="SIP Trunking"
        title="SIP Trunk Tiers"
        description="Standard SIP trunk access. CPS and call paths are configured independently."
        accent={GLASS.warning}
        badge={<GlassChip label="5 CPS Standard" color={GLASS.warning} dot />}
      >
        {trunkTiers.isLoading && <InlineLoading label="Loading tiers…" />}
        {trunkTiers.isError && <ErrorState message="Failed to load trunk tiers." />}
        {!trunkTiers.isLoading && !trunkTiers.isError && (
          (trunkTiers.data?.length ?? 0) === 0 ? (
            <EmptyState title="No trunk tiers configured." />
          ) : trunkTiers.data!.length === 1 ? (
            <div style={CARD_GRID}>
              <TierCard tier={trunkTiers.data![0]} tierType="trunk" fullWidth />
            </div>
          ) : (
            <div style={CARD_GRID}>
              {trunkTiers.data!.map((t, i) => (
                <TierCard key={t.id} tier={t} tierType="trunk" index={i} />
              ))}
            </div>
          )
        )}
      </SectionPanel>

      {/* API Calling Tiers */}
      <SectionPanel
        eyebrow="API Calling"
        title="API Calling Tiers"
        description="Higher CPS limits with per-call billing for programmatic call control."
        badge={<GlassChip label="Up to 15 CPS" color={GLASS.accent} dot />}
      >
        {apiTiers.isLoading && <InlineLoading label="Loading tiers…" />}
        {apiTiers.isError && <ErrorState message="Failed to load API tiers." />}
        {!apiTiers.isLoading && !apiTiers.isError && (
          (apiTiers.data?.length ?? 0) === 0 ? (
            <EmptyState title="No API tiers configured." />
          ) : (
            <div style={CARD_GRID}>
              {apiTiers.data!.map((t, i) => (
                <TierCard key={t.id} tier={t} tierType="api" index={i} />
              ))}
            </div>
          )
        )}
      </SectionPanel>

      {/* Call Path Packages */}
      <SectionPanel
        eyebrow="Capacity"
        title="Call Path Packages"
        description="Call paths are purchased per-trunk and control concurrent call capacity. CPS and call paths are independent."
      >
        {callPaths.isLoading && <InlineLoading label="Loading packages…" />}
        {callPaths.isError && <ErrorState message="Failed to load call path packages." />}
        {!callPaths.isLoading && !callPaths.isError && (
          (callPaths.data?.length ?? 0) === 0 ? (
            <EmptyState title="No call path packages configured." />
          ) : (
            <CallPathsTable packages={callPaths.data!} />
          )
        )}
      </SectionPanel>
    </div>
  );
}
