import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Mic } from 'lucide-react';
import { listRecordings, recordingAudioUrl } from '../api/recordings';
import type { Recording, RecordingKind } from '../types/recording';
import { PageHeader } from '../components/layout/PageHeader';
import { CenteredSpinner } from '../components/ui/Spinner';
import { Table, TableWrap, Thead, Th, Td } from '../components/ui/Table';

/* ─── Helpers ────────────────────────────────────────────── */

function fmtDurationMs(ms: number | null): string {
  if (!ms || ms <= 0) return '—';
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

const KIND_COLOR: Record<RecordingKind, string> = {
  programmable: '#c084fc',
  call: '#60a5fa',
  conference: '#4ade80',
};

function KindChip({ kind }: { kind: RecordingKind }) {
  const color = KIND_COLOR[kind] ?? '#64748b';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '3px 9px',
        borderRadius: 6,
        fontSize: '0.65rem',
        fontWeight: 700,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        color,
        background: `${color}1a`,
        border: `1px solid ${color}33`,
      }}
    >
      {kind}
    </span>
  );
}

const KIND_OPTIONS: { value: '' | RecordingKind; label: string }[] = [
  { value: '', label: 'All kinds' },
  { value: 'call', label: 'Call' },
  { value: 'programmable', label: 'Programmable' },
  { value: 'conference', label: 'Conference' },
];

/* ─── Page ───────────────────────────────────────────────── */

export function RecordingsPage() {
  // ALL hooks unconditionally at the top (React #310).
  const [kindFilter, setKindFilter] = useState<'' | RecordingKind>('');
  const [callFilter, setCallFilter] = useState('');

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['recordings', { kind: kindFilter }],
    // Kind is a cheap server-side filter; the call-uuid search is applied
    // client-side so typing doesn't refetch on every keystroke.
    queryFn: () => listRecordings(kindFilter ? { kind: kindFilter, limit: 200 } : { limit: 200 }),
  });

  const recordings: Recording[] = useMemo(() => data?.recordings ?? [], [data]);

  const filtered = useMemo(() => {
    const term = callFilter.trim().toLowerCase();
    if (!term) return recordings;
    return recordings.filter(
      (r) =>
        (r.call_uuid ?? '').toLowerCase().includes(term) ||
        r.recording_uuid.toLowerCase().includes(term),
    );
  }, [recordings, callFilter]);

  return (
    <>
      <PageHeader
        title="Call Recordings"
        subtitle="Tenant-scoped recordings from programmable voice, ad-hoc calls, and conferences. Audio is served over short-lived presigned URLs."
      />

      {/* Filters */}
      <div className="flex items-end gap-3 flex-wrap mb-5">
        <div className="flex flex-col gap-1.5">
          <label className="text-[0.68rem] font-bold text-[#4a5568] uppercase tracking-[0.8px]">
            Kind
          </label>
          <select
            value={kindFilter}
            onChange={(e) => setKindFilter(e.target.value as '' | RecordingKind)}
            className="text-sm px-3 py-2 rounded-lg h-9 border border-[#2a2f45] bg-[#1e2130] text-[#e2e8f0] outline-none focus:border-[#3b82f6] cursor-pointer"
          >
            {KIND_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5 flex-1 min-w-[220px]">
          <label className="text-[0.68rem] font-bold text-[#4a5568] uppercase tracking-[0.8px]">
            Filter by call
          </label>
          <input
            value={callFilter}
            onChange={(e) => setCallFilter(e.target.value)}
            placeholder="Call UUID or recording UUID…"
            className="text-sm px-3 py-2 rounded-lg h-9 w-full border border-[#2a2f45] bg-[#1e2130] text-[#e2e8f0] outline-none focus:border-[#3b82f6] placeholder:text-[#4a5568]"
          />
        </div>
      </div>

      {isLoading ? (
        <CenteredSpinner label="Loading recordings…" />
      ) : isError ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.08] text-red-300 text-sm px-4 py-3">
          {error instanceof Error ? error.message : 'Failed to load recordings.'}
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-[#475569]">
          <Mic size={34} strokeWidth={1.5} />
          <div className="text-sm">
            {recordings.length === 0
              ? 'No recordings yet. Recorded calls will appear here.'
              : 'No recordings match your filter.'}
          </div>
        </div>
      ) : (
        <TableWrap>
          <Table>
            <Thead>
              <tr>
                <Th>Date</Th>
                <Th>Kind</Th>
                <Th>Duration</Th>
                <Th>Call</Th>
                <Th className="text-right">Audio</Th>
              </tr>
            </Thead>
            <tbody>
              {filtered.map((r) => {
                const href = recordingAudioUrl(r.id);
                return (
                  <tr key={r.id}>
                    <Td>
                      <span className="text-[#e2e8f0] whitespace-nowrap">{fmtDate(r.created_at)}</span>
                    </Td>
                    <Td><KindChip kind={r.kind} /></Td>
                    <Td>
                      <span className="text-[#94a3b8] tabular-nums">{fmtDurationMs(r.duration_ms)}</span>
                    </Td>
                    <Td>
                      <span
                        className="font-mono text-xs text-[#64748b]"
                        title={r.call_uuid ?? r.recording_uuid}
                      >
                        {(r.call_uuid ?? r.recording_uuid).slice(0, 18)}
                        {(r.call_uuid ?? r.recording_uuid).length > 18 ? '…' : ''}
                      </span>
                    </Td>
                    <Td>
                      <div className="flex items-center justify-end gap-3">
                        {/* Inline player follows the 307 → presigned URL transparently */}
                        <audio
                          controls
                          preload="none"
                          src={href}
                          style={{ height: 32, maxWidth: 240 }}
                        />
                        <a
                          href={href}
                          download={`recording-${r.recording_uuid}.wav`}
                          title="Download"
                          className="inline-flex items-center justify-center w-8 h-8 rounded-md border border-[#2a2f45] text-[#64748b] hover:text-[#e2e8f0] hover:border-[#363c57] transition-colors"
                        >
                          <Download size={15} />
                        </a>
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </>
  );
}
