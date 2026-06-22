import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { KeyRound, Eye, EyeOff, RotateCw, Copy, Check, BookOpen } from 'lucide-react';
import { PortalHeader } from './RcfPage';
import { AdminCustomerSelector } from '../components/AdminCustomerSelector';
import { useAuth } from '../contexts/AuthContext';
import { IconAPI } from '../components/icons/ProductIcons';
import { Button } from '../components/ui/Button';
import { Badge } from '../components/ui/Badge';
import { Modal } from '../components/ui/Modal';
import { FormField } from '../components/ui/FormField';
import { StatCard } from '../components/ui/StatCard';
import { Spinner } from '../components/ui/Spinner';
import { useToast } from '../components/ui/Toast';
import { fmt } from '../utils/format';
import { ApiError } from '../api/client';
import {
  listApiDids,
  createApiDid,
  updateApiDid,
  deleteApiDid,
  getWebhookSecret,
  rotateWebhookSecret,
} from '../api/apiDids';
import type { ApiDid, WebhookSecret } from '../types/apiDid';

const ACCENT = '#c084fc';

// ─── Helpers ────────────────────────────────────────────────────────────────

function isValidUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

// ─── Webhook signing-secret panel (account-level) ────────────────────────────
//
// The signing secret is per-customer: every programmable-voice callback is
// HMAC-signed with it. Viewing/rotating is admin-scoped server-side — a 403 is
// surfaced as a friendly "requires an administrator" message rather than failing
// loudly. When no specific customer is in context (admin who hasn't selected one
// yet) we prompt to open a customer first.

