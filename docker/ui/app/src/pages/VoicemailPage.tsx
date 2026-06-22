import { useMemo, useState } from 'react';
import {
  useQuery,
  useMutation,
  useQueryClient,
  keepPreviousData,
} from '@tanstack/react-query';
import { Inbox, Mail, Star, Trash2, Plus, Phone, Search, ChevronDown, Forward } from 'lucide-react';
import { Sidebar } from '../components/layout/Sidebar';
import { SoftphoneWidget } from '../components/softphone/SoftphoneWidget';
import { AdminCustomerSelector } from '../components/AdminCustomerSelector';
import { useSoftphone } from '../contexts/SoftphoneContext';
import { useAuth } from '../contexts/AuthContext';
import { useToast } from '../components/ui/Toast';
import { fmt } from '../utils/format';
import {
  listMailboxes,
  getMailboxMessageCount,
  listMailboxMessages,
  getMessage,
  markMessageRead,
  markMessageSaved,
  deleteMessage,
} from '../api/voicemail';
import type { VoicemailMailbox, VoicemailMessage, Transcript } from '../types/voicemail';
import { VoicemailPlayer } from './voicemail/player/VoicemailPlayer';
import { EncryptionBadge } from './voicemail/shared/EncryptionBadge';
import { VoicemailSetupWizard } from './voicemail/setup/VoicemailSetupWizard';

const ACCENT = '#818cf8';

const GLOBAL_STYLES = `
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes vmFadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: translateY(0); } }
`;

/* ─── Folders ─────────────────────────────────────────────── */

type Folder = 'inbox' | 'unread' | 'saved' | 'trash';

const FOLDERS: { id: Folder; label: string; icon: React.ReactNode }[] = [
  { id: 'inbox', label: 'Inbox', icon: <Inbox size={15} /> },
  { id: 'unread', label: 'Unread', icon: <Mail size={15} /> },
  { id: 'saved', label: 'Saved', icon: <Star size={15} /> },
  { id: 'trash', label: 'Trash', icon: <Trash2 size={15} /> },
];

/* ─── Helpers ─────────────────────────────────────────────── */

