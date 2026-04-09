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

  // pendingEdits maps DID → current input value.
  // Initialised lazily from the query data; user changes update this state.
  const [pendingEdits, setPendingEdits] = useState<Record<string, string>>({});

  // Merge server data with pending edits: on first load (or after invalidation)
  // seed any DID that has no pending edit with its server value.
  const entries: RcfEntry[] = useMemo(() => (Array.isArray(data) ? data : data?.items ?? []), [data]);

  function handlePendingChange(did: string, value: string) {
    setPendingEdits((prev) => ({ ...prev, [did]: value }));
  }

  // For a given entry, resolve the displayed/editable value:
  // use the pending edit if one exists, otherwise fall back to the server value.
  function resolveValue(entry: RcfEntry): string {
    return pendingEdits[entry.did] !== undefined
      ? pendingEdits[entry.did]
      : entry.forward_to;
  }

  return (
    <div>
      {/* Portal header */}
      <PortalHeader
        icon="~"
        title="Your Numbers"
        subtitle="Change where your calls forward to. Updates take effect within seconds."
      />

      {/* Content */}
      {isLoading && (
        <div className="flex items-center gap-2 text-[#718096] text-sm py-8">
          <Spinner size="sm" />
          <span>Loading your numbers…</span>
        </div>
      )}

      {isError && (
        <div className="py-8 text-[0.85rem] text-red-400">
          Unable to load RCF numbers. Please try refreshing the page.
        </div>
      )}

      {!isLoading && !isError && entries.length === 0 && (
        <div className="py-8 text-[0.85rem] text-[#718096]">
          No RCF numbers found for your account.
        </div>
      )}

      {entries.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
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
}

export function PortalHeader({ icon, title, subtitle }: PortalHeaderProps) {
  return (
    <div className="mb-7 pb-5 border-b border-[#2a2f45]">
      <div className="flex items-center gap-3 flex-wrap">
        <h1 className="text-[1.45rem] font-bold tracking-[-0.3px] text-[#e2e8f0] leading-tight flex items-center gap-2">
          <span className="text-[#3b82f6] font-mono text-[1.2rem]" aria-hidden="true">
            {icon}
          </span>
          {title}
        </h1>
        <Badge variant="rcf">Customer Portal</Badge>
      </div>
      <p className="text-[0.82rem] text-[#718096] mt-1">{subtitle}</p>
    </div>
  );
}