function WebhookSecretPanel({ customerId }: { customerId: number | undefined }) {
  // Hooks above any early return (React #310).
  const { toastOk, toastErr } = useToast();
  const [secret, setSecret] = useState<WebhookSecret | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const reveal = async () => {
    if (customerId === undefined) return;
    setLoading(true);
    setErrMsg(null);
    try {
      const s = await getWebhookSecret(customerId);
      setSecret(s);
      setRevealed(true);
    } catch (err) {
      setErrMsg(
        err instanceof ApiError && err.status === 403
          ? 'Viewing the signing secret requires an administrator.'
          : err instanceof ApiError ? err.message : 'Failed to load signing secret.',
      );
    } finally {
      setLoading(false);
    }
  };

  const rotate = async () => {
    if (customerId === undefined) return;
    if (!window.confirm('Rotate the signing secret? Callbacks will be signed with the NEW secret immediately — update your verifier in lockstep.')) {
      return;
    }
    setRotating(true);
    setErrMsg(null);
    try {
      const s = await rotateWebhookSecret(customerId);
      setSecret(s);
      setRevealed(true);
      toastOk('Signing secret rotated');
    } catch (err) {
      const m = err instanceof ApiError && err.status === 403
        ? 'Rotating the signing secret requires an administrator.'
        : err instanceof ApiError ? err.message : 'Failed to rotate signing secret.';
      setErrMsg(m);
      toastErr(m);
    } finally {
      setRotating(false);
    }
  };

  const copy = async () => {
    if (!secret) return;
    const ok = await copyText(secret.webhook_signing_secret);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toastErr('Clipboard unavailable');
    }
  };

  const headerName = secret?.signature_header ?? 'X-Revup-Signature';

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        padding: 24,
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        marginBottom: 20,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 6 }}>
        <KeyRound size={16} style={{ color: '#fbbf24', flexShrink: 0 }} />
        <span style={{ fontSize: '0.95rem', fontWeight: 700, color: '#e2e8f0', letterSpacing: '-0.01em' }}>
          Webhook Signing Secret
        </span>
      </div>
      <p style={{ fontSize: '0.82rem', color: '#718096', marginBottom: 16, lineHeight: 1.6 }}>
        Every programmable-voice callback is signed with an HMAC over the request body, sent in the{' '}
        <code style={{ fontFamily: 'monospace', color: '#cbd5e1' }}>{headerName}</code> header. Verify it
        on your endpoint to prove the request came from us.
      </p>

      {customerId === undefined ? (
        <div
          style={{
            fontSize: '0.82rem',
            color: '#94a3b8',
            padding: '10px 14px',
            borderRadius: 10,
            background: 'rgba(255,255,255,0.03)',
            border: '1px solid rgba(42,47,69,0.6)',
          }}
        >
          The signing secret is managed per customer. Open a specific customer above to view or rotate their secret.
        </div>
      ) : (
        <>
          {/* Secret value */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 14px',
              borderRadius: 10,
              marginBottom: 12,
              background: 'rgba(13,15,21,0.7)',
              border: '1px solid rgba(42,47,69,0.7)',
            }}
          >
            <code
              style={{
                flex: 1,
                fontFamily: 'monospace',
                fontSize: '0.85rem',
                color: '#e2e8f0',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {secret && revealed
                ? secret.webhook_signing_secret
                : secret
                  ? '•'.repeat(Math.min(40, secret.webhook_signing_secret.length))
                  : '— not loaded —'}
            </code>
            {secret && (
              <>
                <button
                  type="button"
                  onClick={() => setRevealed((v) => !v)}
                  title={revealed ? 'Hide' : 'Reveal'}
                  style={{ background: 'transparent', border: 'none', color: '#64748b', cursor: 'pointer', display: 'flex' }}
                >
                  {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
                <button
                  type="button"
                  onClick={() => void copy()}
                  title="Copy"
                  style={{ background: 'transparent', border: 'none', color: copied ? '#22c55e' : '#64748b', cursor: 'pointer', display: 'flex' }}
                >
                  {copied ? <Check size={15} /> : <Copy size={15} />}
                </button>
              </>
            )}
          </div>

          {errMsg && (
            <div
              style={{
                fontSize: '0.75rem',
                color: '#f87171',
                marginBottom: 12,
                padding: '8px 12px',
                borderRadius: 8,
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.2)',
              }}
            >
              {errMsg}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {!secret && (
              <Button size="sm" variant="ghost" icon={<Eye size={14} />} loading={loading} onClick={() => void reveal()}>
                Reveal secret
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={<RotateCw size={14} />} loading={rotating} onClick={() => void rotate()}>
              Rotate secret
            </Button>
            <Link
              to="/docs/api"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                marginLeft: 'auto',
                fontSize: '0.75rem',
                fontWeight: 600,
                color: '#60a5fa',
                textDecoration: 'none',
              }}
            >
              <BookOpen size={13} />
              Signature verification recipe
            </Link>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Editable webhook URL field (with copy + save) ───────────────────────────

function WebhookField({
  label,
  optional,
  hint,
  value,
  saved,
  onChange,
  onSave,
  saving,
  readOnly,
}: {
  label: string;
  optional?: boolean;
  hint: string;
  value: string;
  saved: string;
  onChange: (v: string) => void;
  onSave: () => void;
  saving: boolean;
  readOnly: boolean;
}) {
  const { toastOk, toastErr } = useToast();
  const dirty = value.trim() !== saved.trim();
  const invalid = value.trim().length > 0 && !isValidUrl(value.trim());

  async function handleCopy() {
    if (!saved.trim()) {
      toastErr('Nothing to copy yet');
      return;
    }
    const ok = await copyText(saved.trim());
    if (ok) toastOk(`${label} copied`);
    else toastErr('Copy failed — copy manually');
  }

  return (
    <div>
      <label
        style={{
          display: 'block',
          fontSize: '0.68rem',
          fontWeight: 700,
          color: '#718096',
          textTransform: 'uppercase',
          letterSpacing: '0.07em',
          marginBottom: 8,
        }}
      >
        {label}
        {optional && (
          <span style={{ marginLeft: 6, color: 'rgba(113,128,150,0.7)', fontWeight: 400, textTransform: 'none', letterSpacing: 'normal', fontSize: '0.66rem' }}>
            (optional)
          </span>
        )}
      </label>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="url"
          value={value}
          readOnly={readOnly}
          placeholder="https://your-app.com/voice"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !readOnly) onSave(); }}
          style={{
            flex: '1 1 220px',
            minWidth: 0,
            fontSize: '0.85rem',
            fontFamily: 'monospace',
            padding: '8px 12px',
            borderRadius: 8,
            border: `1px solid ${invalid ? 'rgba(239,68,68,0.55)' : dirty ? 'rgba(192,132,252,0.55)' : 'rgba(42,47,69,0.8)'}`,
            background: 'rgba(19,21,29,0.8)',
            color: '#e2e8f0',
            outline: 'none',
            boxShadow: dirty && !invalid ? '0 0 0 3px rgba(192,132,252,0.16)' : 'none',
          }}
        />
        <button
          type="button"
          onClick={handleCopy}
          title="Copy to clipboard"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            padding: '7px 11px',
            borderRadius: 8,
            border: '1px solid rgba(42,47,69,0.8)',
            background: 'rgba(19,21,29,0.8)',
            color: '#94a3b8',
            cursor: 'pointer',
            fontSize: '0.72rem',
            fontWeight: 600,
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} style={{ width: 13, height: 13 }}>
            <rect x="9" y="9" width="11" height="11" rx="2" />
            <path d="M5 15V5a2 2 0 0 1 2-2h10" strokeLinecap="round" />
          </svg>
          Copy
        </button>
        {!readOnly && (
          <Button variant="success" size="sm" disabled={!dirty || invalid} loading={saving} onClick={onSave}>
            Save
          </Button>
        )}
      </div>

      <p style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8, fontSize: '0.72rem', color: invalid ? '#f87171' : '#718096' }}>
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 14,
            height: 14,
            borderRadius: '50%',
            border: '1px solid rgba(113,128,150,0.5)',
            fontSize: '0.55rem',
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          i
        </span>
        {invalid ? 'Enter a valid http(s) URL' : hint}
      </p>
    </div>
  );
}

