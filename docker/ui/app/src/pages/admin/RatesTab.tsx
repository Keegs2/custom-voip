import { useQuery } from '@tanstack/react-query';
import { listRates, getMarginsData } from '../../api/rates';
import { Spinner } from '../../components/ui/Spinner';
import { RatesStatsGrid } from './RatesStatsGrid';
import { RatesTable } from './RatesTable';
import { RatesAddForm } from './RatesAddForm';
import { MarginAnalysis } from './MarginAnalysis';

const RATES_LIMIT = 500;

export function RatesTab() {
  const {
    data: ratesData,
    isLoading: ratesLoading,
    isError: ratesError,
  } = useQuery({
    queryKey: ['rates'],
    queryFn: () => listRates({ limit: RATES_LIMIT }),
  });

  const {
    data: margins,
    isLoading: marginsLoading,
  } = useQuery({
    queryKey: ['margins'],
    queryFn: getMarginsData,
  });

  const isLoading = ratesLoading || marginsLoading;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-[#718096] py-10">
        <Spinner /> Loading rates…
      </div>
    );
  }

  if (ratesError) {
    return (
      <p className="text-red-400 text-sm py-4">
        Failed to load rates. Please try again.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      {/* Stats cards + warning banner */}
      {margins && <RatesStatsGrid margins={margins} />}

      {/* Add rate form */}
      <RatesAddForm />

      {/* Sortable rates table */}
      <RatesTable rates={ratesData?.items ?? []} />

      {/* Margin analysis cards */}
      {margins && <MarginAnalysis margins={margins} />}
    </div>
  );
}
