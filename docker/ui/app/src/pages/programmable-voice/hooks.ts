/**
 * Data + logic layer for the Programmable Voice glass page.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md): the page does
 * composition + top-level state only; ALL data fetching, mutations, and derived
 * state live here. Presentational components stay dumb.
 *
 * React #310: every hook below is called unconditionally at the top of its hook
 * function — no early returns precede a hook.
 */

import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  listApiDids,
  createApiDid,
  updateApiDid,
  deleteApiDid,
  getWebhookSecret,
  rotateWebhookSecret,
} from '../../api/apiDids';
import { ApiError } from '../../api/client';
import type { ApiDid, WebhookSecret } from '../../types/apiDid';
import { useToast } from '../../components/ui/Toast';
import { DEFAULT_SIGNATURE_HEADER } from './types';

// ── Shared helpers ───────────────────────────────────────────────────────────

export function isValidUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

export async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

// ── List + derived state + delete ────────────────────────────────────────────

export interface UseApiDidsArgs {
  customerId: number | undefined;
  search: string;
}

export interface UseApiDidsResult {
  dids: ApiDid[];
  filtered: ApiDid[];
  activeCount: number;
  isLoading: boolean;
  isError: boolean;
  deletingId: number | undefined;
  removeDid: (d: ApiDid) => void;
}

/**
 * Owns the `['api-dids', { customerId }]` query plus the derived filter/count
 * pipeline and the delete mutation (with confirm + toast).
 */
export function useApiDids({ customerId, search }: UseApiDidsArgs): UseApiDidsResult {
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

  const removeDid = useCallback(
    (d: ApiDid) => {
      if (!confirm(`Delete programmable number ${d.did}? This removes its webhook routing. This cannot be undone.`)) return;
      deleteMutation.mutate(d.id, {
        onSuccess: () => toastOk(`Number ${d.did} deleted`),
        onError: (err: Error) => toastErr(err.message),
      });
    },
    [deleteMutation, toastOk, toastErr],
  );

  return {
    dids,
    filtered,
    activeCount,
    isLoading,
    isError,
    deletingId: deleteMutation.isPending ? (deleteMutation.variables as number) : undefined,
    removeDid,
  };
}

// ── Per-card editor (voice / status-callback / enable toggle) ────────────────

export interface UseApiDidEditorResult {
  voice: string;
  callback: string;
  setVoice: (v: string) => void;
  setCallback: (v: string) => void;
  saveVoice: () => void;
  saveCallback: () => void;
  toggleEnabled: () => void;
  voiceSaving: boolean;
  callbackSaving: boolean;
  toggling: boolean;
}

/**
 * All local field state + the live PATCH mutations for one API DID card. Keeps
 * the displayed fields in sync with the server record (when not mid-edit) via
 * the render-phase prev-state pattern.
 */
export function useApiDidEditor(did: ApiDid): UseApiDidEditorResult {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [voice, setVoice] = useState(did.voice_url);
  const [callback, setCallback] = useState(did.status_callback ?? '');

  // Re-sync when the server record changes (and not mid-edit).
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

  const saveVoice = useCallback(() => {
    const v = voice.trim();
    if (!v) { toastErr('Voice URL cannot be empty'); return; }
    if (!isValidUrl(v)) { toastErr('Enter a valid http(s) URL'); return; }
    voiceMutation.mutate(v);
  }, [voice, voiceMutation, toastErr]);

  const saveCallback = useCallback(() => {
    const v = callback.trim();
    if (v && !isValidUrl(v)) { toastErr('Enter a valid http(s) URL'); return; }
    callbackMutation.mutate(v);
  }, [callback, callbackMutation, toastErr]);

  const toggleEnabled = useCallback(() => {
    toggleMutation.mutate(!did.enabled);
  }, [toggleMutation, did.enabled]);

  return {
    voice,
    callback,
    setVoice,
    setCallback,
    saveVoice,
    saveCallback,
    toggleEnabled,
    voiceSaving: voiceMutation.isPending,
    callbackSaving: callbackMutation.isPending,
    toggling: toggleMutation.isPending,
  };
}

// ── Webhook signing-secret panel ─────────────────────────────────────────────

export interface UseWebhookSecretResult {
  secret: WebhookSecret | null;
  revealed: boolean;
  loading: boolean;
  rotating: boolean;
  copied: boolean;
  errMsg: string | null;
  headerName: string;
  reveal: () => void;
  rotate: () => void;
  copy: () => void;
  toggleReveal: () => void;
}

export function useWebhookSecret(customerId: number | undefined): UseWebhookSecretResult {
  const { toastOk, toastErr } = useToast();
  const [secret, setSecret] = useState<WebhookSecret | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [errMsg, setErrMsg] = useState<string | null>(null);

  const reveal = useCallback(async () => {
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
  }, [customerId]);

  const rotate = useCallback(async () => {
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
  }, [customerId, toastOk, toastErr]);

  const copy = useCallback(async () => {
    if (!secret) return;
    const ok = await copyText(secret.webhook_signing_secret);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } else {
      toastErr('Clipboard unavailable');
    }
  }, [secret, toastErr]);

  const toggleReveal = useCallback(() => setRevealed((v) => !v), []);

  return {
    secret,
    revealed,
    loading,
    rotating,
    copied,
    errMsg,
    headerName: secret?.signature_header ?? DEFAULT_SIGNATURE_HEADER,
    reveal: () => void reveal(),
    rotate: () => void rotate(),
    copy: () => void copy(),
    toggleReveal,
  };
}

// ── Create-number modal ──────────────────────────────────────────────────────

export interface UseCreateApiDidResult {
  did: string;
  voiceUrl: string;
  callback: string;
  setDid: (v: string) => void;
  setVoiceUrl: (v: string) => void;
  setCallback: (v: string) => void;
  submit: () => void;
  isPending: boolean;
}

export function useCreateApiDid(customerId: number, onClose: () => void): UseCreateApiDidResult {
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

  const submit = useCallback(() => {
    if (!did.trim()) { toastErr('DID is required'); return; }
    if (!voiceUrl.trim()) { toastErr('Voice URL is required'); return; }
    if (!isValidUrl(voiceUrl.trim())) { toastErr('Voice URL must be a valid http(s) URL'); return; }
    if (callback.trim() && !isValidUrl(callback.trim())) { toastErr('Status callback must be a valid http(s) URL'); return; }
    mutation.mutate();
  }, [did, voiceUrl, callback, mutation, toastErr]);

  return {
    did,
    voiceUrl,
    callback,
    setDid,
    setVoiceUrl,
    setCallback,
    submit,
    isPending: mutation.isPending,
  };
}
