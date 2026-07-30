/**
 * ApiKeysPanel — the "API Keys" surface on the Programmable Voice portal.
 *
 * Lists the customer's API keys (masked), mints new key/secret pairs (the
 * plaintext secret is revealed ONCE in a copyable modal with a hard "save this
 * now" warning), and revokes keys behind a confirm.
 *
 * React #310: every hook is declared unconditionally at the top of each
 * component, before any early return.
 */

import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus, Copy, Check, Trash2, ShieldAlert, Eye, EyeOff } from 'lucide-react';
import { Button } from '../../components/ui/Button';
import { Spinner } from '../../components/ui/Spinner';
import { Modal } from '../../components/ui/Modal';
import { FormField } from '../../components/ui/FormField';
import { Badge } from '../../components/ui/Badge';
import { useToast } from '../../components/ui/Toast';
import {
  listApiCredentials,
  createApiCredential,
  deleteApiCredential,
} from '../../api/apiCredentials';
import type { ApiCredential, ApiCredentialCreated } from '../../types/apiCredential';

const ACCENT = '#3b82f6';

interface ApiKeysPanelProps {
  /** When false (readonly users), hide create/revoke affordances. */
  canManage: boolean;
}

export function ApiKeysPanel({ canManage }: ApiKeysPanelProps) {
  // ── ALL hooks first (React #310) ──────────────────────────────────────────
  const queryClient = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [createOpen, setCreateOpen] = useState(false);
  const [revealCredential, setRevealCredential] = useState<ApiCredentialCreated | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<ApiCredential | null>(null);

  const { data: keys = [], isLoading, isError } = useQuery({
    queryKey: ['api-credentials'],
    queryFn: listApiCredentials,
  });

  const createMutation = useMutation({
    mutationFn: createApiCredential,
    onSuccess: (created) => {
      void queryClient.invalidateQueries({ queryKey: ['api-credentials'] });
      setCreateOpen(false);
      // Surface the one-and-only plaintext secret immediately.
      setRevealCredential(created);
      toastOk('API key generated');
    },
    onError: (error: Error) => toastErr(error.message ?? 'Failed to generate key'),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: number) => deleteApiCredential(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['api-credentials'] });
      setConfirmRevoke(null);
      toastOk('API key revoked');
    },
    onError: (error: Error) => toastErr(error.message ?? 'Failed to revoke key'),
  });

  const activeCount = keys.filter((k) => k.status === 'active').length;

  return (
    <section className="glass-surface" style={{ padding: 24, position: 'relative', overflow: 'hidden' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 4,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: `linear-gradient(135deg, ${ACCENT}22 0%, ${ACCENT}0d 100%)`,
              border: `1px solid ${ACCENT}33`,
              color: '#60a5fa',
            }}
            aria-hidden="true"
          >
            <KeyRound size={18} />
          </div>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ fontSize: '1rem', fontWeight: 700, color: '#e2e8f0', margin: 0, letterSpacing: '-0.01em' }}>
              API Keys
            </h2>
            <p style={{ fontSize: '0.78rem', color: '#718096', margin: '2px 0 0' }}>
              Authenticate REST calls with HTTP Basic using a key / secret pair.
            </p>
          </div>
        </div>

        {canManage && (
          <Button
            variant="primary"
            size="sm"
            icon={<Plus size={14} />}
            onClick={() => setCreateOpen(true)}
          >
            Generate API key
          </Button>
        )}
      </div>

      {/* Body */}
      <div style={{ marginTop: 18 }}>
        {isLoading ? (
          <div className="flex items-center justify-center gap-3" style={{ padding: '32px 0' }}>
            <Spinner size="sm" />
            <span style={{ color: '#718096', fontSize: '0.85rem' }}>Loading keys…</span>
          </div>
        ) : isError ? (
          <div style={{ padding: '24px 0', textAlign: 'center', color: '#f87171', fontSize: '0.85rem' }}>
            Failed to load API keys.
          </div>
        ) : keys.length === 0 ? (
          <EmptyKeys canManage={canManage} onCreate={() => setCreateOpen(true)} />
        ) : (
          <>
            <div
              style={{
                fontSize: '0.7rem',
                color: '#475569',
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
                fontWeight: 700,
                marginBottom: 10,
              }}
            >
              {keys.length} key{keys.length !== 1 ? 's' : ''} · {activeCount} active
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {keys.map((key) => (
                <KeyRow
                  key={key.id}
                  cred={key}
                  canManage={canManage}
                  onRevoke={() => setConfirmRevoke(key)}
                  revoking={revokeMutation.isPending && confirmRevoke?.id === key.id}
                />
              ))}
            </div>
          </>
        )}
      </div>

      {/* Create modal */}
      <CreateKeyModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={(payload) => createMutation.mutate(payload)}
        isSubmitting={createMutation.isPending}
      />

      {/* One-time secret reveal modal */}
      <SecretRevealModal
        credential={revealCredential}
        onClose={() => setRevealCredential(null)}
      />

      {/* Revoke confirm modal */}
      <RevokeConfirmModal
        cred={confirmRevoke}
        onClose={() => setConfirmRevoke(null)}
        onConfirm={(id) => revokeMutation.mutate(id)}
        isRevoking={revokeMutation.isPending}
      />
    </section>
  );
}

