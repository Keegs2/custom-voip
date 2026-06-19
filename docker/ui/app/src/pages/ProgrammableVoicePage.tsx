import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Webhook, KeyRound, Eye, EyeOff, RotateCw, Copy, Check, BookOpen, Phone } from 'lucide-react';
import {
  listProgrammableDids,
  updateProgrammableDid,
  getWebhookSecret,
  rotateWebhookSecret,
} from '../api/programmableVoice';
import type { ProgrammableDid, WebhookSecret } from '../types/programmableVoice';
import { ApiError } from '../api/client';
import { useAuth } from '../contexts/AuthContext';
import { PageHeader } from '../components/layout/PageHeader';
import { CenteredSpinner } from '../components/ui/Spinner';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { useToast } from '../components/ui/ToastContext';
import { fmt } from '../utils/format';

const inputCls =
  'text-sm px-3 py-2 rounded-lg h-9 w-full border border-[#2a2f45] bg-[#1e2130] text-[#e2e8f0] outline-none focus:border-[#3b82f6] placeholder:text-[#4a5568]';

/* ─── Per-DID editor card ────────────────────────────────── */

interface DidEditorProps {
  did: ProgrammableDid;
  onSaved: () => void;
}

function DidEditor({ did, onSaved }: DidEditorProps) {
  // Hooks above any early return (React #310).
  const { toastOk, toastErr } = useToast();
  const [voiceUrl, setVoiceUrl] = useState(did.voice_url ?? '');
  const [fallbackUrl, setFallbackUrl] = useState(did.fallback_url ?? '');
  const [enabled, setEnabled] = useState(did.enabled);
  const [saving, setSaving] = useState(false);

  const dirty =
    voiceUrl !== (did.voice_url ?? '') ||
    fallbackUrl !== (did.fallback_url ?? '') ||
    enabled !== did.enabled;

  const save = async () => {
    setSaving(true);
    try {
      await updateProgrammableDid(did.id, {
        voice_url: voiceUrl.trim(),
        fallback_url: fallbackUrl.trim() || null,
        enabled,
      });
      toastOk(`Updated ${fmt(did.did)}`);
      onSaved();
    } catch (err) {
      toastErr(err instanceof ApiError ? err.message : 'Failed to save DID');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-2.5 mb-4">
        <div
          className="flex items-center justify-center rounded-[9px] shrink-0"
          style={{ width: 32, height: 32, color: '#c084fc', background: 'rgba(192,132,252,0.12)', border: '1px solid rgba(192,132,252,0.25)' }}
        >
          <Phone size={15} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-bold text-[#e2e8f0] font-mono">{fmt(did.did)}</div>
          {did.customer_name && <div className="text-xs text-[#475569]">{did.customer_name}</div>}
        </div>
        <button
          type="button"
          onClick={() => setEnabled((v) => !v)}
          className="flex items-center gap-2 select-none"
          title={enabled ? 'Enabled' : 'Disabled'}
        >
          <span
            className="relative inline-block rounded-full transition-colors"
            style={{ width: 30, height: 17, background: enabled ? '#3b82f6' : 'rgba(255,255,255,0.12)' }}
          >
            <span
              className="absolute rounded-full bg-white transition-all"
              style={{ width: 13, height: 13, top: 2, left: enabled ? 15 : 2 }}
            />
          </span>
          <span className="text-xs font-semibold" style={{ color: enabled ? '#93c5fd' : '#64748b' }}>
            {enabled ? 'Enabled' : 'Disabled'}
          </span>
        </button>
      </div>

      <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))' }}>
        <div className="flex flex-col gap-1.5">
          <label className="text-[0.68rem] font-bold text-[#4a5568] uppercase tracking-[0.8px]">Voice URL</label>
          <input
            className={inputCls}
            value={voiceUrl}
            onChange={(e) => setVoiceUrl(e.target.value)}
            placeholder="https://example.com/voice"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label className="text-[0.68rem] font-bold text-[#4a5568] uppercase tracking-[0.8px]">Fallback URL</label>
          <input
            className={inputCls}
            value={fallbackUrl}
            onChange={(e) => setFallbackUrl(e.target.value)}
            placeholder="https://example.com/voice-fallback (optional)"
          />
        </div>
      </div>

      <div className="flex justify-end mt-4">
        <Button size="sm" loading={saving} disabled={!dirty || !voiceUrl.trim()} onClick={() => void save()}>
          Save changes
        </Button>
      </div>
    </Card>
  );
}