// ─── API DID card ─────────────────────────────────────────────────────────────

function ApiDidRow({
  did,
  isAdmin,
  canManage,
  showCustomer,
  onDelete,
  deleting,
}: {
  did: ApiDid;
  isAdmin: boolean;
  canManage: boolean;
  showCustomer: boolean;
  onDelete: (d: ApiDid) => void;
  deleting: boolean;
}) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [voice, setVoice] = useState(did.voice_url);
  const [callback, setCallback] = useState(did.status_callback ?? '');

  // Keep local fields in sync when the server record changes (and not mid-edit).
  const [prevVoice, setPrevVoice] = useState(did.voice_url);
  if (did.voice_url !== prevVoice) {
    setPrevVoice(did.voice_url);
    setVoice(did.voice_url);
  }
  const [prevCb, setPrevCb] = useState(did.status_callback ?? '');
  if ((did.status_callback ?? '') !== prevCb) {
    setPrevCb(did.status_callback ?? '');
    setCallback(did.status_callback ?? '');
  }

  const invalidate = () => qc.invalidateQueries({ queryKey: ['api-dids'] });

  const voiceMutation = useMutation({
    mutationFn: (v: string) => updateApiDid(did.id, { voice_url: v }),
    onSuccess: () => { void invalidate(); toastOk('Voice URL saved'); },
    onError: (err: Error) => toastErr(err.message),
  });

  const callbackMutation = useMutation({
    mutationFn: (v: string) => updateApiDid(did.id, { status_callback: v.trim() || null }),
    onSuccess: () => { void invalidate(); toastOk('Status callback saved'); },
    onError: (err: Error) => toastErr(err.message),
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) => updateApiDid(did.id, { enabled }),
    onSuccess: (_d, enabled) => { void invalidate(); toastOk(enabled ? 'Number enabled' : 'Number disabled'); },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleVoiceSave() {
    const v = voice.trim();
    if (!v) { toastErr('Voice URL cannot be empty'); return; }
    if (!isValidUrl(v)) { toastErr('Enter a valid http(s) URL'); return; }
    voiceMutation.mutate(v);
  }

  function handleCallbackSave() {
    const v = callback.trim();
    if (v && !isValidUrl(v)) { toastErr('Enter a valid http(s) URL'); return; }
    callbackMutation.mutate(v);
  }

  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.9) 0%, rgba(19,21,29,0.95) 100%)',
        border: '1px solid rgba(42,47,69,0.6)',
        borderRadius: 16,
        padding: 24,
        boxShadow: '0 4px 20px rgba(0,0,0,0.3)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 32,
          right: 32,
          height: 2,
          background: `linear-gradient(90deg, transparent, ${ACCENT}80, transparent)`,
          opacity: 0.35,
        }}
      />

      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, marginBottom: 20 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#e2e8f0', letterSpacing: '-0.01em' }}>
            {fmt(did.did)}
          </div>
          <div style={{ fontSize: '0.72rem', fontFamily: 'monospace', color: '#718096', marginTop: 3 }}>
            {showCustomer && did.customer_name ? `${did.customer_name} · ` : ''}
            {did.did} · added {new Date(did.created_at).toLocaleDateString()}
          </div>
        </div>
        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Badge variant={did.enabled ? 'active' : 'disabled'}>{did.enabled ? 'Active' : 'Disabled'}</Badge>
        </div>
      </div>

      <WebhookField
        label="Voice URL"
        hint="Called with an HTTP POST when a call arrives — return TwiML to control the call."
        value={voice}
        saved={did.voice_url}
        onChange={setVoice}
        onSave={handleVoiceSave}
        saving={voiceMutation.isPending}
        readOnly={!canManage}
      />

      <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid rgba(42,47,69,0.5)' }}>
        <WebhookField
          label="Status Callback URL"
          optional
          hint="Receives call lifecycle events (initiated, ringing, answered, completed)."
          value={callback}
          saved={did.status_callback ?? ''}
          onChange={setCallback}
          onSave={handleCallbackSave}
          saving={callbackMutation.isPending}
          readOnly={!canManage}
        />
      </div>

      {canManage && (
        <div
          style={{
            marginTop: 18,
            paddingTop: 16,
            borderTop: '1px solid rgba(42,47,69,0.5)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            disabled={toggleMutation.isPending}
            onClick={() => toggleMutation.mutate(!did.enabled)}
            style={{
              background: did.enabled ? 'rgba(239,68,68,0.08)' : 'rgba(34,197,94,0.08)',
              border: did.enabled ? '1px solid rgba(239,68,68,0.3)' : '1px solid rgba(34,197,94,0.3)',
              borderRadius: 7,
              padding: '6px 16px',
              fontSize: '0.78rem',
              fontWeight: 600,
              color: did.enabled ? '#f87171' : '#4ade80',
              cursor: toggleMutation.isPending ? 'wait' : 'pointer',
              opacity: toggleMutation.isPending ? 0.6 : 1,
            }}
          >
            {did.enabled ? 'Disable number' : 'Enable number'}
          </button>
          {isAdmin && (
            <Button variant="danger" size="sm" loading={deleting} onClick={() => onDelete(did)}>
              Delete
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Create API DID modal (admin) ────────────────────────────────────────────

function CreateApiDidModal({
  open,
  onClose,
  customerId,
}: {
  open: boolean;
  onClose: () => void;
  customerId: number;
}) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [did, setDid] = useState('');
  const [voiceUrl, setVoiceUrl] = useState('');
  const [callback, setCallback] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      createApiDid({
        customer_id: customerId,
        did: did.trim(),
        voice_url: voiceUrl.trim(),
        status_callback: callback.trim() || null,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['api-dids'] });
      toastOk(`Number ${did.trim()} added`);
      setDid('');
      setVoiceUrl('');
      setCallback('');
      onClose();
    },
    onError: (err: Error) => toastErr(err.message),
  });

  function handleSubmit() {
    if (!did.trim()) { toastErr('DID is required'); return; }
    if (!voiceUrl.trim()) { toastErr('Voice URL is required'); return; }
    if (!isValidUrl(voiceUrl.trim())) { toastErr('Voice URL must be a valid http(s) URL'); return; }
    if (callback.trim() && !isValidUrl(callback.trim())) { toastErr('Status callback must be a valid http(s) URL'); return; }
    mutation.mutate();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add Programmable Number"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={mutation.isPending} onClick={handleSubmit}>Add number</Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        <FormField
          label="DID (E.164)"
          required
          value={did}
          onChange={(e) => setDid(e.target.value)}
          placeholder="+1XXXXXXXXXX"
          hint="The inbound number to make programmable."
        />
        <FormField
          label="Voice URL"
          required
          type="url"
          value={voiceUrl}
          onChange={(e) => setVoiceUrl(e.target.value)}
          placeholder="https://your-app.com/voice"
          hint="POSTed when a call arrives; respond with TwiML."
        />
        <FormField
          label="Status Callback URL"
          type="url"
          value={callback}
          onChange={(e) => setCallback(e.target.value)}
          placeholder="https://your-app.com/status"
          hint="Optional — receives call lifecycle events."
        />
      </div>
    </Modal>
  );
}

// ─── Educational empty state ─────────────────────────────────────────────────

function HowItWorksStep({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div style={{ display: 'flex', gap: 14, textAlign: 'left' }}>
      <div
        style={{
          flexShrink: 0,
          width: 30,
          height: 30,
          borderRadius: 9,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'rgba(192,132,252,0.12)',
          border: '1px solid rgba(192,132,252,0.3)',
          color: ACCENT,
          fontWeight: 800,
          fontSize: '0.85rem',
        }}
      >
        {n}
      </div>
      <div>
        <div style={{ fontSize: '0.88rem', fontWeight: 700, color: '#e2e8f0', marginBottom: 2 }}>{title}</div>
        <div style={{ fontSize: '0.8rem', color: '#718096', lineHeight: 1.5 }}>{body}</div>
      </div>
    </div>
  );
}

function ApiEmptyState({ isAdmin, canCreate, onCreate }: { isAdmin: boolean; canCreate: boolean; onCreate: () => void }) {
  return (
    <div
      style={{
        background: 'linear-gradient(135deg, rgba(30,33,48,0.6) 0%, rgba(19,21,29,0.7) 100%)',
        border: '1px solid rgba(42,47,69,0.5)',
        borderRadius: 18,
        padding: '48px 32px',
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 60,
          height: 60,
          borderRadius: 16,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: 18,
          background: 'linear-gradient(135deg, rgba(192,132,252,0.15) 0%, rgba(192,132,252,0.05) 100%)',
          border: '1px solid rgba(192,132,252,0.25)',
          color: ACCENT,
        }}
      >
        <IconAPI size={30} />
      </div>

      <h2 style={{ fontSize: '1.3rem', fontWeight: 800, color: '#e2e8f0', marginBottom: 8 }}>
        Programmable voice
      </h2>
      <p style={{ fontSize: '0.9rem', color: '#94a3b8', maxWidth: 580, margin: '0 auto', lineHeight: 1.6 }}>
        Control calls in real time with simple webhooks. When a call hits one of your numbers,
        we POST the call details to your <strong style={{ color: '#e2e8f0' }}>Voice URL</strong> — you respond
        with TwiML telling us what to do next. An optional{' '}
        <strong style={{ color: '#e2e8f0' }}>Status Callback</strong> streams lifecycle events as the call progresses.
      </p>

      {/* Webhook contract */}
      <div
        style={{
          maxWidth: 620,
          margin: '28px auto',
          textAlign: 'left',
          background: 'rgba(13,15,23,0.7)',
          border: '1px solid rgba(42,47,69,0.6)',
          borderRadius: 12,
          padding: '16px 20px',
          fontFamily: 'monospace',
          fontSize: '0.78rem',
          lineHeight: 1.7,
          color: '#94a3b8',
        }}
      >
        <div style={{ color: ACCENT }}># Inbound call → your Voice URL</div>
        <div><span style={{ color: '#4ade80' }}>POST</span> https://your-app.com/voice</div>
        <div>From=+16175551234&amp;To=+16175550000&amp;CallSid=CA…</div>
        <div style={{ marginTop: 10, color: ACCENT }}># Your response (TwiML)</div>
        <div style={{ color: '#e2e8f0' }}>&lt;Response&gt;&lt;Say&gt;Hello&lt;/Say&gt;&lt;Dial&gt;+16175559999&lt;/Dial&gt;&lt;/Response&gt;</div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 22,
          maxWidth: 720,
          margin: '8px auto 28px',
          textAlign: 'left',
        }}
      >
        <HowItWorksStep n={1} title="Point your Voice URL" body="Set the webhook each number calls when a call comes in." />
        <HowItWorksStep n={2} title="Return TwiML" body="Say, play, gather digits, record, or dial — driven entirely by your app." />
        <HowItWorksStep n={3} title="Track status" body="Add a status callback to log answered/completed events in real time." />
      </div>

      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
        {isAdmin && canCreate && (
          <Button variant="primary" onClick={onCreate}>Add your first number</Button>
        )}
        <Link to="/docs/api" style={{ textDecoration: 'none' }}>
          <Button variant="ghost">API reference</Button>
        </Link>
      </div>

      <p style={{ fontSize: '0.78rem', color: '#718096', marginTop: 18 }}>
        Prefer no-code? Build call logic visually with the Call Flow Builder and publish it to any number.
      </p>
      {isAdmin && !canCreate && (
        <p style={{ fontSize: '0.78rem', color: '#718096', marginTop: 6 }}>
          Select a specific customer above to add a number for them.
        </p>
      )}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function ProgrammableVoicePage() {
  const { user, isAdmin } = useAuth();
  const canManage = (user?.role ?? 'user') !== 'readonly';

  const [adminSelectedCustomer, setAdminSelectedCustomer] = useState<number | undefined>(undefined);
  const customerId = isAdmin ? adminSelectedCustomer : (user?.customer_id ?? undefined);

  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const { data, isLoading, isError } = useQuery({
    queryKey: ['api-dids', { customerId }],
    queryFn: () => listApiDids({ customer_id: customerId, limit: 200 }),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => deleteApiDid(id),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ['api-dids'] }); },
  });

  const dids = useMemo(() => data?.items ?? [], [data]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return dids;
    return dids.filter(
      (d) =>
        d.did.toLowerCase().includes(q) ||
        d.voice_url.toLowerCase().includes(q) ||
        (d.customer_name ?? '').toLowerCase().includes(q),
    );
  }, [dids, search]);

  const activeCount = useMemo(() => dids.filter((d) => d.enabled).length, [dids]);

  function handleDelete(d: ApiDid) {
    if (!confirm(`Delete programmable number ${d.did}? This removes its webhook routing. This cannot be undone.`)) return;
    deleteMutation.mutate(d.id, {
      onSuccess: () => toastOk(`Number ${d.did} deleted`),
      onError: (err: Error) => toastErr(err.message),
    });
  }

  function handleCustomerSelect(id: number | undefined) {
    setAdminSelectedCustomer(id);
    setSearch('');
  }

  const adminCanCreate = isAdmin && customerId !== undefined;

  return (
    <div style={{ paddingTop: 20 }}>
      <PortalHeader
        icon={<IconAPI size={24} />}
        title={user?.customer_name ? `${user.customer_name}'s Programmable Voice` : 'Programmable Voice'}
        subtitle="Program your numbers with webhooks — inbound calls POST to your Voice URL and you return TwiML, with real-time status callbacks and a signing secret to verify every request."
        badgeVariant="api"
      />

      <AdminCustomerSelector
        selectedCustomerId={adminSelectedCustomer}
        onSelect={handleCustomerSelect}
        accent={ACCENT}
        accountTypes={['api', 'hybrid']}
      />

      {/* Signing secret first — applies account-wide to all of this customer's numbers. */}
      <WebhookSecretPanel customerId={customerId} />

      {isLoading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, color: '#718096', fontSize: '0.875rem', padding: '48px 0', justifyContent: 'center' }}>
          <Spinner size="sm" /> Loading your numbers…
        </div>
      )}

      {isError && (
        <div style={{ padding: '16px 20px', borderRadius: 12, background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.22)', color: '#f87171', fontSize: '0.875rem' }}>
          Unable to load API numbers. Please try refreshing the page.
        </div>
      )}

      {!isLoading && !isError && dids.length === 0 && (
        <ApiEmptyState isAdmin={isAdmin} canCreate={adminCanCreate} onCreate={() => setCreateOpen(true)} />
      )}

      {!isLoading && !isError && dids.length > 0 && (
        <>
          <div className="grid grid-cols-3 gap-3" style={{ marginBottom: 20 }}>
            <StatCard label="Total Numbers" icon="☎️" value={dids.length} />
            <StatCard label="Active" icon="✅" value={activeCount} />
            <StatCard label="Disabled" icon="⏸️" value={dids.length - activeCount} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by number, customer, or webhook URL…"
              style={{
                flex: '1 1 240px',
                minWidth: 200,
                boxSizing: 'border-box',
                padding: '9px 14px',
                fontSize: '0.83rem',
                background: 'rgba(19,21,29,0.7)',
                border: '1px solid rgba(192,132,252,0.14)',
                borderRadius: 11,
                color: '#e2e8f0',
                outline: 'none',
              }}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'rgba(192,132,252,0.45)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'rgba(192,132,252,0.14)'; }}
            />
            {isAdmin && (
              <Button
                variant="primary"
                onClick={() => {
                  if (!adminCanCreate) { toastErr('Select a specific customer above to add a number'); return; }
                  setCreateOpen(true);
                }}
              >
                + Add number
              </Button>
            )}
          </div>

          {filtered.length === 0 ? (
            <p style={{ fontSize: '0.85rem', color: '#718096', textAlign: 'center', padding: '32px 0' }}>
              No numbers match “{search}”.
            </p>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
              {filtered.map((d) => (
                <ApiDidRow
                  key={d.id}
                  did={d}
                  isAdmin={isAdmin}
                  canManage={canManage}
                  showCustomer={isAdmin}
                  onDelete={handleDelete}
                  deleting={deleteMutation.isPending && deleteMutation.variables === d.id}
                />
              ))}
            </div>
          )}
        </>
      )}

      {adminCanCreate && customerId !== undefined && (
        <CreateApiDidModal open={createOpen} onClose={() => setCreateOpen(false)} customerId={customerId} />
      )}
    </div>
  );
}