/* ── Empty state ─────────────────────────────────────────────────────────── */

function EmptyKeys({ canManage, onCreate }: { canManage: boolean; onCreate: () => void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        textAlign: 'center',
        padding: '40px 24px',
        border: '1px dashed rgba(59,130,246,0.20)',
        borderRadius: 14,
        gap: 12,
      }}
    >
      <div
        style={{
          width: 44,
          height: 44,
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(59,130,246,0.10)',
          border: '1px solid rgba(59,130,246,0.20)',
          color: '#60a5fa',
        }}
        aria-hidden="true"
      >
        <KeyRound size={20} />
      </div>
      <div>
        <p style={{ color: '#94a3b8', fontSize: '0.9rem', fontWeight: 600, margin: '0 0 4px' }}>
          No API keys yet
        </p>
        <p style={{ color: '#475569', fontSize: '0.8rem', margin: 0, lineHeight: 1.6 }}>
          Generate a key to start making authenticated programmable-voice API calls.
        </p>
      </div>
      {canManage && (
        <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={onCreate}>
          Generate API key
        </Button>
      )}
    </div>
  );
}

/* ── One key row (masked) ────────────────────────────────────────────────── */

/**
 * Mask a key id for display: keep a short readable prefix and suffix, dot out
 * the middle. Purely cosmetic — the key id is not secret, but this keeps the
 * row compact and consistent with the "secret is hidden" mental model.
 */
function maskKey(apiKey: string): string {
  if (apiKey.length <= 12) return apiKey;
  return `${apiKey.slice(0, 8)}…${apiKey.slice(-4)}`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return iso;
  const diffSec = Math.floor((Date.now() - then) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function KeyRow({
  cred,
  canManage,
  onRevoke,
  revoking,
}: {
  cred: ApiCredential;
  canManage: boolean;
  onRevoke: () => void;
  revoking: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopyKey = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(cred.api_key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }, [cred.api_key]);

  const isActive = cred.status === 'active';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '12px 14px',
        borderRadius: 10,
        border: '1px solid rgba(59,130,246,0.12)',
        background: 'rgba(19,21,29,0.55)',
        opacity: isActive ? 1 : 0.6,
      }}
    >
      {/* Key id + label */}
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <code
            style={{
              fontSize: '0.82rem',
              fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
              color: '#cbd5e0',
              letterSpacing: '0.02em',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={cred.api_key}
          >
            {maskKey(cred.api_key)}
          </code>
          <button
            type="button"
            onClick={handleCopyKey}
            title="Copy key id"
            aria-label="Copy key id"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 24,
              height: 24,
              borderRadius: 6,
              border: 'none',
              background: 'transparent',
              color: copied ? '#22c55e' : '#64748b',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />}
          </button>
        </div>
        <div style={{ fontSize: '0.72rem', color: '#64748b', marginTop: 4 }}>
          {cred.label ? (
            <span style={{ color: '#94a3b8' }}>{cred.label}</span>
          ) : (
            <span style={{ fontStyle: 'italic', color: '#475569' }}>No label</span>
          )}
          <span style={{ color: '#334155' }}>{'  ·  created '}{formatWhen(cred.created_at)}</span>
          <span style={{ color: '#334155' }}>{'  ·  last used '}{formatWhen(cred.last_used_at)}</span>
        </div>
      </div>

      {/* Status */}
      <Badge variant={isActive ? 'active' : 'disabled'}>{isActive ? 'Active' : cred.status}</Badge>

      {/* Revoke */}
      {canManage && isActive && (
        <Button
          variant="danger"
          size="xs"
          icon={<Trash2 size={13} />}
          loading={revoking}
          onClick={onRevoke}
        >
          Revoke
        </Button>
      )}
    </div>
  );
}