function formatDuration(ms: number): string {
  const s = Math.floor((ms ?? 0) / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) {
    const diffH = Math.floor(diffMs / 3600000);
    if (diffH === 0) {
      const diffM = Math.floor(diffMs / 60000);
      return diffM < 2 ? 'Just now' : `${diffM}m ago`;
    }
    return `${diffH}h ago`;
  }
  if (diffDays === 1) return 'Yesterday';
  if (diffDays < 7) return d.toLocaleDateString([], { weekday: 'long' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

function transcriptPreview(status: VoicemailMessage['transcript_status']): string {
  switch (status) {
    case 'done':
      return 'Transcription ready — open to read';
    case 'processing':
    case 'pending':
      return 'Transcribing…';
    case 'failed':
      return 'Transcription unavailable';
    default:
      return 'No transcription';
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * Page
 * ──────────────────────────────────────────────────────────────────────── */

export function VoicemailPage() {
  // All hooks unconditionally at the top (React #310).
  const { isAdmin } = useAuth();
  const { refreshVoicemailCount, makeCall, connectionState } = useSoftphone();
  const { toastOk, toastErr } = useToast();
  const queryClient = useQueryClient();

  const [customerId, setCustomerId] = useState<number | undefined>(undefined);
  const [mailboxSel, setMailboxId] = useState<number | null>(null);
  const [folder, setFolder] = useState<Folder>('inbox');
  const [search, setSearch] = useState('');
  const [selectedSel, setSelectedId] = useState<number | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);

  const mailboxesQuery = useQuery({
    queryKey: ['voicemail', 'mailboxes', { customerId }],
    queryFn: () => listMailboxes({ customer_id: customerId }),
    staleTime: 30_000,
  });
  const mailboxes = useMemo(() => mailboxesQuery.data ?? [], [mailboxesQuery.data]);

  // Effective mailbox: the user's pick if still valid, else the first mailbox.
  // Derived during render (never setState-in-effect) so a customer switch or a
  // deleted mailbox transparently falls back to a sensible default.
  const mailboxId =
    mailboxSel !== null && mailboxes.some((m) => m.id === mailboxSel)
      ? mailboxSel
      : mailboxes[0]?.id ?? null;

  const countQuery = useQuery({
    queryKey: ['voicemail', 'count', mailboxId],
    queryFn: () => getMailboxMessageCount(mailboxId as number),
    enabled: mailboxId !== null,
  });

  const activeQuery = useQuery({
    queryKey: ['voicemail', 'messages', mailboxId, 'active'],
    queryFn: () => listMailboxMessages(mailboxId as number, { include_deleted: false, limit: 200 }),
    enabled: mailboxId !== null,
    placeholderData: keepPreviousData,
  });

  // Trash is everything-minus-active; only fetched when the Trash folder is open.
  const allQuery = useQuery({
    queryKey: ['voicemail', 'messages', mailboxId, 'all'],
    queryFn: () => listMailboxMessages(mailboxId as number, { include_deleted: true, limit: 200 }),
    enabled: mailboxId !== null && folder === 'trash',
    placeholderData: keepPreviousData,
  });

  /* ── derived folder lists ─────────────────────────────────── */
  const activeMessages = useMemo(() => activeQuery.data ?? [], [activeQuery.data]);
  const trashMessages = useMemo(() => {
    const activeIds = new Set(activeMessages.map((m) => m.id));
    return (allQuery.data ?? []).filter((m) => !activeIds.has(m.id));
  }, [allQuery.data, activeMessages]);

  const folderMessages = useMemo(() => {
    switch (folder) {
      case 'unread':
        return activeMessages.filter((m) => !m.is_read);
      case 'saved':
        return activeMessages.filter((m) => m.is_saved);
      case 'trash':
        return trashMessages;
      default:
        return activeMessages;
    }
  }, [folder, activeMessages, trashMessages]);

  const visibleMessages = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return folderMessages;
    return folderMessages.filter(
      (m) =>
        (m.caller_id ?? '').toLowerCase().includes(q) ||
        (m.caller_name ?? '').toLowerCase().includes(q),
    );
  }, [folderMessages, search]);

  // Effective selection: the user's pick if still in view, else the first row.
  // Also derived during render so it auto-selects without a setState effect.
  const selectedId =
    selectedSel !== null && visibleMessages.some((m) => m.id === selectedSel)
      ? selectedSel
      : visibleMessages[0]?.id ?? null;

  const detailQuery = useQuery({
    queryKey: ['voicemail', 'message', selectedId],
    queryFn: () => getMessage(selectedId as number),
    enabled: selectedId !== null,
    staleTime: 0,
  });

  /* ── mutations ────────────────────────────────────────────── */
  const invalidateMessages = () => {
    void queryClient.invalidateQueries({ queryKey: ['voicemail', 'messages', mailboxId] });
    void queryClient.invalidateQueries({ queryKey: ['voicemail', 'count', mailboxId] });
    refreshVoicemailCount();
  };

  const readMutation = useMutation({
    mutationFn: (id: number) => markMessageRead(id, true),
    onSuccess: invalidateMessages,
  });

  const saveMutation = useMutation({
    mutationFn: ({ id, saved }: { id: number; saved: boolean }) => markMessageSaved(id, saved),
    onSuccess: (_, { saved }) => {
      invalidateMessages();
      toastOk(saved ? 'Saved' : 'Removed from Saved');
    },
    onError: (e: Error) => toastErr(e.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteMessage(id),
    onSuccess: () => {
      invalidateMessages();
      void queryClient.invalidateQueries({ queryKey: ['voicemail', 'messages', mailboxId, 'all'] });
      toastOk('Message deleted');
      setSelectedId(null);
    },
    onError: (e: Error) => toastErr(e.message),
  });

  const selectedMailbox = mailboxes.find((m) => m.id === mailboxId) ?? null;
  const selectedMessage = visibleMessages.find((m) => m.id === selectedId) ?? null;

  const count = countQuery.data;
  const folderCounts: Record<Folder, number | undefined> = {
    inbox: count?.total,
    unread: count?.unread,
    saved: count?.saved,
    trash: folder === 'trash' ? trashMessages.length : undefined,
  };

  /* ── render ───────────────────────────────────────────────── */
  return (
    <div style={{ display: 'flex', height: '100vh', width: '100vw', overflow: 'hidden', background: '#0f1117' }}>
      <style>{GLOBAL_STYLES}</style>
      <Sidebar />

      <div style={{ marginLeft: 240, flex: 1, display: 'flex', overflow: 'hidden', height: '100vh', minWidth: 0 }}>
        {/* ── Rail: folders + mailbox switcher ──────────────── */}
        <aside
          style={{
            width: 256,
            flexShrink: 0,
            borderRight: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
            background: '#0c0e16',
            minHeight: 0,
          }}
        >
          <div style={{ padding: '18px 16px 12px', borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontSize: '0.7rem', fontWeight: 700, color: '#334155', textTransform: 'uppercase', letterSpacing: '0.12em' }}>
                Voicemail
              </span>
              <button
                type="button"
                onClick={() => setWizardOpen(true)}
                title="New mailbox"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  padding: '5px 9px',
                  borderRadius: 8,
                  border: `1px solid ${ACCENT}44`,
                  background: `${ACCENT}1a`,
                  color: ACCENT,
                  fontSize: '0.68rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                <Plus size={12} strokeWidth={2.5} /> New
              </button>
            </div>

            <MailboxSwitcher mailboxes={mailboxes} selectedId={mailboxId} onSelect={setMailboxId} />
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
            {FOLDERS.map((f) => (
              <FolderItem
                key={f.id}
                icon={f.icon}
                label={f.label}
                count={folderCounts[f.id]}
                active={folder === f.id}
                onClick={() => setFolder(f.id)}
              />
            ))}
          </div>

          {isAdmin && (
            <div style={{ padding: '10px 12px', borderTop: '1px solid rgba(255,255,255,0.05)' }}>
              <AdminCustomerSelector
                selectedCustomerId={customerId}
                onSelect={(id) => { setCustomerId(id); setMailboxId(null); setSelectedId(null); }}
                accent={ACCENT}
              />
            </div>
          )}
        </aside>

        {/* ── Message list ───────────────────────────────────── */}
        <section
          style={{
            width: 360,
            flexShrink: 0,
            borderRight: '1px solid rgba(255,255,255,0.06)',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0,
            background: '#0b0d14',
          }}
        >
          <div style={{ padding: '14px 16px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
            <div style={{ position: 'relative' }}>
              <Search size={14} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: '#475569' }} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search messages"
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '8px 12px 8px 32px',
                  borderRadius: 8,
                  border: '1px solid rgba(255,255,255,0.08)',
                  background: 'rgba(15,17,23,0.8)',
                  color: '#e2e8f0',
                  fontSize: '0.8rem',
                  outline: 'none',
                }}
              />
            </div>
          </div>

          <div style={{ flex: 1, overflowY: 'auto' }}>
            {mailboxId === null && !mailboxesQuery.isLoading ? (
              <NoMailboxes onCreate={() => setWizardOpen(true)} />
            ) : activeQuery.isLoading || (folder === 'trash' && allQuery.isLoading) ? (
              <CenterSpinner />
            ) : visibleMessages.length === 0 ? (
              <EmptyFolder folder={folder} hasSearch={search.trim().length > 0} />
            ) : (
              visibleMessages.map((m) => (
                <MessageRow
                  key={m.id}
                  message={m}
                  selected={m.id === selectedId}
                  onClick={() => setSelectedId(m.id)}
                />
              ))
            )}
          </div>
        </section>

        {/* ── Reading pane ───────────────────────────────────── */}
        <section style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', background: '#0f1117' }}>
          {selectedMessage ? (
            <ReadingPane
              key={selectedMessage.id}
              message={selectedMessage}
              detail={detailQuery.data}
              detailLoading={detailQuery.isLoading}
              isTrash={folder === 'trash'}
              canCallBack={connectionState === 'registered'}
              onPlay={() => { if (!selectedMessage.is_read) readMutation.mutate(selectedMessage.id); }}
              onCallBack={() => void makeCall(selectedMessage.caller_id)}
              onToggleSave={() => saveMutation.mutate({ id: selectedMessage.id, saved: !selectedMessage.is_saved })}
              onDelete={() => deleteMutation.mutate(selectedMessage.id)}
              deleting={deleteMutation.isPending}
            />
          ) : (
            <ReadingEmpty mailbox={selectedMailbox} />
          )}
        </section>
      </div>

      <SoftphoneWidget />

      <VoicemailSetupWizard
        open={wizardOpen}
        onClose={() => setWizardOpen(false)}
        customerId={customerId}
        onCreated={(id) => {
          setWizardOpen(false);
          setMailboxId(id);
          setSelectedId(null);
          void queryClient.invalidateQueries({ queryKey: ['voicemail', 'mailboxes'] });
        }}
      />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
 * Mailbox switcher
 * ──────────────────────────────────────────────────────────────────────── */

function MailboxSwitcher({
  mailboxes,
  selectedId,
  onSelect,
}: {
  mailboxes: VoicemailMailbox[];
  selectedId: number | null;
  onSelect: (id: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = mailboxes.find((m) => m.id === selectedId);

  if (mailboxes.length === 0) {
    return (
      <div style={{ fontSize: '0.74rem', color: '#475569', padding: '8px 4px' }}>No mailboxes yet</div>
    );
  }

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          width: '100%',
          padding: '9px 11px',
          borderRadius: 9,
          border: `1px solid ${ACCENT}30`,
          background: `${ACCENT}12`,
          color: '#e2e8f0',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', minWidth: 0 }}>
          <span style={{ fontSize: '0.82rem', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 180 }}>
            {selected?.label ?? `Mailbox ${selected?.id ?? ''}`}
          </span>
          <span style={{ fontSize: '0.64rem', color: ACCENT }}>{mailboxes.length} mailbox{mailboxes.length === 1 ? '' : 'es'}</span>
        </span>
        <ChevronDown size={14} style={{ color: ACCENT, transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }} />
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            right: 0,
            zIndex: 30,
            background: '#161922',
            border: '1px solid rgba(255,255,255,0.1)',
            borderRadius: 10,
            boxShadow: '0 12px 36px rgba(0,0,0,0.6)',
            overflow: 'hidden',
            maxHeight: 280,
            overflowY: 'auto',
          }}
        >
          {mailboxes.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => { onSelect(m.id); setOpen(false); }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '9px 12px',
                background: m.id === selectedId ? `${ACCENT}1c` : 'transparent',
                border: 'none',
                color: '#e2e8f0',
                cursor: 'pointer',
                fontSize: '0.8rem',
                fontFamily: 'inherit',
              }}
            >
              <span style={{ fontWeight: 600 }}>{m.label ?? `Mailbox ${m.id}`}</span>
              {m.status !== 'active' && (
                <span style={{ marginLeft: 8, fontSize: '0.64rem', color: '#f59e0b' }}>{m.status}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Folder item ─────────────────────────────────────────── */

function FolderItem({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count: number | undefined;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        width: '100%',
        padding: '8px 12px',
        marginBottom: 2,
        borderRadius: 9,
        border: '1px solid transparent',
        background: active ? `linear-gradient(135deg, ${ACCENT}22 0%, ${ACCENT}0e 100%)` : 'transparent',
        borderColor: active ? `${ACCENT}40` : 'transparent',
        color: active ? '#e2e8f0' : '#64748b',
        cursor: 'pointer',
        fontFamily: 'inherit',
        transition: 'all 0.12s',
      }}
    >
      <span style={{ color: active ? ACCENT : '#475569', display: 'flex' }}>{icon}</span>
      <span style={{ flex: 1, textAlign: 'left', fontSize: '0.83rem', fontWeight: active ? 700 : 500 }}>{label}</span>
      {count !== undefined && count > 0 && (
        <span
          style={{
            fontSize: '0.64rem',
            fontWeight: 700,
            padding: '1px 6px',
            borderRadius: 5,
            background: active ? `${ACCENT}2a` : 'rgba(255,255,255,0.06)',
            color: active ? ACCENT : '#475569',
          }}
        >
          {count}
        </span>
      )}
    </button>
  );
}

/* ─── Message row ─────────────────────────────────────────── */

function MessageRow({
  message,
  selected,
  onClick,
}: {
  message: VoicemailMessage;
  selected: boolean;
  onClick: () => void;
}) {
  const displayName = message.caller_name && message.caller_name !== message.caller_id ? message.caller_name : null;
  const initial = (displayName ?? message.caller_id ?? '?').charAt(0).toUpperCase();

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'flex',
        gap: 11,
        width: '100%',
        textAlign: 'left',
        padding: '13px 16px',
        borderBottom: '1px solid rgba(255,255,255,0.04)',
        borderLeft: `2px solid ${selected ? ACCENT : 'transparent'}`,
        background: selected ? `${ACCENT}14` : message.is_read ? 'transparent' : `${ACCENT}08`,
        cursor: 'pointer',
        fontFamily: 'inherit',
        animation: 'vmFadeIn 0.18s ease-out',
        transition: 'background 0.12s',
      }}
    >
      <div style={{ position: 'relative', flexShrink: 0 }}>
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: `linear-gradient(135deg, ${ACCENT}33 0%, ${ACCENT}18 100%)`,
            border: `1px solid ${ACCENT}33`,
            color: ACCENT,
            fontWeight: 700,
            fontSize: '0.85rem',
          }}
        >
          {initial}
        </div>
        {!message.is_read && (
          <span style={{ position: 'absolute', top: -1, right: -1, width: 9, height: 9, borderRadius: '50%', background: ACCENT, border: '2px solid #0b0d14' }} />
        )}
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
          <span style={{ fontSize: '0.84rem', fontWeight: message.is_read ? 600 : 700, color: '#e2e8f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {displayName ?? fmt(message.caller_id)}
          </span>
          <span style={{ fontSize: '0.66rem', color: '#475569', flexShrink: 0 }}>{formatDate(message.created_at)}</span>
        </div>
        <div style={{ fontSize: '0.7rem', color: '#64748b', fontFamily: 'monospace', marginTop: 1 }}>
          {displayName ? fmt(message.caller_id) : `${formatDuration(message.duration_ms)} min`}
        </div>
        <div style={{ fontSize: '0.7rem', color: '#475569', marginTop: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {transcriptPreview(message.transcript_status)}
        </div>
      </div>
    </button>
  );
}

/* ─── Reading pane ────────────────────────────────────────── */

interface ReadingPaneProps {
  message: VoicemailMessage;
  detail: VoicemailMessage | undefined;
  detailLoading: boolean;
  isTrash: boolean;
  canCallBack: boolean;
  onPlay: () => void;
  onCallBack: () => void;
  onToggleSave: () => void;
  onDelete: () => void;
  deleting: boolean;
}

function ReadingPane({
  message,
  detail,
  detailLoading,
  isTrash,
  canCallBack,
  onPlay,
  onCallBack,
  onToggleSave,
  onDelete,
  deleting,
}: ReadingPaneProps) {
  const displayName = message.caller_name && message.caller_name !== message.caller_id ? message.caller_name : null;

  const forwardHref = useMemo(() => {
    const subject = `Voicemail from ${displayName ?? fmt(message.caller_id)}`;
    const lines = [
      `From: ${displayName ? `${displayName} (${fmt(message.caller_id)})` : fmt(message.caller_id)}`,
      `Received: ${new Date(message.created_at).toLocaleString()}`,
      `Duration: ${formatDuration(message.duration_ms)}`,
    ];
    if (detail?.transcript?.status === 'done' && detail.transcript.text) {
      lines.push('', 'Transcript:', detail.transcript.text);
    } else {
      lines.push('', '(Audio is encrypted — open it in the revup portal to listen.)');
    }
    return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join('\n'))}`;
  }, [displayName, message, detail]);

  return (
    <>
      {/* Header */}
      <div style={{ padding: '20px 28px', borderBottom: '1px solid rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
          <div
            style={{
              width: 46,
              height: 46,
              borderRadius: '50%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `linear-gradient(135deg, ${ACCENT}33 0%, ${ACCENT}18 100%)`,
              border: `1px solid ${ACCENT}33`,
              color: ACCENT,
              fontWeight: 700,
              fontSize: '1.1rem',
              flexShrink: 0,
            }}
          >
            {(displayName ?? message.caller_id ?? '?').charAt(0).toUpperCase()}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '1.02rem', fontWeight: 700, color: '#f1f5f9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {displayName ?? fmt(message.caller_id)}
            </div>
            <div style={{ fontSize: '0.76rem', color: '#64748b', display: 'flex', gap: 8, marginTop: 2 }}>
              {displayName && <span style={{ fontFamily: 'monospace' }}>{fmt(message.caller_id)}</span>}
              <span>{formatDate(message.created_at)}</span>
              <span>·</span>
              <span>{formatDuration(message.duration_ms)}</span>
            </div>
          </div>
        </div>
        <EncryptionBadge size="sm" />
      </div>

      {/* Body */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '24px 28px', display: 'flex', flexDirection: 'column', gap: 22 }}>
        <VoicemailPlayer
          messageId={message.id}
          durationMs={message.duration_ms}
          peaks={message.peaks}
          onFirstPlay={onPlay}
        />

        <TranscriptPanel transcript={detail?.transcript} loading={detailLoading} />
      </div>

      {/* Actions */}
      <div style={{ padding: '16px 28px', borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', gap: 10, flexShrink: 0 }}>
        <ActionButton
          icon={<Phone size={15} />}
          label="Call back"
          onClick={onCallBack}
          disabled={!canCallBack}
          title={canCallBack ? 'Call back' : 'Softphone not connected'}
        />
        <ActionButton
          icon={<Star size={15} fill={message.is_saved ? ACCENT : 'none'} />}
          label={message.is_saved ? 'Saved' : 'Save'}
          onClick={onToggleSave}
          active={message.is_saved}
        />
        <a
          href={forwardHref}
          style={{ textDecoration: 'none' }}
        >
          <ActionButton icon={<Forward size={15} />} label="Forward" onClick={() => undefined} asChild />
        </a>
        <div style={{ flex: 1 }} />
        {!isTrash && (
          <ActionButton
            icon={<Trash2 size={15} />}
            label={deleting ? 'Deleting…' : 'Delete'}
            onClick={onDelete}
            disabled={deleting}
            danger
          />
        )}
      </div>
    </>
  );
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
  active,
  danger,
  title,
  asChild,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
  title?: string;
  asChild?: boolean;
}) {
  const color = danger ? '#f87171' : active ? ACCENT : '#94a3b8';
  const border = danger ? 'rgba(239,68,68,0.25)' : active ? `${ACCENT}44` : 'rgba(255,255,255,0.1)';
  const bg = danger ? 'rgba(239,68,68,0.08)' : active ? `${ACCENT}18` : 'rgba(255,255,255,0.03)';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      tabIndex={asChild ? -1 : 0}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        padding: '8px 14px',
        borderRadius: 9,
        border: `1px solid ${border}`,
        background: bg,
        color,
        fontSize: '0.78rem',
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: 'all 0.12s',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

/* ─── Transcript panel ────────────────────────────────────── */

function TranscriptPanel({ transcript, loading }: { transcript: Transcript | undefined; loading: boolean }) {
  let body: React.ReactNode;
  if (loading) {
    body = <span style={{ color: '#475569', fontSize: '0.82rem' }}>Loading…</span>;
  } else if (transcript?.status === 'done' && transcript.text) {
    body = <p style={{ color: '#cbd5e0', fontSize: '0.88rem', lineHeight: 1.7, margin: 0 }}>{transcript.text}</p>;
  } else {
    const msg =
      transcript?.status === 'processing' || transcript?.status === 'pending'
        ? 'Transcription is in progress — check back shortly.'
        : transcript?.status === 'failed'
          ? 'A transcript couldn’t be generated for this message.'
          : 'Transcription isn’t enabled for this message.';
    body = <span style={{ color: '#475569', fontSize: '0.83rem', fontStyle: 'italic' }}>{msg}</span>;
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: '0.68rem', fontWeight: 700, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
          Transcript
        </span>
        {transcript?.language && (
          <span style={{ fontSize: '0.64rem', color: '#475569', textTransform: 'uppercase' }}>{transcript.language}</span>
        )}
      </div>
      <div style={{ padding: '14px 16px', borderRadius: 12, background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)' }}>
        {body}
      </div>
    </div>
  );
}

/* ─── Empty / loading states ──────────────────────────────── */

function CenterSpinner() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', height: '100%' }}>
      <div style={{ width: 26, height: 26, border: '2px solid rgba(255,255,255,0.08)', borderTopColor: ACCENT, borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
    </div>
  );
}

function EmptyFolder({ folder, hasSearch }: { folder: Folder; hasSearch: boolean }) {
  const text = hasSearch
    ? 'No messages match your search.'
    : folder === 'unread'
      ? 'You’re all caught up — no unread messages.'
      : folder === 'saved'
        ? 'No saved messages yet.'
        : folder === 'trash'
          ? 'Trash is empty.'
          : 'No messages in this mailbox yet.';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', padding: 40, gap: 10, textAlign: 'center' }}>
      <Inbox size={34} style={{ color: '#2d3748' }} />
      <span style={{ color: '#475569', fontSize: '0.85rem' }}>{text}</span>
    </div>
  );
}

function ReadingEmpty({ mailbox }: { mailbox: VoicemailMailbox | null }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 14, padding: 48, color: '#334155' }}>
      <div
        style={{
          width: 76,
          height: 76,
          borderRadius: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: `linear-gradient(135deg, ${ACCENT}1f 0%, ${ACCENT}0c 100%)`,
          border: `1px solid ${ACCENT}33`,
          color: ACCENT,
        }}
      >
        <Mail size={32} />
      </div>
      <div style={{ textAlign: 'center', maxWidth: 280 }}>
        <div style={{ fontSize: '1rem', fontWeight: 700, color: '#94a3b8', marginBottom: 6 }}>
          {mailbox ? 'Select a message' : 'No mailbox selected'}
        </div>
        <div style={{ fontSize: '0.85rem', color: '#475569', lineHeight: 1.6 }}>
          Choose a message from the list to listen, read its transcript, and reply.
        </div>
      </div>
    </div>
  );
}

function NoMailboxes({ onCreate }: { onCreate: () => void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16, padding: 40, textAlign: 'center' }}>
      <div
        style={{
          width: 72,
          height: 72,
          borderRadius: 20,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: `linear-gradient(135deg, ${ACCENT}1f 0%, ${ACCENT}0c 100%)`,
          border: `1px solid ${ACCENT}33`,
          color: ACCENT,
        }}
      >
        <Inbox size={30} />
      </div>
      <div>
        <div style={{ fontSize: '0.95rem', fontWeight: 700, color: '#94a3b8', marginBottom: 6 }}>No voicemail boxes yet</div>
        <div style={{ fontSize: '0.82rem', color: '#475569', lineHeight: 1.6, maxWidth: 240, marginBottom: 16 }}>
          Create an encrypted voicemail box — buy a dedicated number or add it to a line you already have.
        </div>
        <button
          type="button"
          onClick={onCreate}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            padding: '9px 16px',
            borderRadius: 10,
            border: 'none',
            background: `linear-gradient(135deg, ${ACCENT} 0%, #6366f1 100%)`,
            color: '#fff',
            fontSize: '0.82rem',
            fontWeight: 700,
            cursor: 'pointer',
            fontFamily: 'inherit',
            boxShadow: `0 4px 16px ${ACCENT}44`,
          }}
        >
          <Plus size={15} strokeWidth={2.5} /> New mailbox
        </button>
      </div>
    </div>
  );
}
