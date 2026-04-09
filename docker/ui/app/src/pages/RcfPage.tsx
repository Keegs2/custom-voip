import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge } from '../components/ui/Badge';
import { Spinner } from '../components/ui/Spinner';
import { listRcf } from '../api/rcf';
import type { RcfEntry } from '../types/rcf';
import { RcfCard } from './RcfCard';

export function RcfPage() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['rcf'],
    queryFn: () => listRcf({ limit: 200 }),
  });

  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({});
  const entries: RcfEntry[] = useMemo(() => data?.items ?? [], [data]);

  function handlePendingChange(did: string, value: string) {
    setPendingEdits((prev) => ({ ...prev, [did]: value }));
  }

  function resolveValue(entry: RcfEntry): string {
    return pendingEdits[entry.did] !== undefined
      ? pendingEdits[entry.did]
      : entry.forward_to;
  }

  return (
    <div>
      <PortalHeader
        icon="~"
        title="Your Numbers"
        subtitle="Change where your calls forward to. Updates take effect within seconds."
        badgeVariant="rcf"
      />

      {isLoading && (
        <div className="flex items-center gap-2.5 text-[#718096] text-sm py-12">
          <Spinner size="sm" />
          <span>Loading your numbers…</span>
        </div>
      )}

      {isError && (
        <div className="py-10 px-1 text-sm text-red-400">
          Unable to load RCF numbers. Please try refreshing the page.
        </div>
      )}

      {!isLoading && !isError && entries.length === 0 && (
        <div className="flex flex-col items-center justify-center py-16 gap-2 text-center">
          <p className="text-[#718096] text-sm">No RCF numbers found for your account.</p>
          <p className="text-[#4a5568] text-xs">Contact support to provision numbers.</p>
        </div>
      )}

      {entries.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4 md:gap-5">
          {entries.map((entry) => (
            <RcfCard
              key={entry.id}
              entry={entry}
              pendingValue={resolveValue(entry)}
              onPendingChange={handlePendingChange}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface PortalHeaderProps {
  icon: string;
  title: string;
  subtitle: string;
  badgeVariant?: 'rcf' | 'api' | 'trunk';
}

export function PortalHeader({ icon, title, subtitle, badgeVariant = 'rcf' }: PortalHeaderProps) {
  return (
    <div className="mb-6 md:mb-8 pb-5 border-b border-[#2a2f45]">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-2xl font-bold tracking-tight text-[#e2e8f0] leading-tight flex items-center gap-2">
          <span className="text-[#3b82f6] font-mono text-xl" aria-hidden="true">
            {icon}
          </span>
          {title}
        </h1>
        <Badge variant={badgeVariant}>Customer Portal</Badge>
      </div>
      <p className="text-sm text-[#718096] mt-1.5">{subtitle}</p>
    </div>
  );
}
