/**
 * CarrierCard — one carrier gateway: identity, connection facts, live
 * connectivity test, edit/enable/delete actions.
 *
 * Styling: the shared DAYLIGHT CONSOLE system (`dl-*` in index.css, plus the
 * admin `dlx-*` layer in styles/dl-admin.css). Renders as a dl-panel inside
 * the CarriersTab card grid — the PlatformManagementPage shell owns the
 * canvas.
 *
 * React #310: every hook is called unconditionally at the top.
 */
import { useState, useCallback } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  updateCarrier,
  deleteCarrier,
  testCarrier,
} from '../../api/carriers';
import { useToast } from '../../components/ui/Toast';
import { CarrierForm } from './CarrierForm';
import type { Carrier, CarrierCreate, CarrierTestResult } from '../../types/carrier';
import '../../styles/dl-admin.css';

interface CarrierCardProps {
  carrier: Carrier;
}

function authLabel(authType: string): string {
  if (authType === 'credentials') return 'Credentials';
  if (authType === 'none') return 'None';
  return 'IP-based';
}

const MONO_FONT = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

export function CarrierCard({ carrier: initialCarrier }: CarrierCardProps) {
  const qc = useQueryClient();
  const { toastOk, toastErr } = useToast();

  const [isEditing, setIsEditing] = useState(false);
  const [testResult, setTestResult] = useState<CarrierTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  // ----------------------------------------------------------------
  // Update mutation
  // ----------------------------------------------------------------
  const updateMutation = useMutation({
    mutationFn: (data: Partial<CarrierCreate>) =>
      updateCarrier(initialCarrier.id, data),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      setIsEditing(false);
      toastOk('Carrier updated');
    },
    onError: (err: Error) => {
      toastErr(`Save failed: ${err.message}`);
    },
  });

  // ----------------------------------------------------------------
  // Delete mutation
  // ----------------------------------------------------------------
  const deleteMutation = useMutation({
    mutationFn: () => deleteCarrier(initialCarrier.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      toastOk('Carrier deleted');
    },
    onError: (err: Error) => {
      toastErr(`Delete failed: ${err.message}`);
    },
  });

  // ----------------------------------------------------------------
  // Enable / disable toggle
  // ----------------------------------------------------------------
  const toggleEnabled = useCallback(async () => {
    try {
      await updateCarrier(initialCarrier.id, { enabled: !initialCarrier.enabled });
      void qc.invalidateQueries({ queryKey: ['carriers'] });
      toastOk(initialCarrier.enabled ? 'Carrier disabled' : 'Carrier enabled');
    } catch (err) {
      toastErr(`Update failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }, [initialCarrier.id, initialCarrier.enabled, qc, toastOk, toastErr]);

  // ----------------------------------------------------------------
  // Test connection
  // ----------------------------------------------------------------
  const handleTest = useCallback(async () => {
    setTesting(true);
    try {
      const result = await testCarrier(initialCarrier.id);
      setTestResult(result);
    } catch (err) {
      setTestResult({
        carrier_id: initialCarrier.id,
        gateway_name: initialCarrier.gateway_name,
        reachable: false,
        latency_ms: null,
        error: err instanceof Error ? err.message : 'Unknown error',
        tested_at: new Date().toISOString(),
      });
    } finally {
      setTesting(false);
    }
  }, [initialCarrier.id, initialCarrier.gateway_name]);

  // ----------------------------------------------------------------
  // Delete confirmation
  // ----------------------------------------------------------------
  const handleDelete = useCallback(() => {
    const name = initialCarrier.display_name || initialCarrier.gateway_name;
    if (!window.confirm(`Delete carrier "${name}"? This cannot be undone.`)) return;
    deleteMutation.mutate();
  }, [initialCarrier.display_name, initialCarrier.gateway_name, deleteMutation]);

  // ----------------------------------------------------------------
  // Connection details block
  // ----------------------------------------------------------------
  const codecsDisplay = Array.isArray(initialCarrier.codec_prefs)
    ? initialCarrier.codec_prefs.join(', ')
    : String(initialCarrier.codec_prefs ?? 'PCMU,PCMA');

  const connLines: Array<[string, React.ReactNode]> = [
    [
      'SIP Proxy',
      <span style={{ fontFamily: MONO_FONT, fontSize: '0.78rem' }}>
        {initialCarrier.sip_proxy}:{initialCarrier.port}
      </span>,
    ],
    [
      'Transport',
      <span className="dl-tag dl-tag-slate">{(initialCarrier.transport ?? 'UDP').toUpperCase()}</span>,
    ],
    [
      'Auth',
      <span className="dl-tag dl-tag-slate">{authLabel(initialCarrier.auth_type)}</span>,
    ],
    ['Codecs', codecsDisplay],
    ['Registration', initialCarrier.register ? 'Yes' : 'No'],
  ];

  if (
    (initialCarrier.auth_type === 'credentials') &&
    initialCarrier.username
  ) {
    connLines.push(['Username', initialCarrier.username]);
    connLines.push(['Password', '••••••••']);
  }
  if (initialCarrier.max_channels != null) {
    connLines.push(['Max Channels', String(initialCarrier.max_channels)]);
  }
  if (initialCarrier.cps_limit != null) {
    connLines.push(['CPS Limit', String(initialCarrier.cps_limit)]);
  }

  return (
    <section className="dl-panel">
      {/* ── Header — identity + status/role tags ── */}
      <div style={{ padding: '16px 20px 14px', borderBottom: '1px solid var(--rcf-line)' }}>
        <div
          style={{
            fontFamily: '"Archivo", "IBM Plex Sans", sans-serif',
            fontSize: '0.95rem',
            fontWeight: 700,
            letterSpacing: '-0.01em',
            color: 'var(--rcf-ink)',
          }}
        >
          {initialCarrier.display_name || initialCarrier.gateway_name}
        </div>
        <div
          style={{
            fontFamily: MONO_FONT,
            fontSize: '0.72rem',
            color: 'var(--rcf-ink-dim)',
            marginTop: 3,
          }}
        >
          {initialCarrier.gateway_name}
        </div>

        {/* Status pill + role/product tags */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, marginTop: 12 }}>
          <span className={initialCarrier.enabled ? 'dl-pill dl-pill-on' : 'dl-pill dl-pill-off'}>
            {initialCarrier.enabled ? 'Enabled' : 'Disabled'}
          </span>
          {initialCarrier.is_primary && <span className="dl-tag">Primary</span>}
          {initialCarrier.is_failover && <span className="dl-tag dl-tag-slate">Failover</span>}
          {(initialCarrier.product_types ?? []).map((pt) => (
            <span key={pt} className="dl-tag dl-tag-slate">{pt}</span>
          ))}
        </div>
      </div>

      <div className="dl-panel-body">
        {/* Connection details */}
        {!isEditing && (
          <div className="dl-kvbox" style={{ marginBottom: 16 }}>
            {connLines.map(([key, val]) => (
              <div key={key} className="dl-kv">
                <span className="dl-kv-label">{key}</span>
                <span className="dl-kv-value">{val}</span>
              </div>
            ))}
          </div>
        )}

        {/* Edit form */}
        {isEditing && (
          <CarrierForm
            carrier={initialCarrier}
            submitLabel="Save Changes"
            onCancel={() => setIsEditing(false)}
            onSubmit={async (values) => {
              await updateMutation.mutateAsync(values);
            }}
          />
        )}

        {/* Actions bar */}
        {!isEditing && (
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
            <button
              type="button"
              className="dl-btn dl-btn-ghost dlx-btn-sm"
              onClick={() => void handleTest()}
              disabled={testing}
            >
              {testing ? 'Testing…' : 'Test Connection'}
            </button>

            <span style={{ flex: 1 }} />

            <button
              type="button"
              className="dl-btn dl-btn-ghost dlx-btn-sm"
              onClick={() => setIsEditing(true)}
            >
              Edit
            </button>
            <button
              type="button"
              className={
                initialCarrier.enabled
                  ? 'dl-btn dl-btn-ghost dlx-btn-sm'
                  : 'dl-btn dlx-btn-ok dlx-btn-sm'
              }
              onClick={() => void toggleEnabled()}
            >
              {initialCarrier.enabled ? 'Disable' : 'Enable'}
            </button>
            <button
              type="button"
              className="dl-btn dl-btn-danger dlx-btn-sm"
              onClick={handleDelete}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
            </button>
          </div>
        )}

        {/* Connectivity test result — green banner when reachable, red when not */}
        {!isEditing && testResult && (
          <div
            className={testResult.reachable ? 'dl-banner dl-banner-ok' : 'dl-banner dl-banner-err'}
            style={{ marginTop: 12 }}
            role="status"
          >
            {testResult.reachable
              ? `Reachable${testResult.latency_ms != null ? ` — ${testResult.latency_ms}ms` : ''}`
              : `Unreachable — ${testResult.error ?? 'connection timeout'}`}
          </div>
        )}
      </div>
    </section>
  );
}
