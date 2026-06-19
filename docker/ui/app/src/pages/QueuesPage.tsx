import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ListOrdered, WifiOff, ChevronRight, Users } from 'lucide-react';
import { listQueues, getQueue } from '../api/queues';
import type { QueueMember } from '../types/queue';
import { PageHeader } from '../components/layout/PageHeader';
import { CenteredSpinner, Spinner } from '../components/ui/Spinner';
import { Table, TableWrap, Thead, Th, Td } from '../components/ui/Table';

const POLL_MS = 5000;

function memberLabel(m: QueueMember): string {
  return m.caller || m.uuid || 'caller';
}

function fmtWait(ms?: number): string {
  if (ms === undefined || ms === null) return '—';
  const s = Math.floor(ms / 1000);
  const mm = Math.floor(s / 60);
  return `${mm}:${String(s % 60).padStart(2, '0')}`;
}

/* ─── Drill-in member panel ──────────────────────────────── */

function QueueMembersPanel({ name }: { name: string }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['queue', name],
    queryFn: () => getQueue(name),
    refetchInterval: POLL_MS,
  });

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-[#64748b]">
        <Spinner size="sm" /> Loading members…
      </div>
    );
  }
  if (isError || !data) {
    return <div className="py-4 text-sm text-[#f87171]">Failed to load queue members.</div>;
  }
  if (data.members.length === 0) {
    return <div className="py-4 text-sm text-[#475569]">No callers waiting in this queue.</div>;
  }

  return (
    <div className="py-2">
      <TableWrap>
        <Table>
          <Thead>
            <tr>
              <Th>Caller</Th>
              <Th>Destination</Th>
              <Th>State</Th>
              <Th className="text-right">Waiting</Th>
            </tr>
          </Thead>
          <tbody>
            {data.members.map((m, i) => (
              <tr key={m.uuid ?? `${memberLabel(m)}-${i}`}>
                <Td><span className="font-mono text-xs text-[#e2e8f0]">{memberLabel(m)}</span></Td>
                <Td><span className="font-mono text-xs text-[#94a3b8]">{m.dest ?? '—'}</span></Td>
                <Td><span className="text-xs text-[#64748b]">{m.state ?? '—'}</span></Td>
                <Td className="text-right tabular-nums text-[#cbd5e1]">{fmtWait(m.wait_ms)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </TableWrap>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────── */

export function QueuesPage() {
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['queues'],
    queryFn: listQueues,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });

  const queues = useMemo(() => data?.queues ?? [], [data]);
  const eslOffline = data?.esl_connected === false;

  return (
    <>
      <PageHeader
        title="Call Queues"
        subtitle="Live ACD queue depth. Expand a queue to inspect the waiting callers."
      />

      {isLoading ? (
        <CenteredSpinner label="Loading queues…" />
      ) : isError ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.08] text-red-300 text-sm px-4 py-3">
          {error instanceof Error ? error.message : 'Failed to load queues.'}
        </div>
      ) : eslOffline ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-[#64748b]">
          <WifiOff size={34} strokeWidth={1.5} className="text-[#f59e0b]" />
          <div className="text-base font-semibold text-[#94a3b8]">Queue engine offline</div>
          <div className="text-sm text-center max-w-sm">
            The FreeSWITCH event-socket bridge is unreachable, so queue depth can't be read
            right now. This view recovers automatically once the bridge is back.
          </div>
        </div>
      ) : queues.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-[#475569]">
          <ListOrdered size={34} strokeWidth={1.5} />
          <div className="text-sm">No queues configured.</div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {queues.map((q) => {
            const isOpen = expanded === q.name;
            return (
              <div
                key={q.name}
                className="rounded-xl overflow-hidden"
                style={{
                  background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
                  border: '1px solid rgba(42,47,69,0.6)',
                }}
              >
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : q.name)}
                  className="w-full flex items-center gap-3 px-4 py-3.5 text-left"
                >
                  <ChevronRight
                    size={16}
                    className="text-[#475569] transition-transform shrink-0"
                    style={{ transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}
                  />
                  <Users size={15} className="text-[#60a5fa] shrink-0" />
                  <span className="text-sm font-semibold text-[#e2e8f0] flex-1">{q.name}</span>
                  <span
                    className="text-xs font-bold tabular-nums px-2.5 py-1 rounded-md"
                    style={{
                      color: q.depth > 0 ? '#fbbf24' : '#64748b',
                      background: q.depth > 0 ? 'rgba(245,158,11,0.1)' : 'rgba(255,255,255,0.04)',
                      border: `1px solid ${q.depth > 0 ? 'rgba(245,158,11,0.25)' : 'rgba(42,47,69,0.6)'}`,
                    }}
                  >
                    {q.depth} waiting
                  </span>
                </button>
                {isOpen && (
                  <div className="px-4 pb-3 border-t" style={{ borderColor: 'rgba(42,47,69,0.5)' }}>
                    <QueueMembersPanel name={q.name} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