/* ── Create key modal ────────────────────────────────────────────────────── */

function CreateKeyModal({
  open,
  onClose,
  onSubmit,
  isSubmitting,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (payload: { label?: string; status_callback_url?: string }) => void;
  isSubmitting: boolean;
}) {
  const [label, setLabel] = useState('');
  const [statusCallback, setStatusCallback] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Reset local form each time the modal transitions open.
  const handleClose = useCallback(() => {
    setLabel('');
    setStatusCallback('');
    setError(null);
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(() => {
    const cb = statusCallback.trim();
    if (cb) {
      try {
        const parsed = new URL(cb);
        if (parsed.protocol !== 'https:') {
          setError('Status callback URL must use https://');
          return;
        }
      } catch {
        setError('Enter a valid status callback URL');
        return;
      }
    }
    setError(null);
    onSubmit({
      label: label.trim() || undefined,
      status_callback_url: cb || undefined,
    });
  }, [label, statusCallback, onSubmit]);

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Generate API key"
      maxWidth="max-w-md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={handleSubmit} loading={isSubmitting}>
            Generate key
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p style={{ fontSize: '0.82rem', color: '#94a3b8', lineHeight: 1.6, margin: 0 }}>
          A new key id and secret will be created. The secret is shown{' '}
          <strong style={{ color: '#e2e8f0' }}>only once</strong> — copy it before closing.
        </p>

        <FormField
          label="Label"
          placeholder="e.g. Production server"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          hint="Optional — helps you identify this key later."
          disabled={isSubmitting}
          maxLength={80}
        />

        <FormField
          label="Status callback URL"
          type="url"
          placeholder="https://your-app.com/status"
          value={statusCallback}
          onChange={(e) => { setStatusCallback(e.target.value); setError(null); }}
          hint="Optional — default status callback for calls authenticated with this key."
          error={error ?? undefined}
          disabled={isSubmitting}
        />
      </div>
    </Modal>
  );
}

/* ── One-time secret reveal modal ────────────────────────────────────────── */

function SecretRevealModal({
  credential,
  onClose,
}: {
  credential: ApiCredentialCreated | null;
  onClose: () => void;
}) {
  const [copiedField, setCopiedField] = useState<'key' | 'secret' | 'basic' | null>(null);
  const [revealed, setRevealed] = useState(true);

  const copy = useCallback(async (text: string, field: 'key' | 'secret' | 'basic') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField((prev) => (prev === field ? null : prev)), 1500);
    } catch {
      /* clipboard unavailable — user can select manually */
    }
  }, []);

  // When the modal closes, reset local reveal state so a future key starts fresh.
  const handleClose = useCallback(() => {
    setRevealed(true);
    setCopiedField(null);
    onClose();
  }, [onClose]);

  const open = credential !== null;
  const secret = credential?.api_secret ?? '';
  const apiKey = credential?.api_key ?? '';
  const basicAuth = apiKey && secret ? `${apiKey}:${secret}` : '';

  return (
    <Modal
      open={open}
      onClose={handleClose}
      title="Save your API secret"
      maxWidth="max-w-lg"
      footer={
        <Button variant="primary" size="sm" onClick={handleClose}>
          I&apos;ve saved my secret
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        {/* Hard warning */}
        <div
          style={{
            display: 'flex',
            gap: 10,
            padding: '12px 14px',
            borderRadius: 10,
            background: 'rgba(245,158,11,0.10)',
            border: '1px solid rgba(245,158,11,0.28)',
          }}
        >
          <ShieldAlert size={18} style={{ color: '#f59e0b', flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: '0.82rem', color: '#fcd34d', lineHeight: 1.55 }}>
            This secret is shown <strong>only once</strong> and cannot be retrieved again. Copy it
            now and store it somewhere safe. If you lose it, revoke this key and generate a new one.
          </div>
        </div>

        {/* Key id */}
        <SecretField
          label="API Key (public)"
          value={apiKey}
          masked={false}
          copied={copiedField === 'key'}
          onCopy={() => copy(apiKey, 'key')}
        />

        {/* Secret */}
        <SecretField
          label="API Secret"
          value={secret}
          masked={!revealed}
          copied={copiedField === 'secret'}
          onCopy={() => copy(secret, 'secret')}
          onToggleReveal={() => setRevealed((r) => !r)}
        />

        {/* Ready-to-use basic auth pair */}
        <SecretField
          label="HTTP Basic (key:secret)"
          value={basicAuth}
          masked={!revealed}
          copied={copiedField === 'basic'}
          onCopy={() => copy(basicAuth, 'basic')}
          hint="Use this pair as the username:password for HTTP Basic auth."
        />
      </div>
    </Modal>
  );
}

