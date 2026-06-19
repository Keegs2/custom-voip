import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Waves, WifiOff, Captions } from 'lucide-react';
import { listMediaStreams } from '../api/mediaStreams';
import { PageHeader } from '../components/layout/PageHeader';
import { CenteredSpinner } from '../components/ui/Spinner';
import { StatCard } from '../components/ui/StatCard';
import { Table, TableWrap, Thead, Th, Td } from '../components/ui/Table';

const POLL_MS = 4000;

/* ─── Helpers ────────────────────────────────────────────── */

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtDurationMs(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString();
}

/* ─── Page ───────────────────────────────────────────────── */

export function MediaStreamsPage() {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['media-streams'],
    queryFn: listMediaStreams,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });

  const streams = useMemo(() => data?.streams ?? [], [data]);
  const eslOffline = data?.esl_connected === false;

  const totalBytes = useMemo(() => streams.reduce((acc, s) => acc + s.bytes, 0), [streams]);
  const totalFrames = useMemo(() => streams.reduce((acc, s) => acc + s.frames, 0), [streams]);

  return (
    <>
      <PageHeader
        title="Media & Transcription Monitor"
        subtitle="Live media taps pumped by the media plane — one row per captured call leg."
      />

      {/* Transcription-ready note */}
      <div
        className="flex items-start gap-3 rounded-xl px-4 py-3 mb-5"
        style={{ background: 'rgba(59,130,246,0.07)', border: '1px solid rgba(59,130,246,0.2)' }}
      >
        <Captions size={18} className="text-[#60a5fa] mt-0.5 shrink-0" />
        <div className="text-sm text-[#94a3b8] leading-relaxed">
          <span className="text-[#cbd5e1] font-semibold">Transcription-ready.</span>{' '}
          Each active stream is a pluggable hook point — a speech-to-text (STT) consumer can
          subscribe to the same media tap for live transcription. No STT engine is wired in yet;
          this monitor surfaces the raw stream stats the hook would consume.
        </div>
      </div>

      {isLoading ? (
        <CenteredSpinner label="Loading media streams…" />
      ) : isError ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.08] text-red-300 text-sm px-4 py-3">
          {error instanceof Error ? error.message : 'Failed to load media streams.'}
        </div>
      ) : eslOffline ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-[#64748b]">
          <WifiOff size={34} strokeWidth={1.5} className="text-[#f59e0b]" />
          <div className="text-base font-semibold text-[#94a3b8]">Media plane offline</div>
          <div className="text-sm text-center max-w-sm">
            The media control bridge is unreachable, so active streams can't be listed right now.
          </div>
        </div>
      ) : (
        <>
          {/* Summary */}
          <div className="grid gap-4 mb-5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
            <StatCard label="Active Streams" value={streams.length} icon="🎙" />
            <StatCard label="Total Frames" value={fmtNum(totalFrames)} icon="📶" />
            <StatCard label="Total Bytes" value={fmtBytes(totalBytes)} icon="💾" />
          </div>

          {streams.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-3 py-16 text-[#475569]">
              <Waves size={34} strokeWidth={1.5} />
              <div className="text-sm">No active media streams.</div>
            </div>
          ) : (
            <TableWrap>
              <Table>
                <Thead>
                  <tr>
                    <Th>Call</Th>
                    <Th className="text-right">Frames</Th>
                    <Th className="text-right">Bytes</Th>
                    <Th className="text-right">Duration</Th>
                    <Th className="text-right">Started</Th>
                  </tr>
                </Thead>
                <tbody>
                  {streams.map((s) => (
                    <tr key={s.call_uuid}>
                      <Td>
                        <span className="font-mono text-xs text-[#94a3b8]" title={s.call_uuid}>
                          {s.call_uuid.slice(0, 20)}{s.call_uuid.length > 20 ? '…' : ''}
                        </span>
                      </Td>
                      <Td className="text-right tabular-nums text-[#cbd5e1]">{fmtNum(s.frames)}</Td>
                      <Td className="text-right tabular-nums text-[#cbd5e1]">{fmtBytes(s.bytes)}</Td>
                      <Td className="text-right tabular-nums text-[#cbd5e1]">{fmtDurationMs(s.duration_ms)}</Td>
                      <Td className="text-right text-xs text-[#64748b] whitespace-nowrap">
                        {new Date(s.started_at).toLocaleTimeString()}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </>
      )}
    </>
  );
}