/* ─── Webhook signing-secret panel ───────────────────────── */

function WebhookSecretPanel({ customerId }: { customerId: number | null }) {
  // Hooks above any early return (React #310).
  const { toastOk, toastErr } = useToast();
  const [secret, setSecret] = useState<WebhookSecret | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const reveal = async () => {
    if (customerId === null) return;
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
    if (customerId === null) return;
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
    try {
      await navigator.clipboard.writeText(secret.webhook_signing_secret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toastErr('Clipboard unavailable');
    }
  };

  const headerName = secret?.signature_header ?? 'X-Revup-Signature';

  return (
    <Card>
      <div className="flex items-center gap-2.5 mb-1">
        <KeyRound size={16} className="text-[#fbbf24]" />
        <span className="text-[0.95rem] font-bold text-[#e2e8f0] tracking-tight">Webhook Signing Secret</span>
      </div>
      <p className="text-sm text-[#718096] mb-4 leading-relaxed">
        Every programmable-voice callback is signed with an HMAC over the request body, sent in the{' '}
        <code className="font-mono text-[#cbd5e1]">{headerName}</code> header. Verify it on your endpoint
        to prove the request came from us.
      </p>

      {customerId === null ? (
        <div className="text-sm text-[#94a3b8] px-3 py-2.5 rounded-lg" style={{ background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(42,47,69,0.6)' }}>
          The signing secret is managed per customer. Open a specific customer to view or rotate their secret.
        </div>
      ) : (
        <>
          {/* Secret value */}
          <div
            className="flex items-center gap-2 px-3 py-2.5 rounded-lg mb-3"
            style={{ background: 'rgba(13,15,21,0.7)', border: '1px solid rgba(42,47,69,0.7)' }}
          >
            <code className="flex-1 font-mono text-sm text-[#e2e8f0] truncate">
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
                  className="text-[#64748b] hover:text-[#e2e8f0] transition-colors"
                >
                  {revealed ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
                <button
                  type="button"
                  onClick={() => void copy()}
                  title="Copy"
                  className="text-[#64748b] hover:text-[#e2e8f0] transition-colors"
                >
                  {copied ? <Check size={15} className="text-[#22c55e]" /> : <Copy size={15} />}
                </button>
              </>
            )}
          </div>

          {errMsg && (
            <div className="text-xs text-[#f87171] mb-3 px-3 py-2 rounded-md" style={{ background: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)' }}>
              {errMsg}
            </div>
          )}

          <div className="flex items-center gap-2 flex-wrap">
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
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#60a5fa] hover:text-[#93c5fd] ml-auto"
            >
              <BookOpen size={13} />
              Signature verification recipe
            </Link>
          </div>
        </>
      )}
    </Card>
  );
}

/* ─── Page ───────────────────────────────────────────────── */

export function ProgrammableVoicePage() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const customerId = user?.customer_id ?? null;

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['programmable-dids'],
    queryFn: () => listProgrammableDids({ limit: 200 }),
  });

  const dids = useMemo(() => data?.items ?? [], [data]);
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['programmable-dids'] });

  return (
    <>
      <PageHeader
        title="Programmable Voice"
        subtitle="Configure per-DID webhook routing and manage the signing secret used to verify callbacks."
      />

      {/* Signing secret first — applies to all DIDs */}
      <div className="mb-6">
        <WebhookSecretPanel customerId={customerId} />
      </div>

      <div className="flex items-center gap-2 mb-3">
        <Webhook size={16} className="text-[#c084fc]" />
        <h2 className="text-sm font-bold text-[#e2e8f0]">DID webhook routing</h2>
      </div>

      {isLoading ? (
        <CenteredSpinner label="Loading DIDs…" />
      ) : isError ? (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.08] text-red-300 text-sm px-4 py-3">
          {error instanceof Error ? error.message : 'Failed to load programmable DIDs.'}
        </div>
      ) : dids.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 py-16 text-[#475569]">
          <Phone size={34} strokeWidth={1.5} />
          <div className="text-sm">No programmable DIDs provisioned yet.</div>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {dids.map((did) => (
            <DidEditor key={did.id} did={did} onSaved={invalidate} />
          ))}
        </div>
      )}
    </>
  );
}