function SecretField({
  label,
  value,
  masked,
  copied,
  onCopy,
  onToggleReveal,
  hint,
}: {
  label: string;
  value: string;
  masked: boolean;
  copied: boolean;
  onCopy: () => void;
  onToggleReveal?: () => void;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label style={{ fontSize: '0.68rem', fontWeight: 700, color: '#4a5568', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <code
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: '0.8rem',
            fontFamily: '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace',
            color: '#e2e8f0',
            background: '#0d0f15',
            border: '1px solid rgba(42,47,69,0.6)',
            borderRadius: 8,
            padding: '9px 12px',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {value ? (masked ? '•'.repeat(Math.min(44, value.length)) : value) : '—'}
        </code>
        {onToggleReveal && (
          <button
            type="button"
            onClick={onToggleReveal}
            aria-label={masked ? 'Reveal' : 'Hide'}
            title={masked ? 'Reveal' : 'Hide'}
            style={iconButtonStyle(false)}
          >
            {masked ? <Eye size={15} /> : <EyeOff size={15} />}
          </button>
        )}
        <button
          type="button"
          onClick={onCopy}
          aria-label="Copy"
          title="Copy"
          style={iconButtonStyle(copied)}
        >
          {copied ? <Check size={15} /> : <Copy size={15} />}
        </button>
      </div>
      {hint && <p style={{ fontSize: '0.72rem', color: '#4a5568', margin: 0 }}>{hint}</p>}
    </div>
  );
}

function iconButtonStyle(active: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 34,
    height: 34,
    flexShrink: 0,
    borderRadius: 8,
    border: `1px solid ${active ? 'rgba(34,197,94,0.4)' : 'rgba(59,130,246,0.20)'}`,
    background: active ? 'rgba(34,197,94,0.12)' : 'rgba(59,130,246,0.06)',
    color: active ? '#22c55e' : '#94a3b8',
    cursor: 'pointer',
    transition: 'background 0.15s, border-color 0.15s, color 0.15s',
  };
}

/* ── Revoke confirm modal ────────────────────────────────────────────────── */

function RevokeConfirmModal({
  cred,
  onClose,
  onConfirm,
  isRevoking,
}: {
  cred: ApiCredential | null;
  onClose: () => void;
  onConfirm: (id: number) => void;
  isRevoking: boolean;
}) {
  const open = cred !== null;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Revoke API key?"
      maxWidth="max-w-md"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={isRevoking}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            icon={<Trash2 size={14} />}
            loading={isRevoking}
            onClick={() => cred && onConfirm(cred.id)}
          >
            Revoke key
          </Button>
        </>
      }
    >
      <p style={{ fontSize: '0.85rem', color: '#94a3b8', lineHeight: 1.6, margin: 0 }}>
        Revoking{' '}
        <code style={{ color: '#e2e8f0', fontFamily: '"IBM Plex Mono", ui-monospace, monospace' }}>
          {cred ? maskKey(cred.api_key) : ''}
        </code>
        {cred?.label ? <span style={{ color: '#64748b' }}> ({cred.label})</span> : null}{' '}
        immediately disables it. Any application using this key will stop authenticating. This
        cannot be undone.
      </p>
    </Modal>
  );
}
