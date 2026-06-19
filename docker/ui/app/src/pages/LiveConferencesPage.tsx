import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Video, Users, Mic, MicOff, PhoneOff, WifiOff } from 'lucide-react';
import { listLiveConferences, kickLiveMember, muteLiveMember } from '../api/conferencesLive';
import type { LiveConferenceMember } from '../types/conferenceLive';
import { ApiError } from '../api/client';
import { PageHeader } from '../components/layout/PageHeader';
import { CenteredSpinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/ToastContext';

const POLL_MS = 4000;

function memberName(m: LiveConferenceMember): string {
  return m.name || m.caller_id_name || m.caller_id_number || `Member ${m.id}`;
}

/* ─── Member row (reuses ConferencePage live-member styling) ── */

interface MemberRowProps {
  room: string;
  member: LiveConferenceMember;
  onActed: () => void;
}

function MemberRow({ room, member, onActed }: MemberRowProps) {
  // Hooks above any early return (React #310).
  const { toastOk, toastErr } = useToast();
  const [busy, setBusy] = useState<'kick' | 'mute' | null>(null);

  const run = async (kind: 'kick' | 'mute') => {
    setBusy(kind);
    try {
      if (kind === 'kick') await kickLiveMember(room, member.id);
      else await muteLiveMember(room, member.id);
      toastOk(kind === 'kick' ? 'Member removed' : 'Mute toggled');
      onActed();
    } catch (err) {
      toastErr(err instanceof ApiError ? err.message : `Failed to ${kind} member`);
    } finally {
      setBusy(null);
    }
  };

  const name = memberName(member);

  return (
    <div
      className="flex items-center gap-3 px-3.5 py-2.5 rounded-[10px]"
      style={{
        background: member.talking ? 'rgba(59,130,246,0.07)' : 'rgba(255,255,255,0.02)',
        border: member.talking ? '1px solid rgba(59,130,246,0.2)' : '1px solid rgba(255,255,255,0.05)',
      }}
    >
      <div
        className="flex items-center justify-center rounded-full font-bold shrink-0"
        style={{
          width: 36, height: 36, fontSize: '0.9rem', color: '#818cf8',
          background: 'linear-gradient(135deg, rgba(59,130,246,0.25) 0%, rgba(99,102,241,0.25) 100%)',
          border: member.talking ? '1.5px solid #3b82f6' : '1.5px solid transparent',
        }}
      >
        {name.charAt(0).toUpperCase()}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold text-[#e2e8f0] truncate">{name}</div>
        {member.talking && <div className="text-xs text-[#22c55e] font-medium">Speaking</div>}
      </div>
      {member.muted && (
        <div className="flex items-center gap-1 px-2 py-0.5 rounded" style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.2)' }}>
          <MicOff size={11} className="text-[#ef4444]" />
          <span className="text-[0.65rem] text-[#ef4444] font-semibold">Muted</span>
        </div>
      )}
      <div className="flex gap-1.5">
        <button
          type="button"
          onClick={() => void run('mute')}
          disabled={busy !== null}
          title={member.muted ? 'Unmute' : 'Mute'}
          className="w-[30px] h-[30px] rounded-md flex items-center justify-center disabled:opacity-50"
          style={{ background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)', color: '#64748b', cursor: busy ? 'default' : 'pointer' }}
        >
          {member.muted ? <Mic size={13} /> : <MicOff size={13} />}
        </button>
        <button
          type="button"
          onClick={() => void run('kick')}
          disabled={busy !== null}
          title="Remove from conference"
          className="w-[30px] h-[30px] rounded-md flex items-center justify-center disabled:opacity-50"
          style={{ background: 'rgba(239,68,68,0.06)', border: '1px solid rgba(239,68,68,0.15)', color: '#ef4444', cursor: busy ? 'default' : 'pointer' }}
        >
          <PhoneOff size={13} />
        </button>
      </div>
    </div>
  );
}

/* ─── Page ───────────────────────────────────────────────── */

export function LiveConferencesPage() {
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['live-conferences'],
    queryFn: listLiveConferences,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: false,
  });

  const conferences = useMemo(() => data?.conferences ?? [], [data]);
  // /conferences/live always returns esl_connected; treat explicit false as offline.
  const eslOffline = data ? data.esl_connected === false : false;

  return (
    <>
      <PageHeader
        title="Live Conferences"
        subtitle="Every active conference room across your tenant, with live moderator controls."
        actions={
          <span className="inline-flex items-center gap-1.5 text-xs text-[#64748b]">
            <Video size={13} className="text-[#22c55e]" />
            {data ? `${data.count} active` : 'live'}
          </span>
        }
      />

      {isLoading ? (
        <CenteredSpinner label="Loading conferences…" />
      ) : isError ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.08] text-red-300 text-sm px-4 py-3">
          {error instanceof Error ? error.message : 'Failed to load conferences.'}
        </div>
      ) : eslOffline ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-[#64748b]">
          <WifiOff size={34} strokeWidth={1.5} className="text-[#f59e0b]" />
          <div className="text-base font-semibold text-[#94a3b8]">Conference bridge offline</div>
          <div className="text-sm text-center max-w-sm">
            The FreeSWITCH event-socket bridge is unreachable, so live rooms can't be listed
            or controlled right now.
          </div>
        </div>
      ) : conferences.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-[#475569]">
          <Video size={34} strokeWidth={1.5} />
          <div className="text-sm">No conferences are currently in session.</div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {conferences.map((conf) => (
            <div
              key={conf.name}
              className="rounded-2xl p-5"
              style={{
                background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
                border: '1px solid rgba(42,47,69,0.6)',
              }}
            >
              <div className="flex items-center gap-2.5 mb-4">
                <div
                  className="flex items-center justify-center rounded-[9px] shrink-0"
                  style={{ width: 34, height: 34, color: '#60a5fa', background: 'rgba(59,130,246,0.12)', border: '1px solid rgba(59,130,246,0.25)' }}
                >
                  <Video size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-[#f1f5f9] truncate">{conf.name}</div>
                </div>
                <span className="inline-flex items-center gap-1.5 text-xs text-[#94a3b8]">
                  <Users size={13} className="text-[#475569]" />
                  {conf.member_count} {conf.member_count === 1 ? 'member' : 'members'}
                </span>
              </div>

              {conf.members.length === 0 ? (
                <div className="text-sm text-[#475569] py-2">Room is active but reports no members.</div>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {conf.members.map((m) => (
                    <MemberRow key={m.id} room={conf.name} member={m} onActed={() => void refetch()} />
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
