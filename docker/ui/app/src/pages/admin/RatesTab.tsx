/**
 * RatesTab — THIN composition page for the Rates admin area. Top-level data
 * comes from the feature hooks; every surface is built from the glass kit.
 * Presentational pieces live in pages/admin/billing/rates/.
 *
 * (RatesStatsGrid and MarginAnalysis are owned/glassified by another area and
 * are composed here as-is.)
 *
 * React #310: all hooks sit at the top of useRatesData, before any return.
 */

import { useRatesData } from './billing/rates/hooks';
import { LoadingState, ErrorState } from './billing/components/states';
import { RatesAddForm } from './billing/rates/components/RatesAddForm';
import { RatesTable } from './billing/rates/components/RatesTable';
import { RatesStatsGrid } from './RatesStatsGrid';
import { MarginAnalysis } from './MarginAnalysis';

export function RatesTab() {
  const { rates, margins, isLoading, isError } = useRatesData();

  if (isLoading) {
    return <LoadingState label="Loading rates…" />;
  }

  if (isError) {
    return <ErrorState message="Failed to load rates. Please try again." />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
      {margins && <RatesStatsGrid margins={margins} />}
      <RatesAddForm />
      <RatesTable rates={rates} />
      {margins && <MarginAnalysis margins={margins} />}
    </div>
  );
}
