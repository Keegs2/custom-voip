/**
 * Data + logic layer for the Carriers admin feature.
 *
 * Per the refactor convention (docs/FRONTEND_GLASS_REFACTOR.md): the page does
 * composition + top-level state only; ALL data fetching, mutations, and derived
 * per-item editor logic live here as hooks. Presentational components stay dumb.
 *
 * React #310: every hook below is called unconditionally at the top of its hook
 * function — no early returns precede a hook.
 */

import { useCallback, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  listCarriers,
  createCarrier,
  updateCarrier,
  deleteCarrier,
  testCarrier,
} from '../../../api/carriers';
import { useToast } from '../../../components/ui/Toast';
import type {
  Carrier,
  CarrierCreate,
  CarrierTestResult,
} from '../../../types/carrier';
import {
  PRODUCT_TYPE_OPTIONS,
  type CarrierFormState,
  type ProductType,
} from './types';

// ── Page-level carriers list + create + test-all ─────────────────────────────

export interface UseCarriersAdminResult {
  carriers: Carrier[];
  isLoading: boolean;
  isError: boolean;
  testingAll: boolean;
  createPending: boolean;
  create: (data: CarrierCreate) => Promise<Carrier>;
  testAll: () => void;
}

/**
 * Owns the `['carriers']` list query, the create mutation, and the bulk
 * "test all enabled carriers" routine. `onCreated` fires after a successful
 * create so the page can close its modal.
 */
export function useCarriersAdmin(onCreated: () => void): UseCarriersAdminResult {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();
  const [testingAll, setTestingAll] = useState(false);

  const { data: carriers, isLoading, isError } = useQuery({
    queryKey: ['carriers'],
    queryFn: listCarriers,
  });

  const createMutation = useMutation({
    mutationFn: (data: CarrierCreate) => createCarrier(data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      onCreated();
      toastOk('Carrier created');
    },
    onError: (err: Error) => toastErr(`Create failed: ${err.message}`),
  });

  const testAll = useCallback(async () => {
    const enabled = (carriers ?? []).filter((c) => c.enabled);
    if (enabled.length === 0) {
      toastErr('No enabled carriers to test');
      return;
    }
    setTestingAll(true);
    try {
      await Promise.allSettled(enabled.map((c) => testCarrier(c.id)));
      toastOk(`Tested ${enabled.length} carrier${enabled.length === 1 ? '' : 's'}`);
    } finally {
      setTestingAll(false);
    }
  }, [carriers, toastOk, toastErr]);

  return {
    carriers: carriers ?? [],
    isLoading,
    isError,
    testingAll,
    createPending: createMutation.isPending,
    create: (data) => createMutation.mutateAsync(data),
    testAll: () => void testAll(),
  };
}

// ── Per-card: update / delete / toggle / connectivity test ───────────────────

export interface UseCarrierCardResult {
  isEditing: boolean;
  testResult: CarrierTestResult | null;
  testing: boolean;
  deletePending: boolean;
  beginEdit: () => void;
  cancelEdit: () => void;
  save: (data: Partial<CarrierCreate>) => Promise<void>;
  toggleEnabled: () => void;
  test: () => void;
  remove: () => void;
}

export function useCarrierCard(carrier: Carrier): UseCarrierCardResult {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [isEditing, setIsEditing] = useState(false);
  const [testResult, setTestResult] = useState<CarrierTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  const updateMutation = useMutation({
    mutationFn: (data: Partial<CarrierCreate>) => updateCarrier(carrier.id, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      setIsEditing(false);
      toastOk('Carrier updated');
    },
    onError: (err: Error) => toastErr(`Save failed: ${err.message}`),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteCarrier(carrier.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      toastOk('Carrier deleted');
    },
    onError: (err: Error) => toastErr(`Delete failed: ${err.message}`),
  });

  const toggleEnabled = useCallback(async () => {
    try {
      await updateCarrier(carrier.id, { enabled: !carrier.enabled });
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      toastOk(carrier.enabled ? 'Carrier disabled' : 'Carrier enabled');
    } catch (err) {
      toastErr(`Update failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [carrier.id, carrier.enabled, qc, toastOk, toastErr]);

  const test = useCallback(async () => {
    setTesting(true);
    try {
      setTestResult(await testCarrier(carrier.id));
    } catch (err) {
      setTestResult({
        carrier_id: carrier.id,
        gateway_name: carrier.gateway_name,
        reachable: false,
        latency_ms: null,
        error: err instanceof Error ? err.message : 'Unknown error',
        tested_at: new Date().toISOString(),
      });
    } finally {
      setTesting(false);
    }
  }, [carrier.id, carrier.gateway_name]);

  const remove = useCallback(() => {
    const name = carrier.display_name || carrier.gateway_name;
    if (!window.confirm(`Delete carrier "${name}"? This cannot be undone.`)) return;
    deleteMutation.mutate();
  }, [carrier.display_name, carrier.gateway_name, deleteMutation]);

  return {
    isEditing,
    testResult,
    testing,
    deletePending: deleteMutation.isPending,
    beginEdit: () => setIsEditing(true),
    cancelEdit: () => setIsEditing(false),
    save: async (data) => { await updateMutation.mutateAsync(data); },
    toggleEnabled: () => void toggleEnabled(),
    test: () => void test(),
    remove,
  };
}

// ── Carrier create/edit form state ───────────────────────────────────────────

function generateGatewayName(displayName: string): string {
  return displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function initialForm(carrier?: Carrier): CarrierFormState {
  return {
    displayName: carrier?.display_name ?? '',
    description: carrier?.description ?? '',
    sipProxy: carrier?.sip_proxy ?? '',
    port: String(carrier?.port ?? 5060),
    transport: carrier?.transport ?? 'UDP',
    authType: carrier?.auth_type ?? 'ip',
    username: carrier?.username ?? '',
    password: '',
    codecPrefs: Array.isArray(carrier?.codec_prefs) ? carrier.codec_prefs.join(',') : 'PCMU,PCMA',
    maxChannels: carrier?.max_channels != null ? String(carrier.max_channels) : '',
    cpsLimit: carrier?.cps_limit != null ? String(carrier.cps_limit) : '',
    productTypes: (carrier?.product_types ?? []).filter((p): p is ProductType =>
      (PRODUCT_TYPE_OPTIONS as readonly string[]).includes(p),
    ),
    isPrimary: carrier?.is_primary ?? false,
    isFailover: carrier?.is_failover ?? false,
    register: carrier?.register ?? false,
    callerIdInFrom: carrier?.caller_id_in_from ?? false,
    enabled: carrier?.enabled !== false,
  };
}

export interface UseCarrierFormResult {
  form: CarrierFormState;
  setField: <K extends keyof CarrierFormState>(key: K, value: CarrierFormState[K]) => void;
  toggleProductType: (pt: ProductType) => void;
  error: string | null;
  submitting: boolean;
  submit: () => void;
}

/**
 * Owns all carrier-form field state + validation + the build-and-submit pipeline.
 * `onSubmit` receives the assembled `CarrierCreate` payload (used for both the
 * create modal and the per-card inline editor).
 */
export function useCarrierForm(
  carrier: Carrier | undefined,
  onSubmit: (values: CarrierCreate) => Promise<void>,
): UseCarrierFormResult {
  const [form, setForm] = useState<CarrierFormState>(() => initialForm(carrier));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setField = useCallback(
    <K extends keyof CarrierFormState>(key: K, value: CarrierFormState[K]) => {
      setForm((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const toggleProductType = useCallback((pt: ProductType) => {
    setForm((prev) => ({
      ...prev,
      productTypes: prev.productTypes.includes(pt)
        ? prev.productTypes.filter((p) => p !== pt)
        : [...prev.productTypes, pt],
    }));
  }, []);

  const submit = useCallback(async () => {
    if (!form.displayName.trim()) { setError('Display name is required'); return; }
    if (!form.sipProxy.trim()) { setError('SIP proxy hostname is required'); return; }

    setError(null);
    setSubmitting(true);

    const showCredentials = form.authType === 'credentials';
    const values: CarrierCreate = {
      gateway_name: carrier?.gateway_name ?? generateGatewayName(form.displayName),
      display_name: form.displayName.trim(),
      description: form.description.trim() || null,
      sip_proxy: form.sipProxy.trim(),
      port: parseInt(form.port, 10) || 5060,
      transport: form.transport,
      auth_type: form.authType,
      username: showCredentials && form.username ? form.username : null,
      password: form.password || null,
      codec_prefs: form.codecPrefs.split(',').map((c) => c.trim()).filter(Boolean),
      max_channels: form.maxChannels ? parseInt(form.maxChannels, 10) : null,
      cps_limit: form.cpsLimit ? parseInt(form.cpsLimit, 10) : null,
      product_types: form.productTypes,
      is_primary: form.isPrimary,
      is_failover: form.isFailover,
      register: form.register,
      caller_id_in_from: form.callerIdInFrom,
      enabled: form.enabled,
    };

    try {
      await onSubmit(values);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSubmitting(false);
    }
  }, [form, carrier, onSubmit]);

  return {
    form,
    setField,
    toggleProductType,
    error,
    submitting,
    submit: () => void submit(),
  };
}
